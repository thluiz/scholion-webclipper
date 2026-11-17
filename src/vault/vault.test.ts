import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QueueTaskTimeoutError, runCommand, runGit, SerialQueue } from "./vault";

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
