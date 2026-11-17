// vault.ts — the Scholion clone this service writes into, and its own git
// queue. The commit/sync/push machinery (SerialQueue, the rebase/stash
// handling in syncUnqueued) is copied near-verbatim from scholion-places
// (E:\scholion-places\vault.ts) — it's fully generic, already hardened
// against the "two writers in one working tree" problem this service has
// too (README Decision 5). What's specific to this service is `save()`:
// two files, one commit, matching the resolved Decision 5/9/"What save
// writes" shape — never the record-then-render-separately pattern
// scholion-places uses for its own, different reasons.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RenderedOperation } from "../webclip/render";

export class SlugExistsError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "SlugExistsError";
  }
}

export interface SyncState {
  lastSyncAt?: number;
  lastError?: string;
  strandedStash?: string;
  strandedHint?: string;
}

export interface VaultOptions {
  root: string;
  authorName?: string;
  authorEmail?: string;
  autoPush?: boolean;
  pushDelayMs?: number;
  /** Kill a local git command (add, commit, status...) after this long. */
  gitTimeoutMs?: number;
  /** Kill a network git command (fetch, pull, push) after this long. */
  gitNetworkTimeoutMs?: number;
  /** Give up waiting on a whole queued task after this long. */
  taskTimeoutMs?: number;
}

export class QueueTaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`vault task did not finish within ${timeoutMs}ms; the queue moved on`);
    this.name = "QueueTaskTimeoutError";
  }
}

/**
 * A promise chain that runs one task at a time.
 *
 * Deliberately not a library: a failed task must not poison the ones behind
 * it, and a task that never settles must not block them forever. The second
 * rule came from 2026-11-16: a push scheduled at 20:11:22 never returned and
 * every save after it waited on it until the service was restarted the next
 * day. The git commands themselves are killed by their own timeout (see
 * `runGit`); this cap is the backstop for anything else a task awaits.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly taskTimeoutMs = 10 * 60_000) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const capped = () => withTimeout(task(), this.taskTimeoutMs);
    const result = this.tail.then(capped, capped);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueTaskTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

export interface GitResult {
  ok: boolean;
  exitCode: number | null;
  out: string;
  timedOut: boolean;
}

// ssh must never wait on a prompt or a dead connection: fail fast instead.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    process.env.GIT_SSH_COMMAND ??
    "ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3",
};

/**
 * Run `git -C root ...args`, killing it (SIGKILL) if it runs past
 * `timeoutMs`. Never throws for a non-zero exit; the caller reads `ok`.
 */
export async function runGit(root: string, args: string[], timeoutMs: number): Promise<GitResult> {
  return runCommand(["git", "-C", root, ...args], timeoutMs, GIT_ENV);
}

export async function runCommand(
  cmd: string[],
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Only our own timeout sends SIGKILL to this child.
  const timedOut = proc.signalCode === "SIGKILL";
  const out = `${stdout}${stderr}`.trim();
  return {
    ok: exitCode === 0 && !timedOut,
    exitCode,
    out: timedOut ? `timed out after ${timeoutMs}ms: ${cmd.slice(3).join(" ")}${out ? ` (${out})` : ""}` : out,
    timedOut,
  };
}

const NETWORK_COMMANDS = new Set(["fetch", "pull", "push"]);

export interface CommitResult {
  sha: string | null;
  pushed: boolean;
}

export class Vault {
  readonly root: string;
  readonly queue: SerialQueue;

  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly autoPush: boolean;
  private readonly pushDelayMs: number;
  private readonly gitTimeoutMs: number;
  private readonly gitNetworkTimeoutMs: number;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private syncState: SyncState = {};

  constructor(options: VaultOptions) {
    this.root = options.root;
    this.authorName = options.authorName ?? "scholion-webclipper";
    this.authorEmail = options.authorEmail ?? "scholion-webclipper@localhost";
    this.autoPush = options.autoPush ?? false;
    this.pushDelayMs = options.pushDelayMs ?? 2_000;
    this.gitTimeoutMs = options.gitTimeoutMs ?? 60_000;
    this.gitNetworkTimeoutMs = options.gitNetworkTimeoutMs ?? 120_000;
    this.queue = new SerialQueue(options.taskTimeoutMs ?? 10 * 60_000);
  }

  async noteExists(relPath: string): Promise<boolean> {
    return Bun.file(join(this.root, relPath)).exists();
  }

  /**
   * Write the clipping and the note, one commit covering both — see README
   * "What save writes". Refuses if the note path already exists (a slug
   * conflict): checked inside the queue, so two concurrent saves for the
   * same slug can't race past each other.
   */
  async save(rendered: RenderedOperation, message: string): Promise<CommitResult> {
    return this.queue.run(async () => {
      if (await this.noteExists(rendered.noteRelPath)) {
        throw new SlugExistsError(`${rendered.noteRelPath} already exists`);
      }

      const clippingAbs = join(this.root, rendered.clippingRelPath);
      const noteAbs = join(this.root, rendered.noteRelPath);
      await mkdir(dirname(clippingAbs), { recursive: true });
      await mkdir(dirname(noteAbs), { recursive: true });
      await Bun.write(clippingAbs, rendered.clippingContent);
      await Bun.write(noteAbs, rendered.noteContent);

      const pushed = await this.commit([rendered.clippingRelPath, rendered.noteRelPath], message);
      const sha = pushed === null ? null : await this.headSha();
      return { sha, pushed: this.autoPush };
    });
  }

