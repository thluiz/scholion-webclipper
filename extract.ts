// extract.ts — render a page and turn it into clean Markdown.
//
// Node/Bun + Playwright (official bindings, same engine `fetch-webclip.mjs`
// already used) + @mozilla/readability (the reference implementation the
// Python/C# ports both copy) + jsdom (to parse the HTML Playwright already
// rendered — jsdom's own inability to run JS doesn't matter here, Playwright
// already did that) + turndown for Markdown. See README Decision 1 for why
// this combination was chosen over Python/C#/Elixir alternatives.
//
// The internal render timeout (config.fetchTimeoutMs) is deliberately
// shorter than any reasonable HTTP client timeout, so a slow page always
// comes back as a clean `fetch_timeout` response instead of the connection
// hanging — see README Decision 7 and the incident it responds to.

import { chromium, type Browser } from "playwright";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

import {
  BlockedDomainError,
  ConsentWallUnresolvedError,
  FetchFailedError,
  FetchTimeoutError,
  ThinContentError,
} from "./errors";
import { domainOf } from "./model";

// Domains known to block or actively fight headless scraping. Checked before
// ever launching a browser — no point paying for a render that will only
// come back as a challenge page or a login wall.
const BLOCKED_DOMAINS = [
  /(^|\.)x\.com$/,
  /(^|\.)twitter\.com$/,
  /(^|\.)reddit\.com$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)facebook\.com$/,
  /(^|\.)linkedin\.com$/,
];

const CONSENT_BUTTON_PATTERN = /^(I Accept|Accept All|Accept Cookies|Agree|Accept)$/i;

// Post-render heuristic for a challenge page that slipped past the domain
// blocklist (a CDN in front of an otherwise-fine domain, a new offender not
// in the list yet).
const CHALLENGE_TITLE_PATTERN = /^(Just a moment|Attention Required|Access denied|Are you a robot)/i;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export interface ExtractResult {
  title: string;
  markdown: string;
}

export interface ExtractOptions {
  timeoutMs: number;
  minContentChars: number;
}

function assertNotBlocked(url: string): void {
  const host = new URL(url).hostname;
  if (BLOCKED_DOMAINS.some((pattern) => pattern.test(host))) {
    throw new BlockedDomainError(host);
  }
}

// Hard cap on the whole render, on top of page.goto's own timeout. goto is
// only one of several awaits here (launch, title, content, close) and a
// wedged Chromium can stall any of them with no timeout of its own: seen in
// the 2026-09-24 backlog batches as requests that never answered at all
// (client gave up at 300s, nothing in the request log), while the same URLs
// rendered in ~1s when retried in isolation. Past the cap the request fails
// as a normal fetch_timeout and the browser is closed in the background.
const HARD_CAP_FACTOR = 2;

export async function fetchAndExtract(url: string, options: ExtractOptions): Promise<ExtractResult> {
  assertNotBlocked(url);

  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capMs = options.timeoutMs * HARD_CAP_FACTOR;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchTimeoutError(url, capMs)), capMs);
  });

  try {
    return await Promise.race([
      renderAndExtract(url, options, (b) => {
        browser = b;
      }),
      cap,
    ]);
  } catch (error) {
    if (error instanceof FetchTimeoutError && browser) {
      browser.close().catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function renderAndExtract(
  url: string,
  options: ExtractOptions,
  onLaunched: (browser: Browser) => void,
): Promise<ExtractResult> {
  // Step timings go to stdout (journald) so a render that hits the hard cap
  // shows which await it was stuck in.
  const t0 = Date.now();
  let step = "launch";
  const mark = (next: string) => {
    step = next;
  };
  const stuck = setTimeout(
    () => console.log(`[extract] still in "${step}" after ${options.timeoutMs}ms: ${url}`),
    options.timeoutMs + 1000,
  );
  const browser = await chromium.launch({ timeout: options.timeoutMs });
  onLaunched(browser);
  let consentWallSeen = false;

  try {
    mark("newPage");
    const page = await browser.newPage();
    mark("goto");

    try {
      // "load", not "networkidle": ad- and tracker-heavy sites (jacobin.com.br,
      // papodehomem.com.br) never go network-idle, so every render timed out
      // even though the article was on screen within a few seconds.
      await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs });
    } catch (error) {
      const message = describeError(error);
      if (/timeout/i.test(message)) throw new FetchTimeoutError(url, options.timeoutMs);
      throw new FetchFailedError(url, message);
    }
    // Short grace period for client-rendered pages; never fatal.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

    try {
      const btn = page.getByRole("button", { name: CONSENT_BUTTON_PATTERN }).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        consentWallSeen = true;
        await btn.click({ timeout: 3000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
        consentWallSeen = false; // dismissed successfully
      }
    } catch {
      // Either no consent wall, or the click failed — consentWallSeen already
      // reflects which one.
    }

    mark("title");
    const pageTitle = await page.title();
    if (CHALLENGE_TITLE_PATTERN.test(pageTitle)) {
      throw new BlockedDomainError(new URL(url).hostname);
    }

    mark("content");
    const html = await page.content();
    mark("extract");
    const { title, markdown } = extractFromHtml(html, url, pageTitle);

    const chars = markdown.trim().length;
    if (chars < options.minContentChars) {
      if (consentWallSeen) throw new ConsentWallUnresolvedError(url);
      throw new ThinContentError(chars, options.minContentChars);
    }

    return { title, markdown };
  } finally {
    mark("close");
    await browser.close();
    clearTimeout(stuck);
    const ms = Date.now() - t0;
    if (ms > options.timeoutMs) console.log(`[extract] slow render ${ms}ms: ${url}`);
  }
}

function extractFromHtml(html: string, url: string, fallbackTitle: string): ExtractResult {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article?.content) {
    return {
      title: article.title || fallbackTitle,
      markdown: turndown.turndown(article.content),
    };
  }

  // Readability found nothing article-shaped (dashboards, landing pages —
  // see README Decision 1's tradeoff table). Fall back to the naive
  // article||main||body heuristic the original fetch-webclip.mjs used.
  const doc = dom.window.document;
  const fallbackEl = doc.querySelector("article") || doc.querySelector("main") || doc.body;
  return {
    title: fallbackTitle,
    markdown: turndown.turndown(fallbackEl?.innerHTML ?? ""),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { domainOf };
