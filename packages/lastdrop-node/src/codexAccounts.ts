/**
 * The fork's Codex accounts on disk, all in lastdrop's folder (`~/.t3/lastdrop/`): the list
 * (`codex-accounts.json`), each account's Codex home (`codex/<key>/`, a T3 shadow home whose own `auth.json` is the
 * sign-in and whose other entries link to `~/.codex`), the account each native thread ran on (`codex-threads.json`),
 * each account's last usage reading (`codex-usage.json`), and signing in with `codex login --device-auth`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import {
  type CodexAccountList,
  type CodexThreadRecord,
  type CodexThreadRecords,
  parseCodexAccounts,
  parseCodexThreads,
  recordCodexThread,
  slug,
} from "@t3tools/lastdrop-core";

import { readJsonObject, writeAtomic } from "./files.ts";

/** Codex keeps the sign-in in the home's `auth.json`, never the keychain, so each account's stays its own. */
export const CODEX_FILE_STORE_CONFIG = 'cli_auth_credentials_store="file"';
/** The same as `codex` launch arguments (T3's `launchArgs` string, tokenized like a shell). */
export const CODEX_FILE_STORE_LAUNCH_ARGS = `-c '${CODEX_FILE_STORE_CONFIG}'`;

export const codexAccountsFile = (dataDir: string) => `${dataDir}/codex-accounts.json`;
export const codexThreadsFile = (dataDir: string) => `${dataDir}/codex-threads.json`;
export const codexUsageFile = (dataDir: string) => `${dataDir}/codex-usage.json`;
export const codexHomesDirectory = (dataDir: string) => `${dataDir}/codex`;
export const codexAccountHome = (dataDir: string, key: string) =>
  `${codexHomesDirectory(dataDir)}/${key}`;

/** One Codex rate-limit window (Codex's `RateLimitWindow`; reset in epoch seconds). */
export interface CodexLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

/** Codex's main (`codex`) rate-limit snapshot, as `account/rateLimits/read` and its updates report it. */
export interface CodexLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexLimitWindow | null;
  readonly secondary?: CodexLimitWindow | null;
  readonly individualLimit?: {
    readonly remainingPercent: number;
    readonly resetsAt: number;
  } | null;
}

/** An account's last reading. */
export interface CodexUsageRecord {
  /** Epoch ms of the reading (or of the failed read). */
  readonly readAt: number;
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
  readonly limits?: CodexLimitSnapshot | undefined;
  /** The last read failed; the limits are the last good ones. */
  readonly error?: string | undefined;
}

export type CodexUsageRecords = Readonly<Record<string, CodexUsageRecord>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseUsage(value: Record<string, unknown> | undefined): CodexUsageRecords {
  const records: Record<string, CodexUsageRecord> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!isRecord(entry) || typeof entry["readAt"] !== "number") continue;
    const { readAt, email, plan, limits, error } = entry;
    records[key] = {
      readAt,
      ...(typeof email === "string" ? { email } : {}),
      ...(typeof plan === "string" ? { plan } : {}),
      // Our own file: the snapshot is stored as Codex reported it.
      ...(isRecord(limits) ? { limits: limits as CodexLimitSnapshot } : {}),
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  return records;
}

/**
 * The files, with writes run one at a time. One instance per folder in a process (`codexAccountFiles`), so the
 * routing wrapper and the accounts service never overwrite each other's writes.
 */
export class CodexAccountFiles {
  private queue: Promise<unknown> = Promise.resolve();
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private serial<A>(run: () => Promise<A>): Promise<A> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  async list(): Promise<CodexAccountList> {
    return parseCodexAccounts(await readJsonObject(codexAccountsFile(this.dataDir)));
  }

