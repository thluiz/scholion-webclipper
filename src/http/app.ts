// app.ts — the request pipeline: identity → route → handler → audit log.
//
// Identity comes from X-Api-Key and nowhere else — see scholion-places'
// server.ts, whose deployment note this repeats: in production the header
// is stamped by a reverse proxy, one location per principal, so the client
// never holds a credential it could swap to escalate itself (README
// "Deployment").
//
// Wiring, boot and timers live in main.ts; this module only turns a
// Request into a Response.

import type { AclReloader } from "../auth/acl-reloader";
import { assertOperation, type Principal } from "../auth/acl";
import type { WriteBudget } from "../auth/budget";
import { ValidationError } from "../errors";
import type { AuditOutcome, Logger } from "../lib/logger";
import { errorBody, toApiError } from "./errors";
import { matchRoute, type ApiContext, type ApiResult } from "./routes";

export interface AppDeps {
  service: string;
  version: string;
  context: ApiContext;
  acl: AclReloader;
  budget: WriteBudget;
  logger: Logger;
}

function outcomeFor(status: number): AuditOutcome {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "denied";
  return status >= 400 ? "error" : "ok";
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};

  const text = await request.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("the request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError("the request body is not valid JSON");
  }
}

function toResponse(result: ApiResult): Response {
  const status = result.status ?? 200;
  if (status === 204 || result.body === undefined) return new Response(null, { status });
  return json(result.body, status);
}

export function createFetchHandler(deps: AppDeps): (request: Request) => Promise<Response> {
  const { service, version, context, acl, budget, logger } = deps;
  const { vault, operations } = context;

  // Unauthenticated liveness probe — deliberately outside the route table,
  // which assumes an authenticated principal.
  function health(): Response {
    const sync = vault.state;
    return json({
      ok: !sync.strandedStash,
      service,
      version,
      pendingOperations: operations.count(),
      sync,
    });
  }

  // What the caller may do. Not audit-logged, as before the split.
  function me(principal: Principal): Response {
    return json({
      principal: principal.name,
      role: principal.role,
      operations: [...principal.operations].sort(),
      budget: budget.remaining(principal.name),
    });
  }

  return async function fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/health") return health();

    let principal: Principal | null = null;
    let operation = "unknown";
    let audit: ApiResult["audit"] = {};

    try {
      principal = (await acl.current()).authenticate(request.headers.get("x-api-key"));

      if (request.method === "GET" && path === "/me") {
        operation = "me";
        return me(principal);
      }

      const matched = matchRoute(request.method, path);
      if (!matched) return json({ error: { code: "not_found", message: "not found", retryable: false } }, 404);

      const { route, params } = matched;
      operation = route.operation ?? "unknown";
      if (route.operation) assertOperation(principal, route.operation);
      if (route.operation === "webclip.compose") budget.consume(principal.name);

      const result = await route.handle(context, {
        principal,
        params,
        body: await readJsonBody(request),
      });

      audit = result.audit ?? {};
      const response = toResponse(result);
      void logger.write({
        principal: principal.name,
        operation,
        outcome: outcomeFor(response.status),
        method: request.method,
        path,
        status: response.status,
        durationMs: Date.now() - started,
        ...audit,
      });
      return response;
    } catch (error) {
      const apiError = toApiError(error);
      const status = apiError.status;
      const body = errorBody(apiError);
      if (status === 500) console.error(`[${service}] ${request.method} ${path}: ${body.message}`);

      void logger.write({
        principal: principal?.name ?? null,
        operation,
        outcome: outcomeFor(status),
        method: request.method,
        path,
        status,
        code: body.code,
        message: body.message,
        durationMs: Date.now() - started,
        ...audit,
      });
      return json({ error: body }, status);
    }
  };
}