  private async headSha(): Promise<string> {
    const result = await this.run("rev-parse", "HEAD");
    if (!result.ok) throw new Error(`git rev-parse failed: ${result.out}`);
    return result.out;
  }

  /** Stage and commit an explicit set of paths, then schedule the push. Returns null if there was nothing to commit. */
  private async commit(pathspecs: string[], message: string): Promise<boolean | null> {
    const added = await this.run("add", "--", ...pathspecs);
    if (!added.ok) throw new Error(`git add failed: ${added.out}`);

    const result = await this.run(
      "-c", `user.name=${this.authorName}`, "-c", `user.email=${this.authorEmail}`, "commit", "-m", message,
    );

    if (!result.ok) {
      if (!result.timedOut && /nothing to commit|no changes added/i.test(result.out)) return null;
      throw new Error(`git commit failed: ${result.out}`);
    }

    this.schedulePush();
    return true;
  }

  private schedulePush(): void {
    if (!this.autoPush || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.sync().catch(() => undefined);
    }, this.pushDelayMs);
    this.pushTimer.unref?.();
  }

  async sync(): Promise<void> {
    try {
      await this.queue.run(() => this.syncUnqueued());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.syncState = { ...this.syncState, lastError: `sync failed: ${message}` };
      console.error(`[vault] sync failed: ${message}`);
      throw error;
    }
  }

  private async run(...args: string[]): Promise<GitResult> {
    const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    const timeout = sub && NETWORK_COMMANDS.has(sub) ? this.gitNetworkTimeoutMs : this.gitTimeoutMs;
    const result = await runGit(this.root, args, timeout);
    if (result.timedOut) console.error(`[vault] ${result.out}`);
    return result;
  }

  private async isDirty(): Promise<boolean> {
    return (await this.run("status", "--porcelain")).out !== "";
  }

  private async unmergedPaths(): Promise<string[]> {
    const { out } = await this.run("diff", "--name-only", "--diff-filter=U");
    return out ? out.split("\n") : [];
  }

  private async stashes(): Promise<string[]> {
    const { out } = await this.run("stash", "list");
    return out ? out.split("\n") : [];
  }

  /**
   * The raw pull-and-push. Call {@link sync} instead.
   *
   * Copied from scholion-places, same nasty fact it was written around and
   * verified there: `git pull --rebase --autostash` exits 0 even when
   * reapplying the autostash fails. Rebase only when there's something to
   * rebase onto, and check the result rather than trust the exit code.
   */
  private async syncUnqueued(): Promise<void> {
    const fetched = await this.run("fetch", "--quiet");
    if (!fetched.ok) {
      this.syncState = { ...this.syncState, lastError: `fetch failed: ${fetched.out}` };
      console.error(`[vault] fetch failed: ${fetched.out}`);
      return;
    }

    const upstream = await this.run("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    if (!upstream.ok) {
      this.syncState = { ...this.syncState, lastError: "no upstream branch configured" };
      return;
    }

    const upToDate = await this.run("merge-base", "--is-ancestor", upstream.out, "HEAD");

    if (!upToDate.ok) {
      const dirty = await this.isDirty();
      const stashesBefore = (await this.stashes()).length;

      const flags = dirty
        ? ["pull", "--rebase", "--autostash", "--quiet"]
        : ["pull", "--rebase", "--quiet"];
      const pull = await this.run(...flags);

      if (!pull.ok) {
        const aborted = await this.run("rebase", "--abort");
        this.syncState = {
          ...this.syncState,
          lastError: `pull failed${aborted.ok ? " (rebase aborted)" : ""}: ${pull.out}`,
        };
        console.error(`[vault] pull --rebase failed: ${pull.out}`);
        return;
      }

      const unmerged = await this.unmergedPaths();
      if (unmerged.length) {
        await this.run("reset", "--hard", "--quiet", "HEAD");
        const stash = (await this.stashes())[0] ?? "stash@{0}";
        const hint =
          `an uncommitted change to ${unmerged.join(", ")} collided with a change from the remote. ` +
          `It was NOT lost — recover it with: git -C ${this.root} stash pop`;
        this.syncState = { ...this.syncState, strandedStash: stash, strandedHint: hint };
        console.error(`[vault] ${hint}`);
      } else if ((await this.stashes()).length > stashesBefore) {
        const stash = (await this.stashes())[0] ?? "stash@{0}";
        this.syncState = {
          ...this.syncState,
          strandedStash: stash,
          strandedHint: `an autostash was left behind; recover it with: git -C ${this.root} stash pop`,
        };
        console.error(`[vault] ${this.syncState.strandedHint}`);
      }
    }

    const push = await this.run("push", "--quiet");
    if (!push.ok) {
      this.syncState = { ...this.syncState, lastError: `push failed: ${push.out}` };
      console.error(`[vault] push failed: ${push.out}`);
      return;
    }

    this.syncState = { ...this.syncState, lastSyncAt: Date.now(), lastError: undefined };
  }

  async checkForStrandedWork(): Promise<string[]> {
    const stashes = await this.stashes();
    this.syncState = {
      ...this.syncState,
      strandedStash: stashes[0],
      strandedHint: stashes.length
        ? (this.syncState.strandedHint ??
          `somebody's edit is waiting in the stash; recover it with: git -C ${this.root} stash pop`)
        : undefined,
    };
    return stashes;
  }

  get state(): SyncState {
    return { ...this.syncState };
  }

  async shutdown(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.queue.drain();
  }
}
