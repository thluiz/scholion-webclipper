// acl-reloader.ts — the ACL, re-read when its file moves (same pattern as
// scholion-places). Lives beside the vendored acl.ts rather than inside it,
// so acl.ts stays a verbatim copy (README Decision 4).

import { stat } from "node:fs/promises";

import { describe } from "../errors";
import { Acl, unknownOperations } from "./acl";

const CHECK_INTERVAL_MS = 5_000;

export class AclReloader {
  private checkedAt = 0;

  private constructor(
    private readonly path: string,
    private readonly logPrefix: string,
    private acl: Acl,
    private mtimeMs: number,
  ) {}

  static async open(path: string, logPrefix: string): Promise<AclReloader> {
    const acl = await Acl.load(path);
    const { mtimeMs } = await stat(path);
    return new AclReloader(path, logPrefix, acl, mtimeMs);
  }

  /** The loaded ACL, without checking the file. */
  get loaded(): Acl {
    return this.acl;
  }

  /** The ACL, re-read first if the file changed (checked at most every 5s). */
  async current(): Promise<Acl> {
    const now = Date.now();
    if (now - this.checkedAt < CHECK_INTERVAL_MS) return this.acl;
    this.checkedAt = now;

    try {
      const { mtimeMs } = await stat(this.path);
      if (mtimeMs !== this.mtimeMs) {
        this.acl = await Acl.load(this.path);
        this.mtimeMs = mtimeMs;
        await this.warnUnknown();
        console.log(`${this.logPrefix} acl reloaded — ${this.acl.principals().length} principals`);
      }
    } catch (error) {
      console.error(`${this.logPrefix} keeping previous ACL: ${describe(error)}`);
    }
    return this.acl;
  }

  async warnUnknown(): Promise<void> {
    const file = JSON.parse(await Bun.file(this.path).text());
    const unknown = unknownOperations(file);
    if (unknown.length) {
      console.warn(`[acl] these names match no operation and control nothing: ${unknown.join(", ")}`);
    }
  }
}
