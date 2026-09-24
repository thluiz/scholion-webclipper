// operations.ts — the compose→save token (README Decision 2).
//
// Stored server-side, never trusted from the client, so a caller can't hand
// back a doctored verdict. Persisted to disk (one JSON file per operation)
// so a restart doesn't silently lose a draft someone's about to review —
// but it's still ephemeral: TTL-bound, and a caller only ever addresses one
// by its id, never by content.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AuditResult, ClippingDraft, NoteDraft } from "./model";
import type { RenderedOperation } from "./render";
import { OperationAlreadySavedError, OperationNotFoundError } from "./errors";

export interface Operation {
  id: string;
  principal: string;
  createdAt: string;
  expiresAt: string;
  consumed: boolean;
  clipping: ClippingDraft;
  note: NoteDraft;
  audit: AuditResult;
  rendered: RenderedOperation;
}

export class OperationStore {
  private readonly byId = new Map<string, Operation>();

  constructor(
    private readonly dir: string,
    private readonly ttlHours: number,
  ) {}

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o750 });
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }

    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.dir, name), "utf8");
        const op = JSON.parse(raw) as Operation;
        if (new Date(op.expiresAt).getTime() < now) {
          await rm(join(this.dir, name), { force: true });
          continue;
        }
        this.byId.set(op.id, op);
      } catch (error) {
        console.error(`[operations] skipping unreadable ${name}: ${error}`);
      }
    }
  }

  async create(
    principal: string,
    data: { clipping: ClippingDraft; note: NoteDraft; audit: AuditResult; rendered: RenderedOperation },
  ): Promise<Operation> {
    const now = new Date();
    const op: Operation = {
      id: crypto.randomUUID(),
      principal,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlHours * 3_600_000).toISOString(),
      consumed: false,
      ...data,
    };
    this.byId.set(op.id, op);
    await writeFile(this.path(op.id), JSON.stringify(op, null, 2), "utf8");
    return op;
  }

  /** Live (not expired) operation, or undefined. Does not distinguish "never existed" from "expired" — callers that need that use get() + require(). */
  get(id: string): Operation | undefined {
    const op = this.byId.get(id);
    if (!op) return undefined;
    if (new Date(op.expiresAt).getTime() < Date.now()) {
      this.byId.delete(id);
      void rm(this.path(id), { force: true }).catch(() => undefined);
      return undefined;
    }
    return op;
  }

  require(id: string): Operation {
    const op = this.get(id);
    if (!op) throw new OperationNotFoundError(id);
    return op;
  }

  /** require() + refuse a second consumption. Does not mark consumed — the caller does that once the write actually succeeds. */
  requireUnconsumed(id: string): Operation {
    const op = this.require(id);
    if (op.consumed) throw new OperationAlreadySavedError(id);
    return op;
  }

  async markConsumed(id: string): Promise<void> {
    const op = this.byId.get(id);
    if (!op) return;
    op.consumed = true;
    await writeFile(this.path(id), JSON.stringify(op, null, 2), "utf8").catch(() => undefined);
  }

  async discard(id: string): Promise<boolean> {
    const existed = this.byId.delete(id);
    await rm(this.path(id), { force: true }).catch(() => undefined);
    return existed;
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, op] of this.byId) {
      if (new Date(op.expiresAt).getTime() < now) {
        this.byId.delete(id);
        await rm(this.path(id), { force: true }).catch(() => undefined);
      }
    }
  }

  count(): number {
    return this.byId.size;
  }
}
