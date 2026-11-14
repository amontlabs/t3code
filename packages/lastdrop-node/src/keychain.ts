/**
 * Keychain access through `/usr/bin/security`. Port of headroom's `Keychain` (Keychain.swift).
 *
 * Items created by the `security` tool (Claude Code's, and lastdrop's own) list that tool in their access list,
 * so reading them this way never prompts, whatever signs the app.
 */
import * as NodeChildProcess from "node:child_process";

function run(
  security: string,
  args: ReadonlyArray<string>,
  stdin?: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.execFile(
      security,
      [...args],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
    child.stdin?.on("error", () => {});
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

/** A generic password's value, or undefined when there's none (or it's empty). */
export async function readKeychain(
  security: string,
  service: string,
  account?: string,
): Promise<string | undefined> {
  const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  const out = await run(security, args);
  return out ? out : undefined;
}

/** lastdrop's own secrets are stored base64-encoded and written on stdin, never in an argument list. */
export async function writeOwnKeychain(
  security: string,
  service: string,
  account: string,
  value: string,
): Promise<boolean> {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const line = `add-generic-password -U -s "${service}" -a "${account}" -w "${encoded}"\n`;
  return (await run(security, ["-i"], line)) !== undefined;
}

export async function readOwnKeychain(
  security: string,
  service: string,
  account: string,
): Promise<string | undefined> {
  const encoded = await readKeychain(security, service, account);
  if (encoded === undefined || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return undefined;
  return Buffer.from(encoded, "base64").toString("utf8");
}
