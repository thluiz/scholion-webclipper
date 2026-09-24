// compose.ts — calls the two existing vox-intelligence presets.
//
// Reuses `/presets/scholion/webclip-summary` and `/presets/scholion/ghost-audit`
// rather than reimplementing either (README Decision 6). This module's only
// job is: call webclip-summary, render the note deterministically once
// (render.ts), audit that exact rendered text, and hand back everything
// needed to build an Operation record.

import type { AuditResult, ClippingDraft, NoteDraft, RelatedNote } from "./model";
import { SummaryFailedError } from "./errors";
import { renderOperation, type RenderedOperation } from "./render";

interface WebclipSummaryResponse {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  language: string;
  body: string;
  model?: string;
  error?: { message: string };
}

interface GhostAuditResponse {
  "x-parsed"?: AuditResult;
  error?: { message: string };
}

export interface VoxOptions {
  url: string;
  // Budget handed to vox-intelligence as `timeoutMs`, so the upstream model
  // call gives up with us instead of running on orphaned. Our own HTTP abort
  // sits a little above it, leaving room for vox-intelligence to answer with
  // its error first.
  timeoutMs: number;
  summaryModel?: string;
  summaryFallbackModels?: string[];
}

const ABORT_MARGIN_MS = 10_000;

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
    if (!res.ok) {
      throw new Error(json?.error?.message || `HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function callWebclipSummary(
  vox: VoxOptions,
  args: { text: string; title: string; url: string; domain: string; relatedNotes: RelatedNote[] },
): Promise<NoteDraft> {
  let res: WebclipSummaryResponse;
  try {
    res = await postJson<WebclipSummaryResponse>(
      `${vox.url}/presets/scholion/webclip-summary`,
      {
        text: args.text,
        title: args.title,
        url: args.url,
        domain: args.domain,
        relatedNotes: args.relatedNotes.length ? args.relatedNotes : undefined,
        model: vox.summaryModel,
        fallbackModels: vox.summaryFallbackModels,
        timeoutMs: vox.timeoutMs,
      },
      vox.timeoutMs + ABORT_MARGIN_MS,
    );
  } catch (error) {
    throw new SummaryFailedError(error instanceof Error ? error.message : String(error));
  }

  return {
    slug: res.slug,
    title: res.title,
    summary: res.summary,
    tags: res.tags,
    language: res.language,
    body: res.body,
    generatedBy: res.model,
  };
}

async function callGhostAudit(vox: VoxOptions, content: string, slug: string): Promise<AuditResult> {
  try {
    const res = await postJson<GhostAuditResponse>(
      `${vox.url}/presets/scholion/ghost-audit`,
      { content, slug, timeoutMs: vox.timeoutMs },
      vox.timeoutMs + ABORT_MARGIN_MS,
    );
    if (!res["x-parsed"]) throw new Error("ghost-audit returned no parsed verdict");
    return res["x-parsed"];
  } catch (error) {
    // Fail-open, same principle as the existing PreToolUse hook
    // (ghost-audit-gate.ps1): an unreachable audit service must never brick
    // the pipeline. Unlike the hook, this is visible in the response
    // (verdict "yellow" + a summary saying why) rather than silent, because
    // there is no human reading a chat turn here to notice a missing check.
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: "yellow",
      findings: [],
      summary: `ghost-audit unavailable, proceeding unaudited (fail-open): ${message}`,
    };
  }
}

export interface ComposeResult {
  clipping: ClippingDraft;
  note: NoteDraft;
  audit: AuditResult;
  rendered: RenderedOperation;
}

export async function compose(
  vox: VoxOptions,
  clipping: ClippingDraft,
  relatedNotes: RelatedNote[],
  sections: { notes: string; clippings: string },
): Promise<ComposeResult> {
  const note = await callWebclipSummary(vox, {
    text: clipping.markdown,
    title: clipping.title,
    url: clipping.url,
    domain: clipping.domain,
    relatedNotes,
  });

  const rendered = renderOperation(clipping, note, sections);
  const audit = await callGhostAudit(vox, rendered.noteContent, note.slug);

  return { clipping, note, audit, rendered };
}
