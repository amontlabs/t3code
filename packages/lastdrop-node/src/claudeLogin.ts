/**
 * Signing an extra Claude account in from any client: `claude auth login`, run without a terminal in the
 * account's folder, prints a sign-in URL whose page shows a code, then reads that code on stdin. Port of
 * headroom's `ClaudeSignIn.browserSignIn`/`CLILogin`, with a pasted code instead of a localhost callback.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import { claudeExecutable, signedInAccountOf } from "./claudeSignIn.ts";
import { claudeFolder, helperDirectory, type LastdropPaths } from "./paths.ts";

/** A sign-in nobody finished is stopped after this long. */
export const LOGIN_EXPIRES_MS = 10 * 60_000;

export class SignInError extends Error {}

interface Flow {
  readonly child: NodeChildProcess.ChildProcess;
  readonly exited: Promise<number | null>;
  readonly timer: ReturnType<typeof setTimeout>;
  output: string;
  url?: string | undefined;
}

export interface ClaudeLoginsOptions {
  readonly paths: LastdropPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** How long to wait for the URL, and for Claude Code to finish after the code. */
  readonly urlTimeoutMs?: number;
  readonly finishTimeoutMs?: number;
  /** Called when a sign-in landed, however it finished. */
  readonly onSignedIn?: (key: string) => void;
}

const URL_PATTERN = /https:\/\/\S+/u;

/** The last line Claude Code printed, for an error. */
const lastLine = (output: string) =>
  output
    .split(/\r?\n/u)
    .map((line) => line.replace(/^Paste code[^>]*>/u, "").trim())
    .findLast((line) => line.length > 0);

export class ClaudeLogins {
  private readonly flows = new Map<string, Flow>();
  private readonly failures = new Map<string, string>();
  private readonly options: ClaudeLoginsOptions;

  constructor(options: ClaudeLoginsOptions) {
    this.options = options;
  }

  /** The URL of a sign-in waiting for its code. */
  pendingUrl(key: string): string | undefined {
    return this.flows.get(key)?.url;
  }

  /** Why the last sign-in failed, until the next one starts. */
  failure(key: string): string | undefined {
    return this.failures.get(key);
  }

  /** Starts Claude Code's sign-in in the account's folder and returns its URL. A running one is replaced. */
  async start(key: string): Promise<string> {
    const { paths } = this.options;
    const folder = claudeFolder(paths, key);
    if (folder === undefined) {
      throw new SignInError("Claude Code's own login is signed in with `claude auth login`.");
    }
    const claude = await claudeExecutable(paths, this.options.env);
    if (claude === undefined) throw new SignInError("Claude Code (`claude`) wasn't found.");
    this.cancel(key);
    this.failures.delete(key);
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    const cwd = helperDirectory(paths);
    await NodeFSP.mkdir(cwd, { recursive: true, mode: 0o700 });
    const env: Record<string, string | undefined> = Object.fromEntries(
      Object.entries(this.options.env).filter(([name]) => !name.startsWith("CLAUDE")),
    );
    env["CLAUDE_CONFIG_DIR"] = folder;
    // The client opens the URL; a browser opened on the server would sign in a second time.
    env["BROWSER"] = "true";
    const child = NodeChildProcess.spawn(claude, ["auth", "login"], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(null));
      child.on("exit", (code) => resolve(code));
    });
    const flow: Flow = {
      child,
      exited,
      output: "",
      timer: setTimeout(() => this.cancel(key), LOGIN_EXPIRES_MS),
    };
    flow.timer.unref?.();
    this.flows.set(key, flow);
    child.stdin.on("error", () => {});
    const urlSeen = new Promise<void>((resolve) => {
      const take = (chunk: Buffer) => {
        flow.output = (flow.output + chunk.toString("utf8")).slice(-4000);
        flow.url ??= URL_PATTERN.exec(flow.output)?.[0];
        if (flow.url) resolve();
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
    });
    // Finished on its own (a browser on this machine completed it) or failed: either way it's no longer pending.
    void exited.then(async (code) => {
      clearTimeout(flow.timer);
      if (this.flows.get(key) !== flow) return;
      this.flows.delete(key);
      if (code === 0 && (await signedInAccountOf(paths, folder)).uuid !== undefined) {
        this.options.onSignedIn?.(key);
      } else if (code !== null) {
        this.failures.set(key, lastLine(flow.output) ?? "The sign-in didn't finish.");
      }
    });
    const timeout = timer(this.options.urlTimeoutMs ?? 20_000);
    const first = await Promise.race([
      urlSeen.then(() => "url" as const),
      exited.then(() => "exited" as const),
      timeout.done.then(() => "timeout" as const),
    ]);
    timeout.clear();
    if (first !== "url" || flow.url === undefined) {
      this.cancel(key);
      throw new SignInError(
        lastLine(flow.output) ?? "Claude Code didn't show a sign-in page. Try again.",
      );
    }
    return flow.url;
  }

  /** Hands the page's code to the waiting sign-in and waits for Claude Code to store it. */
  async submit(key: string, code: string): Promise<void> {
    const flow = this.flows.get(key);
    if (flow === undefined) throw new SignInError("That sign-in ended. Start it again.");
    const trimmed = code.trim();
    if (trimmed === "") throw new SignInError("Paste the code the sign-in page shows.");
    flow.child.stdin?.write(`${trimmed}\n`);
    const timeout = timer(this.options.finishTimeoutMs ?? 60_000);
    const status = await Promise.race([flow.exited, timeout.done.then(() => "timeout" as const)]);
    timeout.clear();
    if (status === "timeout") {
      this.cancel(key);
      throw new SignInError("Claude Code didn't finish signing in. Try again.");
    }
    const folder = claudeFolder(this.options.paths, key);
    if (status !== 0 || (await signedInAccountOf(this.options.paths, folder)).uuid === undefined) {
      throw new SignInError(lastLine(flow.output) ?? "The sign-in didn't finish. Try again.");
    }
  }

  /** Stops a waiting sign-in. */
  cancel(key: string): void {
    const flow = this.flows.get(key);
    if (flow === undefined) return;
    this.flows.delete(key);
    clearTimeout(flow.timer);
    flow.child.stdin?.end();
    if (flow.child.exitCode === null) flow.child.kill("SIGTERM");
  }

  cancelAll(): void {
    for (const key of this.flows.keys()) this.cancel(key);
  }
}

function timer(ms: number) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { done, clear: () => clearTimeout(handle) };
}
