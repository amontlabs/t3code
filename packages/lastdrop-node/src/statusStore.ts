/**
 * The fork's copy of each Claude account's latest reading, rate-limit block and sign-in state, in
 * `~/.t3/lastdrop/usage.json` (the standalone lastdrop's `usage.json` format). One server process writes it;
 * updates are serialized in process and written atomically.
 */
import { type AccountStatus, decodeStatusFile, encodeStatusFile } from "@t3tools/lastdrop-core";

import { readText, writeAtomic } from "./files.ts";

export class StatusStore {
  private queue: Promise<unknown> = Promise.resolve();

  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  async read(): Promise<Record<string, AccountStatus>> {
    const text = await readText(this.file);
    if (text === undefined) return {};
    try {
      return decodeStatusFile(text);
    } catch {
      return {};
    }
  }

  /** Read, change and write, one change at a time. */
  update<T>(change: (statuses: Record<string, AccountStatus>) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const statuses = await this.read();
      const result = change(statuses);
      await writeAtomic(this.file, encodeStatusFile(statuses));
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