  /** Applies `change` to the list and saves it; returns the saved list. */
  editList(change: (list: CodexAccountList) => CodexAccountList): Promise<CodexAccountList> {
    return this.serial(async () => {
      const next = change(await this.list());
      await writeAtomic(codexAccountsFile(this.dataDir), `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  home(key: string): string {
    return codexAccountHome(this.dataDir, key);
  }

  /** The sign-in file's change time, or undefined while the home has none. */
  async signInStamp(key: string): Promise<number | undefined> {
    const stat = await NodeFSP.stat(`${this.home(key)}/auth.json`).catch(() => undefined);
    return stat?.isFile() ? stat.mtimeMs : undefined;
  }

  async signedIn(key: string): Promise<boolean> {
    return (await this.signInStamp(key)) !== undefined;
  }

  /** Deletes the account's home (its sign-in); nothing outside `codex/<key>`, and no link's target. */
  async removeHome(key: string): Promise<void> {
    if (slug(key) !== key || key === "") return;
    await NodeFSP.rm(this.home(key), { recursive: true, force: true });
  }

  async threads(): Promise<CodexThreadRecords> {
    return parseCodexThreads(await readJsonObject(codexThreadsFile(this.dataDir)));
  }

  recordThread(nativeId: string, record: CodexThreadRecord): Promise<void> {
    return this.serial(async () => {
      const records = await this.threads();
      const current = records[nativeId];
      if (current?.account === record.account && current.threadId === record.threadId) {
        // Seen again within the hour: not worth a write.
        if (record.at - current.at < 60 * 60_000) return;
      }
      const next = recordCodexThread(records, nativeId, record);
      await writeAtomic(codexThreadsFile(this.dataDir), `${JSON.stringify({ threads: next })}\n`);
    });
  }

  async usage(): Promise<CodexUsageRecords> {
    return parseUsage(await readJsonObject(codexUsageFile(this.dataDir)));
  }

  /** Changes one account's reading; `undefined` from `change` forgets it. */
  updateUsage(
    key: string,
    change: (current: CodexUsageRecord | undefined) => CodexUsageRecord | undefined,
  ): Promise<void> {
    return this.serial(async () => {
      const records: Record<string, CodexUsageRecord> = { ...(await this.usage()) };
      const next = change(records[key]);
      if (next === undefined) delete records[key];
      else records[key] = next;
      await writeAtomic(codexUsageFile(this.dataDir), `${JSON.stringify(records, null, 2)}\n`);
    });
  }
}

const filesByFolder = new Map<string, CodexAccountFiles>();

/** The process's one `CodexAccountFiles` for `dataDir`. */
export function codexAccountFiles(dataDir: string): CodexAccountFiles {
  let files = filesByFolder.get(dataDir);
  if (files === undefined) {
    files = new CodexAccountFiles(dataDir);
    filesByFolder.set(dataDir, files);
  }
  return files;
}

// MARK: Sign-in

/** A device-code sign-in nobody finished is stopped after this long (Codex's codes last 15 minutes). */
export const CODEX_LOGIN_EXPIRES_MS = 15 * 60_000;

export class CodexSignInError extends Error {}

/** What the user opens and types: Codex's device page and its one-time code. */
export interface CodexDeviceCode {
  readonly url: string;
  readonly code: string;
}

interface Flow {
  readonly child: NodeChildProcess.ChildProcess;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly poll: ReturnType<typeof setInterval>;
  output: string;
  device?: CodexDeviceCode | undefined;
}

export interface CodexLoginsOptions {
  readonly files: CodexAccountFiles;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The `codex` executable; `codex` from `PATH` when unset. */
  readonly codex?: string | undefined;
  /** An empty folder to run in. */
  readonly cwd: string;
  readonly onSignedIn?: (key: string) => void;
  /** For tests. */
  readonly codeTimeoutMs?: number;
  readonly pollMs?: number;
}

const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "gu");
const URL_PATTERN = /https:\/\/\S+/u;
const CODE_PATTERN = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/u;

/** Codex's device page and code, once it printed both. */
export function parseCodexDeviceCode(output: string): CodexDeviceCode | undefined {
  const text = output.replace(ANSI, "");
  const url = URL_PATTERN.exec(text)?.[0];
  if (url === undefined) return undefined;
  const code = CODE_PATTERN.exec(text.slice(text.indexOf(url) + url.length))?.[0];
  return code === undefined ? undefined : { url, code };
}

const lastLine = (output: string) =>
  output
    .replace(ANSI, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);

/** `codex login --device-auth` per account: shows its page and code, done once its `auth.json` is written. */
export class CodexLogins {
  private readonly flows = new Map<string, Flow>();
  private readonly failures = new Map<string, string>();
  private readonly options: CodexLoginsOptions;

  constructor(options: CodexLoginsOptions) {
    this.options = options;
  }

  pending(key: string): CodexDeviceCode | undefined {
    return this.flows.get(key)?.device;
  }

  failure(key: string): string | undefined {
    return this.failures.get(key);
  }

  /**
   * Starts a sign-in in the account's home and returns its page and code. A running one is replaced. The caller
   * prepares the home first (T3's shadow home, so the sign-in's Codex reads the shared config).
   */
  async start(key: string): Promise<CodexDeviceCode> {
    const { files } = this.options;
    this.cancel(key);
    this.failures.delete(key);
    await NodeFSP.mkdir(files.home(key), { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(this.options.cwd, { recursive: true, mode: 0o700 });
    const before = await files.signInStamp(key);
    const env: Record<string, string | undefined> = { ...this.options.env };
    env["CODEX_HOME"] = files.home(key);
    // The client opens the page; one opened on the server would be a second sign-in.
    env["BROWSER"] = "true";
    delete env["OPENAI_API_KEY"];
    const child = NodeChildProcess.spawn(
      this.options.codex ?? "codex",
      ["login", "--device-auth", "-c", CODEX_FILE_STORE_CONFIG],
      { env, cwd: this.options.cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(null));
      child.on("exit", (code) => resolve(code));
    });
    const landed = async () => {
      const stamp = await files.signInStamp(key);
      return stamp !== undefined && stamp !== before;
    };
    const flow: Flow = {
      child,
      output: "",
      timer: setTimeout(() => this.cancel(key), CODEX_LOGIN_EXPIRES_MS),
      poll: setInterval(() => {
        void landed().then((done) => {
          if (done && this.flows.get(key) === flow) this.finish(key, flow, true);
        });
      }, this.options.pollMs ?? 1000),
    };
    flow.timer.unref?.();
    flow.poll.unref?.();
    this.flows.set(key, flow);
    const shown = new Promise<void>((resolve) => {
      const take = (chunk: Buffer) => {
        flow.output = (flow.output + chunk.toString("utf8")).slice(-4000);
        flow.device ??= parseCodexDeviceCode(flow.output);
        if (flow.device) resolve();
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
    });
    void exited.then(async (code) => {
      if (this.flows.get(key) !== flow) return;
      this.finish(key, flow, code === 0 && (await landed()));
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      shown.then(() => "shown" as const),
      exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), this.options.codeTimeoutMs ?? 20_000);
      }),
    ]);
    clearTimeout(timeout);
    if (first !== "shown" || flow.device === undefined) {
      const why = lastLine(flow.output);
      this.cancel(key);
      this.failures.delete(key);
      throw new CodexSignInError(
        first === "exited" && flow.output === ""
          ? "Codex (`codex`) wasn't found."
          : (why ?? "Codex didn't show a sign-in code. Try again."),
      );
    }
    return flow.device;
  }

  private finish(key: string, flow: Flow, signedIn: boolean): void {
    this.flows.delete(key);
    clearTimeout(flow.timer);
    clearInterval(flow.poll);
    // A finished sign-in exits on its own once Codex has written it.
    if (!signedIn && flow.child.exitCode === null) flow.child.kill("SIGTERM");
    if (signedIn) this.options.onSignedIn?.(key);
    else this.failures.set(key, lastLine(flow.output) ?? "The sign-in didn't finish.");
  }

  /** Stops a waiting sign-in. */
  cancel(key: string): void {
    const flow = this.flows.get(key);
    if (flow === undefined) return;
    this.flows.delete(key);
    clearTimeout(flow.timer);
    clearInterval(flow.poll);
    if (flow.child.exitCode === null) flow.child.kill("SIGTERM");
  }

  cancelAll(): void {
    for (const key of this.flows.keys()) this.cancel(key);
  }
}
