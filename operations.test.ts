// operations.test.ts
//
// The property that matters most: an operation can be saved exactly once
// (README Decision 2's "closes the race where two save calls would
// otherwise double the commit"), and an expired one behaves as if it never
// existed rather than silently staying usable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationAlreadySavedError, OperationNotFoundError } from "./errors";
import { OperationStore } from "./operations";
import { renderOperation } from "./render";
import type { AuditResult, ClippingDraft, NoteDraft } from "./model";

const clipping: ClippingDraft = {
  url: "https://example.com/x",
  title: "Title",
  domain: "example-com",
  capturedAt: "2026-09-24T10:00:00-03:00",
  markdown: "content",
};

const note: NoteDraft = {
  slug: "title",
  title: "Title",
  summary: "summary",
  tags: ["tag"],
  language: "en",
  body: "body\n\n## Fichamento\n\n- point",
};

const audit: AuditResult = { verdict: "green", findings: [], summary: "" };
const rendered = renderOperation(clipping, note, { notes: "content/notes", clippings: "clippings" });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "swc-ops-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OperationStore", () => {
  test("create then require returns the same operation", async () => {
    const store = new OperationStore(dir, 24);
    const op = await store.create("thiago", { clipping, note, audit, rendered });
    expect(store.require(op.id).id).toBe(op.id);
    expect(store.require(op.id).note.slug).toBe("title");
  });

  test("require throws OperationNotFoundError for an unknown id", () => {
    const store = new OperationStore(dir, 24);
    expect(() => store.require("does-not-exist")).toThrow(OperationNotFoundError);
  });

  test("requireUnconsumed refuses a second use after markConsumed", async () => {
    const store = new OperationStore(dir, 24);
    const op = await store.create("thiago", { clipping, note, audit, rendered });
    store.requireUnconsumed(op.id); // first use: fine
    await store.markConsumed(op.id);
    expect(() => store.requireUnconsumed(op.id)).toThrow(OperationAlreadySavedError);
  });

  test("an expired operation behaves as not found", async () => {
    const store = new OperationStore(dir, -1); // already expired the instant it's created
    const op = await store.create("thiago", { clipping, note, audit, rendered });
    expect(store.get(op.id)).toBeUndefined();
    expect(() => store.require(op.id)).toThrow(OperationNotFoundError);
  });

  test("discard removes a pending operation", async () => {
    const store = new OperationStore(dir, 24);
    const op = await store.create("thiago", { clipping, note, audit, rendered });
    expect(await store.discard(op.id)).toBe(true);
    expect(store.get(op.id)).toBeUndefined();
    expect(await store.discard(op.id)).toBe(false); // already gone
  });

  test("survives a restart: load() picks up what create() wrote to disk", async () => {
    const store = new OperationStore(dir, 24);
    const op = await store.create("thiago", { clipping, note, audit, rendered });

    const reloaded = new OperationStore(dir, 24);
    await reloaded.load();
    expect(reloaded.require(op.id).note.slug).toBe("title");
  });

  test("load() drops expired files instead of resurrecting them", async () => {
    const store = new OperationStore(dir, -1);
    const op = await store.create("thiago", { clipping, note, audit, rendered });

    const reloaded = new OperationStore(dir, 24);
    await reloaded.load();
    expect(reloaded.get(op.id)).toBeUndefined();
  });

  test("sweep removes only expired entries from memory and disk", async () => {
    const live = new OperationStore(dir, 24);
    const opLive = await live.create("thiago", { clipping, note, audit, rendered });
    await live.sweep();
    expect(live.get(opLive.id)).toBeDefined();

    const expiring = new OperationStore(dir, -1);
    const opDead = await expiring.create("thiago", { clipping, note, audit, rendered });
    await expiring.sweep();
    expect(expiring.count()).toBe(0);
    expect(opDead).toBeDefined(); // create() itself still returns the record
  });
});
