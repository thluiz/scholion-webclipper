// render.test.ts
//
// What matters here is byte-for-byte determinism (Decision 8 depends on it:
// the audited text and the saved text must be identical) and that the YAML
// quoting survives the exact characters that have broken it before — a
// colon in summary (feedback_yaml_summary_aspas), a double quote in title.

import { describe, expect, test } from "bun:test";

import type { ClippingDraft, NoteDraft } from "./model";
import { archivedClippingUrl, clippingPath, notePath, renderClipping, renderNote, renderOperation } from "./render";

const clipping: ClippingDraft = {
  url: "https://martinfowler.com/articles/x.html",
  title: 'A "quoted" title',
  domain: "martinfowler-com",
  capturedAt: "2026-09-24T10:00:00-03:00",
  markdown: "Some extracted content.\n\nWith a second paragraph.",
};

const note: NoteDraft = {
  slug: "a-quoted-title",
  title: 'A "quoted" title',
  summary: "This: has a colon, and it must survive quoting.",
  tags: ["tag-one", "tag-two"],
  language: "en",
  body: "A resumo paragraph.\n\n## Fichamento\n\n- point one\n- point two",
};

describe("renderClipping", () => {
  test("is deterministic and quotes the title's embedded double quotes", () => {
    const out = renderClipping(clipping);
    expect(out).toContain('title: "A \\"quoted\\" title"');
    expect(out).toContain("url: \"https://martinfowler.com/articles/x.html\"");
    expect(out).toContain("Some extracted content.");
    expect(renderClipping(clipping)).toBe(out); // same input -> same output, every time
  });
});

describe("renderNote", () => {
  test("single-quotes summary so an embedded colon can't break YAML", () => {
    const out = renderNote(note, clipping);
    expect(out).toContain("summary: 'This: has a colon, and it must survive quoting.'");
  });

  test("includes category: webclip and has_commentary: false", () => {
    const out = renderNote(note, clipping);
    expect(out).toContain("category: webclip");
    expect(out).toContain("has_commentary: false");
  });

  test("sources has the original url and the archived-clipping link", () => {
    const out = renderNote(note, clipping);
    expect(out).toContain('url: "https://martinfowler.com/articles/x.html"');
    expect(out).toContain(archivedClippingUrl(clipping.capturedAt, clipping.domain, note.slug));
  });

  test("tags render as a double-quoted inline array", () => {
    const out = renderNote(note, clipping);
    expect(out).toContain('tags: ["tag-one", "tag-two"]');
  });

  test("body is appended verbatim after the frontmatter", () => {
    const out = renderNote(note, clipping);
    expect(out.endsWith(`${note.body}\n`)).toBe(true);
  });
});

describe("path helpers", () => {
  test("clippingPath uses the captured month, not today's", () => {
    expect(clippingPath("clippings", "2026-01-05T10:00:00-03:00", "example-com", "some-slug")).toBe(
      "clippings/2026-01/example-com--some-slug.md",
    );
  });

  test("notePath is section/slug.md", () => {
    expect(notePath("content/notes", "some-slug")).toBe("content/notes/some-slug.md");
  });

  test("archivedClippingUrl matches the fixed github blob convention", () => {
    expect(archivedClippingUrl("2026-01-05T10:00:00-03:00", "example-com", "some-slug")).toBe(
      "https://github.com/thluiz/scholion/blob/main/clippings/2026-01/example-com--some-slug.md",
    );
  });
});

describe("renderOperation", () => {
  test("bundles both rendered files and their relative paths", () => {
    const sections = { notes: "content/notes", clippings: "clippings" };
    const rendered = renderOperation(clipping, note, sections);
    expect(rendered.noteRelPath).toBe("content/notes/a-quoted-title.md");
    expect(rendered.clippingRelPath).toBe("clippings/2026-09/martinfowler-com--a-quoted-title.md");
    expect(rendered.noteContent).toBe(renderNote(note, clipping));
    expect(rendered.clippingContent).toBe(renderClipping(clipping));
  });
});
