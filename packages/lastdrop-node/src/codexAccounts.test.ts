// The Codex accounts' files and sign-in, in a temporary home with a fake `codex` (see PORTING.md).
import * as NodeFS from "node:fs";

import { addCodexAccount } from "@t3tools/lastdrop-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CodexAccountFiles,
  CodexLogins,
  codexAccountsFile,
  parseCodexDeviceCode,
} from "./codexAccounts.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

let t: TestHome;
let files: CodexAccountFiles;
beforeEach(() => {
  t = makeTestHome();
  files = new CodexAccountFiles(t.paths.dataDir);
});
afterEach(() => t.remove());

/** A fake `codex login --device-auth`: prints the page and code like Codex, then signs in when `go` appears. */
function fakeCodex(): string {
  const path = `${t.root}/codex`;
  NodeFS.writeFileSync(
    path,
    `#!/bin/sh
echo "$@" > "$CODEX_HOME/args"
[ -n "$FAIL" ] && { echo "Error: device code login is not enabled" >&2; exit 1; }
printf '\\033[1mFollow these steps to sign in with ChatGPT\\033[0m\\n'
printf '1. Open this link\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n'
printf '2. Enter this one-time code\\n   \\033[94mABCD-EFGH2\\033[0m\\n'
while [ ! -f "$CODEX_HOME/go" ]; do sleep 0.05; done
echo '{"tokens":{}}' > "$CODEX_HOME/auth.json"
echo "Successfully logged in"
`,
    { mode: 0o755 },
  );
  return path;
}

const logins = (
  codex: string,
  env: Record<string, string> = {},
  onSignedIn: (key: string) => void = () => {},
) =>
  new CodexLogins({
    files,
    env: { PATH: process.env["PATH"], ...env },
    codex,
    cwd: `${t.paths.dataDir}/helper`,
    onSignedIn,
    pollMs: 20,
  });

describe("the Codex account files", () => {
  it("saves the list, the thread records and readings in lastdrop's folder only", async () => {
    await files.editList((list) => addCodexAccount(list, "Work", 1)!.list);
    expect(t.read(codexAccountsFile(t.paths.dataDir))).toEqual({
      accounts: [{ key: "Work", addedAt: 1 }],
    });
    await files.recordThread("native-1", { account: "Work", threadId: "t1", at: 10 });
    expect((await files.threads())["native-1"]).toEqual({
      account: "Work",
      threadId: "t1",
      at: 10,
    });
    await files.updateUsage("Work", () => ({ readAt: 5, email: "a@b.c" }));
    await files.updateUsage("Gone", () => ({ readAt: 5 }));
    await files.updateUsage("Gone", () => undefined);
    expect(await files.usage()).toEqual({ Work: { readAt: 5, email: "a@b.c" } });
  });

  it("removing an account deletes its home and nothing its links point to", async () => {
    const shared = `${t.paths.home}/.codex/sessions`;
    NodeFS.mkdirSync(shared, { recursive: true });
    NodeFS.writeFileSync(`${shared}/s.jsonl`, "{}");
    NodeFS.mkdirSync(files.home("Work"), { recursive: true });
    NodeFS.symlinkSync(shared, `${files.home("Work")}/sessions`);
    NodeFS.writeFileSync(`${files.home("Work")}/auth.json`, "{}");
    expect(await files.signedIn("Work")).toBe(true);
    await files.removeHome("Work");
    await files.removeHome("../..");
    expect(NodeFS.existsSync(files.home("Work"))).toBe(false);
    expect(NodeFS.existsSync(`${shared}/s.jsonl`)).toBe(true);
    expect(NodeFS.existsSync(t.paths.dataDir)).toBe(true);
  });
});

describe("signing a Codex account in", () => {
  it("reads Codex's page and code through its colours", () => {
    expect(
      parseCodexDeviceCode(
        "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n code \u001b[94mABCD-EFGH2\u001b[0m",
      ),
    ).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH2" });
    expect(parseCodexDeviceCode("https://auth.openai.com/codex/device\n")).toBeUndefined();
  });

  it("shows the page and code, then lands once the account's auth.json is written", async () => {
    let landed!: (key: string) => void;
    const signedIn = new Promise<string>((resolve) => {
      landed = resolve;
    });
    const flow = logins(fakeCodex(), {}, landed);
    const device = await flow.start("Work");
    expect(device).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH2" });
    expect(flow.pending("Work")).toEqual(device);
    expect(NodeFS.readFileSync(`${files.home("Work")}/args`, "utf8").trim()).toBe(
      'login --device-auth -c cli_auth_credentials_store="file"',
    );
    NodeFS.writeFileSync(`${files.home("Work")}/go`, "");
    expect(await signedIn).toBe("Work");
    expect(flow.pending("Work")).toBeUndefined();
    expect(await files.signedIn("Work")).toBe(true);
  });

  it("a failing Codex shows its own last line", async () => {
    const flow = logins(fakeCodex(), { FAIL: "1" });
    await expect(flow.start("Work")).rejects.toThrow("device code login is not enabled");
    expect(flow.pending("Work")).toBeUndefined();
  });

  it("a missing Codex says so", async () => {
    await expect(logins(`${t.root}/nothing`).start("Work")).rejects.toThrow(
      "Codex (`codex`) wasn't found.",
    );
  });
});
