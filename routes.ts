// routes.ts — the API surface: compose, get, save, discard.
//
// Mirrors scholion-places' routing shape (Route table + matchRoute), but
// the interesting logic here is authorization, not resource CRUD — see
// README Decisions 2/3/8/9 before changing how `save` behaves.

import type { Config } from "./config";
import { compose } from "./compose";
import { fetchAndExtract } from "./extract";
import { AuditRedError, MethodNotAllowedError, SlugConflictError, ValidationError } from "./errors";
import { domainOf, parseComposeRequest, requiredString, type ClippingDraft } from "./model";
import { OperationStore, type Operation } from "./operations";
import { localTimestamp } from "./time";
import { assertOperation, type Operation as AclOperation, type Principal } from "./acl";
import { SlugExistsError, Vault } from "./vault";

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
  operation: AclOperation | null;
  handle(ctx: ApiContext, request: ApiRequest): Promise<ApiResult>;
}

function operationView(op: Operation) {
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
  const result = await compose(vox, clipping, req.relatedNotes ?? [], {
    notes: ctx.config.vaultNotesSection,
    clippings: ctx.config.vaultClippingsSection,
  });

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

  if (op.audit.verdict === "red") {
    if (!force) throw new AuditRedError(op.audit.findings);
    assertOperation(request.principal, "webclip.save.force" as AclOperation);
  }

  if (mode === "return") {
    if (await ctx.vault.noteExists(op.rendered.noteRelPath)) {
      throw new SlugConflictError(op.note.slug);
    }
    await ctx.operations.markConsumed(op.id);
    return {
      status: 200,
      body: {
        slug: op.note.slug,
        notePath: op.rendered.noteRelPath,
        clippingPath: op.rendered.clippingRelPath,
        clippingContent: op.rendered.clippingContent,
        noteContent: op.rendered.noteContent,
        commit: null,
      },
      audit: { operationId: op.id, slug: op.note.slug },
    };
  }

  try {
    const commit = await ctx.vault.save(op.rendered, `webclip: ${op.note.title}`);
    await ctx.operations.markConsumed(op.id);
    return {
      status: 200,
      body: {
        slug: op.note.slug,
        notePath: op.rendered.noteRelPath,
        clippingPath: op.rendered.clippingRelPath,
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
  { method: "POST", pattern: /^\/webclip\/compose$/, operation: "webclip.compose" as AclOperation, handle: handleCompose },
  {
    method: "GET",
    pattern: /^\/webclip\/(?<id>[^/]+)$/,
    operation: "webclip.get" as AclOperation,
    handle: handleGet,
  },
  {
    method: "POST",
    pattern: /^\/webclip\/(?<id>[^/]+)\/save$/,
    operation: "webclip.save" as AclOperation,
    handle: handleSave,
  },
  {
    method: "DELETE",
    pattern: /^\/webclip\/(?<id>[^/]+)$/,
    operation: "webclip.discard" as AclOperation,
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
