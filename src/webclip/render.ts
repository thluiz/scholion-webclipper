// render.ts — deterministic Markdown/YAML assembly.
//
// Called exactly once, inside compose (see compose.ts), never again at save
// time. The string this produces is what ghost-audit checks AND what save
// eventually writes — those must be the same bytes, which is the whole
// point of Decision 8 (no edits between audit and write). Re-rendering at
// save time, even from the same fields, would risk drift (a clock read
// twice, a library version change) that the one-render-then-freeze
// discipline avoids entirely.

import type { ClippingDraft, NoteDraft, RelatedNote } from "./model";
import { domainOf, inferSourceKind, monthOf } from "./model";

function doubleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function clippingFilename(domain: string, slug: string): string {
  return `${domain}--${slug}.md`;
}

export function clippingPath(section: string, capturedAt: string, domain: string, slug: string): string {
  return `${section}/${monthOf(capturedAt)}/${clippingFilename(domain, slug)}`;
}

export function notePath(section: string, slug: string): string {
  return `${section}/${slug}.md`;
}

export function archivedClippingUrl(capturedAt: string, domain: string, slug: string): string {
  return (
    `https://github.com/thluiz/scholion/blob/main/clippings/${monthOf(capturedAt)}/` +
    clippingFilename(domain, slug)
  );
}

export function renderClipping(clipping: ClippingDraft): string {
  return [
    "---",
    `url: ${doubleQuote(clipping.url)}`,
    `captured_at: ${doubleQuote(clipping.capturedAt)}`,
    `title: ${doubleQuote(clipping.title)}`,
    `domain: ${doubleQuote(clipping.domain)}`,
    "---",
    "",
    clipping.markdown.trim(),
    "",
  ].join("\n");
}

// The related notes the author approved in the search-first step. The model
// only gets them as optional context (webclip-summary links "ONLY when a
// point already being made genuinely connects"), so in practice it almost
// never links. This block makes the author's choice deterministic: every
// approved note not already linked in the body gets a line here, as a full
// markdown link (feedback_links_internos_clicaveis), in the note's language.
export function renderRelatedNotes(note: NoteDraft, relatedNotes: RelatedNote[]): string {
  const pending = relatedNotes.filter(
    (n) => !note.body.includes(`/notes/${n.slug}`) && !note.body.includes(`[[${n.slug}`),
  );
  if (pending.length === 0) return "";
  const heading = note.language.toLowerCase().startsWith("pt") ? "## Notas relacionadas" : "## Related notes";
  const lines = pending.map((n) => `- [${n.title.replace(/([[\]])/g, "\\$1")}](/notes/${n.slug}/)`);
  return `${heading}\n\n${lines.join("\n")}`;
}

export function renderNote(note: NoteDraft, clipping: ClippingDraft, relatedNotes: RelatedNote[] = []): string {
  const kind = inferSourceKind(clipping.domain);
  const archived = archivedClippingUrl(clipping.capturedAt, clipping.domain, note.slug);

  const frontmatter = [
    "---",
    `title: ${doubleQuote(note.title)}`,
    `date: ${singleQuote(clipping.capturedAt)}`,
    "category: webclip",
    `summary: ${singleQuote(note.summary)}`,
    `tags: [${note.tags.map(doubleQuote).join(", ")}]`,
    "has_commentary: false",
    ...(note.generatedBy ? [`generated_by: ${doubleQuote(note.generatedBy)}`] : []),
    "sources:",
    `  - title: ${doubleQuote(clipping.title)}`,
    `    url: ${doubleQuote(clipping.url)}`,
    `    kind: ${kind}`,
    `  - title: ${doubleQuote("Raw clipping (archived copy)")}`,
    `    url: ${doubleQuote(archived)}`,
    "    kind: repo",
    "---",
  ].join("\n");

  const related = renderRelatedNotes(note, relatedNotes);
  return `${frontmatter}\n\n${note.body.trim()}\n${related ? `\n${related}\n` : ""}`;
}

export interface RenderedOperation {
  clippingContent: string;
  clippingRelPath: string;
  noteContent: string;
  noteRelPath: string;
}

export function renderOperation(
  clipping: ClippingDraft,
  note: NoteDraft,
  sections: { notes: string; clippings: string },
  relatedNotes: RelatedNote[] = [],
): RenderedOperation {
  return {
    clippingContent: renderClipping(clipping),
    clippingRelPath: clippingPath(sections.clippings, clipping.capturedAt, clipping.domain, note.slug),
    noteContent: renderNote(note, clipping, relatedNotes),
    noteRelPath: notePath(sections.notes, note.slug),
  };
}

export type { RelatedNote };
export { domainOf };
