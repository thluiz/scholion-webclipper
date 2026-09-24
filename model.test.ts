// model.test.ts
//
// The assertions that matter are the ones a caller depends on without
// re-reading the source: slug/domain determinism, and that the request
// parser actually refuses the shapes README Decision 8 says are refused
// (no edits at save, url-or-text required).

import { describe, expect, test } from "bun:test";

import { ValidationError } from "./errors";
import { domainOf, inferSourceKind, monthOf, parseComposeRequest, parseRelatedNotes, slugify } from "./model";

describe("slugify", () => {
  test("lowercases, strips accents, kebab-cases", () => {
    expect(slugify("Apple May Integrate Service Workers Into WebKit")).toBe(
      "apple-may-integrate-service-workers-into-webkit",
    );
    expect(slugify("Não gosto de LLMs")).toBe("nao-gosto-de-llms");
  });

  test("cuts on a separator, never mid-word, within maxLength", () => {
    const long = "a-very-long-title-that-goes-well-beyond-the-fifty-character-limit-for-slugs";
    const slug = slugify(long, 50);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("domainOf", () => {
  test("strips www. and turns dots into hyphens", () => {
    expect(domainOf("https://www.martinfowler.com/articles/x.html")).toBe("martinfowler-com");
    expect(domainOf("https://playwright.dev/")).toBe("playwright-dev");
  });
});

describe("monthOf", () => {
  test("takes YYYY-MM off an ISO timestamp", () => {
    expect(monthOf("2026-09-24T10:00:00-03:00")).toBe("2026-09");
  });
});

describe("inferSourceKind", () => {
  test("recognises common domains", () => {
    expect(inferSourceKind("youtube-com")).toBe("video");
    expect(inferSourceKind("github-com")).toBe("repo");
    expect(inferSourceKind("arxiv-org")).toBe("paper");
    expect(inferSourceKind("en-wikipedia-org")).toBe("wiki");
  });

  test("falls back to article", () => {
    expect(inferSourceKind("martinfowler-com")).toBe("article");
  });
});

describe("parseComposeRequest", () => {
  test("accepts url alone (fetch mode)", () => {
    const req = parseComposeRequest({ url: "https://example.com/x" });
    expect(req.url).toBe("https://example.com/x");
    expect(req.text).toBeUndefined();
  });

  test("accepts text+title+url+domain (skip-fetch mode)", () => {
    const req = parseComposeRequest({
      text: "some content",
      title: "A title",
      url: "https://example.com/x",
      domain: "example-com",
    });
    expect(req.text).toBe("some content");
  });

  test("refuses when neither url nor text is given", () => {
    expect(() => parseComposeRequest({})).toThrow(ValidationError);
  });

  test("refuses text without title/url/domain", () => {
    expect(() => parseComposeRequest({ text: "some content" })).toThrow(ValidationError);
  });

  test("passes through an explicit capturedAt override", () => {
    const req = parseComposeRequest({ url: "https://example.com/x", capturedAt: "2026-01-05T10:00:00-03:00" });
    expect(req.capturedAt).toBe("2026-01-05T10:00:00-03:00");
  });

  test("capturedAt is undefined when not given (caller defaults to now)", () => {
    const req = parseComposeRequest({ url: "https://example.com/x" });
    expect(req.capturedAt).toBeUndefined();
  });

  test("refuses a capturedAt that isn't ISO-with-offset", () => {
    expect(() => parseComposeRequest({ url: "https://example.com/x", capturedAt: "2026-01-09T13:09:52 (UTC -03:00)" })).toThrow(
      ValidationError,
    );
    expect(() => parseComposeRequest({ url: "https://example.com/x", capturedAt: "2026-01-09T13:09:52Z" })).toThrow(
      ValidationError,
    );
    expect(() => parseComposeRequest({ url: "https://example.com/x", capturedAt: "not a date" })).toThrow(ValidationError);
  });

  test("parses relatedNotes", () => {
    const req = parseComposeRequest({
      url: "https://example.com/x",
      relatedNotes: [{ slug: "a-note", title: "A Note", hint: "same topic" }],
    });
    expect(req.relatedNotes).toEqual([{ slug: "a-note", title: "A Note", hint: "same topic" }]);
  });
});

describe("parseRelatedNotes", () => {
  test("empty/undefined is an empty array, not an error", () => {
    expect(parseRelatedNotes(undefined)).toEqual([]);
    expect(parseRelatedNotes(null)).toEqual([]);
  });

  test("refuses a non-array", () => {
    expect(() => parseRelatedNotes("nope")).toThrow(ValidationError);
  });

  test("refuses an item missing slug or title", () => {
    expect(() => parseRelatedNotes([{ slug: "x" }])).toThrow(ValidationError);
  });
});
