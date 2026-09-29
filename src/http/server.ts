// server.ts — HTTP, identity, and the background timers.
//
// Identity comes from X-Api-Key and nowhere else — see scholion-places'
// server.ts, whose deployment note this repeats: in production the header
// is stamped by a reverse proxy, one location per principal, so the client
// never holds a credential it could swap to escalate itself (README
// "Deployment").

import { stat } from "node:fs/promises";

import { Acl, assertOperation, unknownOperations, type Principal } from "../auth/acl";
import { WriteBudget } from "../auth/budget";
import { loadConfig } from "../config";
import { ValidationError, describe } from "../errors";
import { errorBody, toApiError } from "./errors";
import { Logger, type AuditOutcome } from "../lib/logger";
import { OperationStore } from "../webclip/operations";
import { matchRoute, type ApiContext, type ApiResult } from "./routes";
import { Vault } from "../vault/vault";

const SERVICE = "scholion-webclipper";
const VERSION = "0.1.0";

const config = loadConfig();

const vault = new Vault({
  root: config.vaultDir,
  authorName: config.gitAuthorName,
  authorEmail: config.gitAuthorEmail,
  autoPush: config.autoPush,
  pushDelayMs: config.pushDelayMs,
});

const operations = new OperationStore(config.operationsDir, config.operationTtlHours);
const logger = new Logger(config.logDir, config.logRetentionDays);
const budget = new WriteBudget(config.maxComposesPerMin, config.maxComposesPerDay);
const context: ApiContext = { config, vault, operations };

// ── the ACL, re-read when it moves (same pattern as scholion-places) ────────

let acl = await Acl.load(config.aclPath);
let aclMtimeMs = (await stat(config.aclPath)).mtimeMs;
let aclCheckedAt = 0;

async function warnUnknown(path: string): Promise<void> {
  const file = JSON.parse(await Bun.file(path).text());
  const unknown = unknownOperations(file);
  if (unknown.length) {
    console.warn(`[acl] these names match no operation and control nothing: ${unknown.join(", ")}`);
  }
}

async function currentAcl(): Promise<Acl> {
  const now = Date.now();
  if (now - aclCheckedAt < 5_000) return acl;
  aclCheckedAt = now;

  try {
    const { mtimeMs } = await stat(config.aclPath);
    if (mtimeMs !== aclMtimeMs) {
      acl = await Acl.load(config.aclPath);
      aclMtimeMs = mtimeMs;
      await warnUnknown(config.aclPath);
      console.log(`[${SERVICE}] acl reloaded — ${acl.principals().length} principals`);
    }
  } catch (error) {
    console.error(`[${SERVICE}] keeping previous ACL: ${describe(error)}`);
  }
  return acl;
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

const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(request) {
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/health") {
      const sync = vault.state;
      return json({
        ok: !sync.strandedStash,
        service: SERVICE,
        version: VERSION,
        pendingOperations: operations.count(),
        sync,
      });
    }

    let principal: Principal | null = null;
    let operation = "unknown";
    let audit: ApiResult["audit"] = {};

    try {
      principal = (await currentAcl()).authenticate(request.headers.get("x-api-key"));

      if (request.method === "GET" && path === "/me") {
        operation = "me";
        return json({
          principal: principal.name,
          role: principal.role,
          operations: [...principal.operations].sort(),
          budget: budget.remaining(principal.name),
        });
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
      if (status === 500) console.error(`[${SERVICE}] ${request.method} ${path}: ${body.message}`);

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
  },
});

// ── boot and timers ──────────────────────────────────────────────────────────

await warnUnknown(config.aclPath);
await logger.prune();
await operations.load();

for (const stash of await vault.checkForStrandedWork()) {
  console.error(
    `[${SERVICE}] there is work stashed in the vault — somebody's edit is waiting: ${stash}\n` +
      `           recover it with: git -C ${config.vaultDir} stash pop`,
  );
}
console.log(
  `[${SERVICE}] listening on http://${config.host}:${server.port} — ${operations.count()} pending operations, ` +
    `${acl.principals().length} principals, vault ${config.vaultDir}`,
);

const sweepTimer = setInterval(() => {
  void operations.sweep();
  void logger.prune();
}, 3_600_000);

async function shutdown(signal: string): Promise<void> {
  console.log(`[${SERVICE}] ${signal} — draining`);
  clearInterval(sweepTimer);
  server.stop();
  await vault.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
