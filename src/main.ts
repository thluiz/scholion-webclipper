// main.ts — composition root: build every dependency once, serve, run the
// background timers, drain on shutdown. No request logic lives here (see
// http/app.ts).

import pkg from "../package.json" with { type: "json" };

import { AclReloader } from "./auth/acl-reloader";
import { WriteBudget } from "./auth/budget";
import { loadConfig } from "./config";
import { createFetchHandler } from "./http/app";
import { Logger } from "./lib/logger";
import { Vault } from "./vault/vault";
import { OperationStore } from "./webclip/operations";

const SERVICE = pkg.name;
const VERSION = pkg.version;

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
const acl = await AclReloader.open(config.aclPath, `[${SERVICE}]`);

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: createFetchHandler({
    service: SERVICE,
    version: VERSION,
    context: { config, vault, operations },
    acl,
    budget,
    logger,
  }),
});

// ── boot and timers ──────────────────────────────────────────────────────────

await acl.warnUnknown();
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
    `${acl.loaded.principals().length} principals, vault ${config.vaultDir}`,
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
