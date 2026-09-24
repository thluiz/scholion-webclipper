// model.ts — the shapes that flow between extract, compose, the operation
// store, and the vault. Validation lives here so routes.ts stays thin.

import { ValidationError } from "./errors";

export interface RelatedNote {
  slug: string;
  title: string;
  hint?: string;
}

export interface ClippingDraft {
  url: string;
  title: string;
  domain: string;
  capturedAt: string; // ISO 8601 with offset, local time of the compose call
  markdown: string;
}

export interface NoteDraft {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  language: string;
  body: string; // "<resumo>\n\n## Fichamento\n\n- ..."
}

export type AuditVerdict = "green" | "yellow" | "red";

export interface AuditFinding {
  quote: string;
  rule: string;
  severity: "block" | "warn";
  suggestion: string;
  line: number | null;
}

export interface AuditResult {
  verdict: AuditVerdict;
  findings: AuditFinding[];
  summary: string;
}

export interface ComposeRequest {
  url?: string;
  text?: string;
  title?: string;
  domain?: string;
  relatedNotes?: RelatedNote[];
  // Overrides the default "now" capture timestamp — for reprocessing a
  // clipping that was already captured earlier (the interactive skill's
  // file mode) and must keep its original captured_at/<YYYY-MM> folder.
  capturedAt?: string;
}

export function slugify(input: string, maxLength = 60): string {
  const stripped = input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (stripped.length <= maxLength) return stripped;
  const cut = stripped.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/** Host with `www.` stripped and dots turned into hyphens, matching the interactive skill's convention. */
export function domainOf(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host.replace(/\./g, "-");
}

export function monthOf(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 7); // YYYY-MM
}

export function requiredString(value: unknown, field: string, maxLength = 4000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${field} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} is longer than the ${maxLength}-char limit`);
  }
  return trimmed;
}

export function optionalString(value: unknown, field: string, maxLength = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, maxLength);
}

export function parseRelatedNotes(value: unknown): RelatedNote[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError("relatedNotes must be an array");
  return value.map((item, i) => {
    if (!item || typeof item !== "object") throw new ValidationError(`relatedNotes[${i}] must be an object`);
    const obj = item as Record<string, unknown>;
    return {
      slug: requiredString(obj.slug, `relatedNotes[${i}].slug`, 200),
      title: requiredString(obj.title, `relatedNotes[${i}].title`, 300),
      hint: optionalString(obj.hint, `relatedNotes[${i}].hint`, 500),
    };
  });
}

// The exact shape localTimestamp() produces: no "Z" shorthand, no
// milliseconds, always an explicit +HH:MM/-HH:MM offset. capturedAt is
// caller-supplied (the interactive skill's file mode, the batch playbook's
// reformatted `created`), so it's the one date field worth validating
// server-side — a malformed value would otherwise land silently in a
// note's frontmatter `date:` and in the clipping's folder path.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export function parseComposeRequest(body: Record<string, unknown>): ComposeRequest {
  const url = optionalString(body.url, "url", 2000);
  const text = optionalString(body.text, "text", 1_000_000);

  if (!url && !text) {
    throw new ValidationError("provide either url (to fetch) or text+title+url+domain (to skip fetching)");
  }
  if (text && (!body.title || !body.url || !body.domain)) {
    throw new ValidationError("when text is provided, title, url and domain are all required too");
  }

  const capturedAt = optionalString(body.capturedAt, "capturedAt", 40);
  if (capturedAt && !ISO_WITH_OFFSET.test(capturedAt)) {
    throw new ValidationError(
      `capturedAt must look like 2026-01-09T13:09:52-03:00 (ISO 8601, explicit offset, no "Z", no milliseconds) — got ${JSON.stringify(capturedAt)}`,
    );
  }

  return {
    url: url ?? optionalString(body.url, "url", 2000),
    text,
    title: optionalString(body.title, "title", 500),
    domain: optionalString(body.domain, "domain", 200),
    relatedNotes: parseRelatedNotes(body.relatedNotes),
    capturedAt,
  };
}

/** Kind inferred from domain, same table `add-scholion-note`/the interactive webclip skill use. */
export function inferSourceKind(domain: string): string {
  if (/youtube|vimeo|youtu-be/.test(domain)) return "video";
  if (/arxiv|doi-org|ncbi-nlm-nih-gov/.test(domain)) return "paper";
  if (/wikipedia/.test(domain)) return "wiki";
  if (/github/.test(domain)) return "repo";
  return "article";
}
