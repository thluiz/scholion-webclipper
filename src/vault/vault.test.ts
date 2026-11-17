import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QueueTaskTimeoutError, runCommand, runGit, SerialQueue, SlugExistsError, Vault } from "./vault";

describe("SerialQueue", () => {
  test("runs tasks one at a time, in order", async () => {
    const q = new SerialQueue(1_000);
    const order: number[] = [];
    await Promise.all([
      q.run(async () => {
        await Bun.sleep(30);
        order.push(1);
      }),
      q.run(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  test("a failed task does not poison the next one", async () => {
    const q = new SerialQueue(1_000);
    const failed = q.run(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect(await q.run(async () => "next")).toBe("next");
  });

  test("a task that never settles times out and the queue moves on", async () => {
    const q = new SerialQueue(100);
    const stuck = q.run(() => new Promise<never>(() => undefined));
    const next = q.run(async () => "after");
    await expect(stuck).rejects.toBeInstanceOf(QueueTaskTimeoutError);
    expect(await next).toBe("after");
  });
});

describe("runCommand", () => {
  test("kills a command that runs past its timeout", async () => {
    const started = Date.now();
    const result = await runCommand([process.execPath, "-e", "await Bun.sleep(10_000)"], 300);
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("reports a normal exit", async () => {
    const ok = await runCommand([process.execPath, "-e", "console.log('hi')"], 5_000);
    expect(ok).toMatchObject({ ok: true, exitCode: 0, timedOut: false, out: "hi" });

    const bad = await runCommand([process.execPath, "-e", "process.exit(3)"], 5_000);
    expect(bad).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
  });
});

describe("runGit", () => {
  test("runs git in the given directory without throwing on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-test-"));
    try {
      expect((await runGit(dir, ["init", "-q"], 10_000)).ok).toBe(true);
      expect((await runGit(dir, ["rev-parse", "--is-inside-work-tree"], 10_000)).out).toBe("true");
      const missing = await runGit(dir, ["rev-parse", "HEAD"], 10_000);
      expect(missing.ok).toBe(false);
      expect(missing.timedOut).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Vault.save and drafts", () => {
  async function repo() {
    const dir = await mkdtemp(join(tmpdir(), "vault-save-"));
    await runGit(dir, ["init", "-q"], 10_000);
    return dir;
  }

  const url = "https://example.com/post";
  const draftNote = `---\ntitle: "T"\ncategory: webclip\ndraft: true\naudit_verdict: "red"\nsources:\n  - title: "T"\n    url: "${url}"\n    kind: article\n---\n\nold body\n`;
  const finalNote = draftNote.replace('draft: true\naudit_verdict: "red"\n', "").replace("old body", "new body");
  const op = (noteContent: string) => ({
    clippingContent: "clip\n",
    clippingRelPath: "clippings/2026-11/example-com--t.md",
    noteContent,
    noteRelPath: "content/notes/t.md",
  });

  test("a later save of the same page replaces its draft", async () => {
    const dir = await repo();
    try {
      const v = new Vault({ root: dir });
      expect((await v.save(op(draftNote), "draft", url)).sha).toBeTruthy();
      await v.save(op(finalNote), "final", url);
      const text = await Bun.file(join(dir, "content/notes/t.md")).text();
      expect(text).toContain("new body");
      expect(text).not.toContain("draft: true");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a published note, or a draft of another page, still conflicts", async () => {
    const dir = await repo();
    try {
      const v = new Vault({ root: dir });
      await v.save(op(draftNote), "draft", url);
      await expect(v.save(op(finalNote), "other page", "https://example.com/other")).rejects.toBeInstanceOf(
        SlugExistsError,
      );
      await v.save(op(finalNote), "final", url);
      await expect(v.save(op(finalNote), "again", url)).rejects.toBeInstanceOf(SlugExistsError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
