// routes.ts — the API surface: compose, get, save, discard.
//
// Mirrors scholion-places' routing shape (Route table + matchRoute), but
// the interesting logic here is authorization, not resource CRUD — see
// README Decisions 2/3/8/9 before changing how `save` behaves.

import type { Config } from "../config";
import { compose } from "../webclip/compose";
import { fetchAndExtract } from "../webclip/extract";
import { AuditRedError, MethodNotAllowedError, SlugConflictError, ValidationError } from "../errors";
import { domainOf, parseComposeRequest, requiredString, type ClippingDraft } from "../webclip/model";
import { OperationStore, type PendingOperation } from "../webclip/operations";
import { localTimestamp } from "../lib/time";
import { assertOperation, type Operation, type Principal } from "../auth/acl";
import { SlugExistsError, Vault } from "../vault/vault";
import { asDraft } from "../webclip/render";

export interface ApiContext {
  config: Config;
  vault: Vault;
  operations: OperationStore;
}

export interface ApiRequest {
  principal: Principal;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ApiResult {
  status?: number;
  body?: unknown;
  audit?: { operationId?: string; slug?: string };
}

export interface Route {
  method: string;
  pattern: RegExp;
  operation: Operation | null;
  handle(ctx: ApiContext, request: ApiRequest): Promise<ApiResult>;
}

function operationView(op: PendingOperation) {
  return {
    operationId: op.id,
    clipping: {
      title: op.clipping.title,
      url: op.clipping.url,
      domain: op.clipping.domain,
      capturedAt: op.clipping.capturedAt,
      markdown: op.clipping.markdown,
    },
    note: {
      slug: op.note.slug,
      title: op.note.title,
      summary: op.note.summary,
      tags: op.note.tags,
      language: op.note.language,
      body: op.note.body,
    },
    audit: op.audit,
    expiresAt: op.expiresAt,
  };
}

async function handleCompose(ctx: ApiContext, request: ApiRequest): Promise<ApiResult> {
  const req = parseComposeRequest(request.body);

  let clipping: ClippingDraft;
  if (req.text) {
    // Fetch already done by the caller (or re-processing an existing clipping) — skip extraction.
    clipping = {
      url: requiredString(req.url, "url", 2000),
      title: requiredString(req.title, "title", 500),
      domain: requiredString(req.domain, "domain", 200),
      capturedAt: req.capturedAt ?? localTimestamp(),
      markdown: req.text,
    };
  } else {
    const url = requiredString(req.url, "url", 2000);
    const extracted = await fetchAndExtract(url, {
      timeoutMs: ctx.config.fetchTimeoutMs,
      minContentChars: ctx.config.minContentChars,
    });
    clipping = {
      url,
      title: extracted.title,
      domain: domainOf(url),
      capturedAt: req.capturedAt ?? localTimestamp(),
      markdown: extracted.markdown,
    };
  }

  const vox = {
    url: ctx.config.voxIntelligenceUrl,
    timeoutMs: ctx.config.voxTimeoutMs,
    summaryModel: ctx.config.summaryModel,
    summaryFallbackModels: ctx.config.summaryFallbackModels,
  };
  const result = await compose(
    vox,
    clipping,
    req.relatedNotes ?? [],
    { notes: ctx.config.vaultNotesSection, clippings: ctx.config.vaultClippingsSection },
    { slug: req.slug },
  );

  const op = await ctx.operations.create(request.principal.name, result);

  return {
    status: 201,
    body: operationView(op),
    audit: { operationId: op.id, slug: op.note.slug },
  };
}

async function handleGet(ctx: ApiContext, request: ApiRequest): Promise<ApiResult> {
  const op = ctx.operations.require(request.params.id);
  return { body: operationView(op), audit: { operationId: op.id, slug: op.note.slug } };
}

async function handleDiscard(ctx: ApiContext, request: ApiRequest): Promise<ApiResult> {
  const existed = await ctx.operations.discard(request.params.id);
  return { status: existed ? 204 : 404, audit: { operationId: request.params.id } };
}

function parseSaveMode(body: Record<string, unknown>): "commit" | "return" {
  const mode = body.mode ?? "commit";
  if (mode !== "commit" && mode !== "return") {
    throw new ValidationError('mode must be "commit" or "return"');
  }
  return mode;
}

async function handleSave(ctx: ApiContext, request: ApiRequest): Promise<ApiResult> {
  const op = ctx.operations.requireUnconsumed(request.params.id);
  const mode = parseSaveMode(request.body);
  const force = request.body.force === true;
  // A red note may always be kept as an unpublished draft (`draft: true`);
  // publishing it still takes webclip.save.force. A draft save does not
  // consume the operation, so the author can still force it while it lives.
  const draft = request.body.draft === true && !force;

  if (op.audit.verdict === "red" && !draft) {
    if (!force) throw new AuditRedError(op.audit.findings);
    assertOperation(request.principal, "webclip.save.force");
  }

  const rendered = draft ? { ...op.rendered, noteContent: asDraft(op.rendered.noteContent) } : op.rendered;
  const sourceUrl = op.clipping.url;

  if (mode === "return") {
    if (!(await ctx.vault.canWriteNote(rendered.noteRelPath, sourceUrl))) {
      throw new SlugConflictError(op.note.slug);
    }
    if (!draft) await ctx.operations.markConsumed(op.id);
    return {
      status: 200,
      body: {
        slug: op.note.slug,
        notePath: rendered.noteRelPath,
        clippingPath: rendered.clippingRelPath,
        clippingContent: rendered.clippingContent,
        noteContent: rendered.noteContent,
        draft,
        commit: null,
      },
      audit: { operationId: op.id, slug: op.note.slug },
    };
  }

  try {
    const message = draft
      ? `webclip (rascunho, ghost-audit red): ${op.note.title}`
      : `webclip: ${op.note.title}`;
    const commit = await ctx.vault.save(rendered, message, sourceUrl);
    if (!draft) await ctx.operations.markConsumed(op.id);
    return {
      status: 200,
      body: {
        slug: op.note.slug,
        notePath: rendered.noteRelPath,
        clippingPath: rendered.clippingRelPath,
        draft,
        commit,
      },
      audit: { operationId: op.id, slug: op.note.slug },
    };
  } catch (error) {
    if (error instanceof SlugExistsError) throw new SlugConflictError(op.note.slug);
    throw error;
  }
}

export const ROUTES: Route[] = [
  { method: "POST", pattern: /^\/webclip\/compose$/, operation: "webclip.compose", handle: handleCompose },
  {
    method: "GET",
    pattern: /^\/webclip\/(?<id>[^/]+)$/,
    operation: "webclip.get",
    handle: handleGet,
  },
  {
    method: "POST",
    pattern: /^\/webclip\/(?<id>[^/]+)\/save$/,
    operation: "webclip.save",
    handle: handleSave,
  },
  {
    method: "DELETE",
    pattern: /^\/webclip\/(?<id>[^/]+)$/,
    operation: "webclip.discard",
    handle: handleDiscard,
  },
];

export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  let pathMatched = false;

  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    return { route, params: (match.groups ?? {}) as Record<string, string> };
  }

  if (pathMatched) throw new MethodNotAllowedError(`${method} is not allowed on ${path}`);
  return null;
}
