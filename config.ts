// config.ts — everything the service needs from its environment, read once.
//
// A missing setting is a boot failure, never a surprise at three in the
// morning. VAULT_DIR has no default because guessing where the Scholion
// clone lives is not a favour.

export interface Config {
  port: number;
  host: string;

  vaultDir: string;
  vaultNotesSection: string;
  vaultClippingsSection: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  autoPush: boolean;
  pushDelayMs: number;

  aclPath: string;
  logDir: string;
  logRetentionDays: number;
  maxComposesPerMin: number;
  maxComposesPerDay: number;

  voxIntelligenceUrl: string;

  operationTtlHours: number;
  operationsDir: string;

  fetchTimeoutMs: number;
  minContentChars: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid ${name}: expected a boolean, got ${JSON.stringify(raw)}`);
}

export function loadConfig(): Config {
  const vaultDir = process.env.VAULT_DIR ?? "";
  if (!vaultDir) {
    throw new Error(
      "VAULT_DIR is not set. Copy .env.example to .env and point it at the clone of the Scholion repository.",
    );
  }

  return {
    port: num("PORT", 8020),
    host: process.env.HOST || "127.0.0.1",

    vaultDir,
    vaultNotesSection: process.env.VAULT_NOTES_SECTION || "content/notes",
    vaultClippingsSection: process.env.VAULT_CLIPPINGS_SECTION || "clippings",
    gitAuthorName: process.env.GIT_AUTHOR_NAME || "scholion-webclipper",
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || "scholion-webclipper@localhost",
    autoPush: bool("AUTO_PUSH", true),
    pushDelayMs: num("PUSH_DELAY_MS", 2_000),

    aclPath: process.env.ACL_PATH || "./acl.json",
    logDir: process.env.LOG_DIR || "./logs",
    logRetentionDays: num("LOG_RETENTION_DAYS", 30),
    maxComposesPerMin: num("MAX_COMPOSES_PER_MIN", 10),
    maxComposesPerDay: num("MAX_COMPOSES_PER_DAY", 200),

    voxIntelligenceUrl: (process.env.VOX_INTELLIGENCE_URL || "http://localhost:8080/api/vox-intelligence").replace(
      /\/+$/,
      "",
    ),

    operationTtlHours: num("OPERATION_TTL_HOURS", 24),
    operationsDir: process.env.OPERATIONS_DIR || "./operations",

    fetchTimeoutMs: num("FETCH_TIMEOUT_MS", 30_000),
    minContentChars: num("MIN_CONTENT_CHARS", 400),
  };
}
