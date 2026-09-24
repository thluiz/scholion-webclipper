// vault.ts — the Scholion clone this service writes into, and its own git
// queue. The commit/sync/push machinery (SerialQueue, the rebase/stash
// handling in syncUnqueued) is copied near-verbatim from scholion-places
// (E:\scholion-places\vault.ts) — it's fully generic, already hardened
// against the "two writers in one working tree" problem this service has
// too (README Decision 5). What's specific to this service is `save()`:
// two files, one commit, matching the resolved Decision 5/9/"What save
// writes" shape — never the record-then-render-separately pattern
// scholion-places uses for its own, different reasons.

import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RenderedOperation } from "./render";

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
}

/**
 * A promise chain that runs one task at a time.
 *
 * Deliberately not a library: the only requirement is that a failed task
 * does not poison the ones behind it, which is the single line below.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

export interface CommitResult {
  sha: string | null;
  pushed: boolean;
}

export class Vault {
  readonly root: string;
  readonly queue = new SerialQueue();

  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly autoPush: boolean;
  private readonly pushDelayMs: number;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private syncState: SyncState = {};

  constructor(options: VaultOptions) {
    this.root = options.root;
    this.authorName = options.authorName ?? "scholion-webclipper";
    this.authorEmail = options.authorEmail ?? "scholion-webclipper@localhost";
    this.autoPush = options.autoPush ?? false;
    this.pushDelayMs = options.pushDelayMs ?? 2_000;
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
    const result = await $`git -C ${this.root} rev-parse HEAD`.quiet();
    return result.stdout.toString().trim();
  }

  /** Stage and commit an explicit set of paths, then schedule the push. Returns null if there was nothing to commit. */
  private async commit(pathspecs: string[], message: string): Promise<boolean | null> {
    await $`git -C ${this.root} add -- ${pathspecs}`.quiet();

    const result =
      await $`git -C ${this.root} -c user.name=${this.authorName} -c user.email=${this.authorEmail} commit -m ${message}`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) {
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      if (/nothing to commit|no changes added/i.test(output)) return null;
      throw new Error(`git commit failed: ${output.trim()}`);
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
    return this.queue.run(() => this.syncUnqueued());
  }

  private async run(...args: string[]): Promise<{ ok: boolean; out: string }> {
    const result = await $`git -C ${this.root} ${args}`.quiet().nothrow();
    return {
      ok: result.exitCode === 0,
      out: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
    };
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
