// A temporary home and a fake `security` that stores items in files, including `add-generic-password` fed on
// stdin through `security -i`, as `writeOwnKeychain` does. Nothing real is read or written.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { clearEndpointKey, endpointKeyStatus, setEndpointKey } from "./endpointKeys.ts";
import {
  endpointApiKey,
  lookupEndpointKey,
  prepareEndpointProfile,
  keyHelperPath,
} from "./endpoints.ts";
import { importableEndpointKeys, importEndpointKeys } from "./importFromApp.ts";
import { lastdropPaths, type LastdropPaths } from "./paths.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

/** The `security` subset the fork uses, with a keychain in `<root>/store` that `lock` makes fail (51). */
function fakeSecurity(root: string): string {
  const file = `${root}/security-writable`;
  NodeFS.mkdirSync(`${root}/store`, { recursive: true });
  NodeFS.writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const store = ${JSON.stringify(`${root}/store`)};
const name = (s, a) => store + "/" + Buffer.from(s + "/" + a).toString("hex");
if (fs.existsSync(${JSON.stringify(`${root}/store-locked`)})) process.exit(51);
const flag = (args, f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };
const run = (args) => {
  const [command] = args;
  const file = name(flag(args, "-s"), flag(args, "-a"));
  if (command === "find-generic-password") {
    if (!fs.existsSync(file)) process.exit(44);
    process.stdout.write(args.includes("-w") ? fs.readFileSync(file, "utf8") + "\\n" : "keychain: attributes\\n");
  } else if (command === "delete-generic-password") {
    if (!fs.existsSync(file)) process.exit(44);
    fs.rmSync(file);
  } else if (command === "add-generic-password") {
    fs.writeFileSync(file, flag(args, "-w"));
  } else process.exit(1);
};
const args = process.argv.slice(2);
if (args[0] === "-i") {
  for (const line of fs.readFileSync(0, "utf8").split("\\n").filter(Boolean)) {
    run([...line.matchAll(/"([^"]*)"|(\\S+)/g)].map((m) => m[1] ?? m[2]));
  }
} else run(args);
`,
    { mode: 0o755 },
  );
  return file;
}

let home: TestHome;
let paths: LastdropPaths;
let item: (service: string, account: string) => string;
beforeEach(() => {
  home = makeTestHome("lastdrop-keys-");
  paths = lastdropPaths({
    home: home.paths.home,
    dataDir: home.paths.dataDir,
    security: fakeSecurity(home.root),
  });
  item = (service, account) =>
    `${home.root}/store/${Buffer.from(`${service}/${account}`).toString("hex")}`;
});
afterEach(() => home.remove());

const onMacOS = NodeFS.existsSync("/usr/bin/plutil");

describe("setting and clearing a key", () => {
  it("stores what the reader and the key helper decode, and clears it", async () => {
    // A key with a quote, spaces and a non-ASCII character survives the keychain's base64 and the shell.
    const key = `sk-"a b"-é$x`;
    expect(await setEndpointKey(paths, "zai", `  ${key}  `)).toBe(true);
    expect(NodeFS.existsSync(item("t3code-lastdrop", "zai-api-key"))).toBe(true);
    expect(await endpointApiKey("zai", paths)).toBe(key);
    expect(await lookupEndpointKey("zai", paths)).toEqual({ state: "found", key });
    expect(await lookupEndpointKey("openrouter", paths)).toEqual({ state: "missing" });
    expect((await endpointKeyStatus(paths)).map((s) => [s.provider, s.place])).toEqual([
      ["zai", "own"],
      ["openrouter", "none"],
    ]);

    if (onMacOS) {
      await prepareEndpointProfile({ paths, provider: "zai" });
      const run = NodeChildProcess.spawnSync(keyHelperPath(paths), ["zai"], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(run.stdout).toBe(`${key}\n`);
    }

    // Setting again replaces it.
    expect(await setEndpointKey(paths, "zai", "second")).toBe(true);
    expect(await endpointApiKey("zai", paths)).toBe("second");

    expect(await clearEndpointKey(paths, "zai")).toBe(true);
    expect(await lookupEndpointKey("zai", paths)).toEqual({ state: "missing" });
    // Clearing what isn't there is fine.
    expect(await clearEndpointKey(paths, "zai")).toBe(true);
  });

  it("refuses an empty key and a keychain it can't write", async () => {
    expect(await setEndpointKey(paths, "openrouter", "   ")).toBe(false);
    NodeFS.writeFileSync(`${home.root}/store-locked`, "");
    expect(await setEndpointKey(paths, "openrouter", "k")).toBe(false);
    expect(await clearEndpointKey(paths, "openrouter")).toBe(false);
    expect((await endpointKeyStatus(paths))[1]!.place).toBe("unreadable");
  });

  it("tells a key from the environment or file apart from the fork's own", async () => {
    expect((await endpointKeyStatus(paths, { OPENROUTER_API_KEY: "env" }))[1]!.place).toBe("other");
    home.write(`${paths.home}/.config/zai/key.json`, { apiKey: "file" });
    expect((await endpointKeyStatus(paths))[0]!.place).toBe("other");
    await setEndpointKey(paths, "zai", "own");
    expect((await endpointKeyStatus(paths))[0]!.place).toBe("own");
  });
});

describe("importing from the lastdrop app", () => {
  const appItem = (service: string, account: string, value: string) =>
    NodeFS.writeFileSync(item(service, account), Buffer.from(value).toString("base64"));

  it("copies a key once, only for a provider the fork has none for", async () => {
    appItem("lastdrop", "zai-api-key", "app-zai");
    appItem("Headroom", "openrouter-api-key", "old-app-or");
    appItem("lastdrop", "zai-session", "web-session");
    expect(await importableEndpointKeys(paths)).toEqual(["zai", "openrouter"]);

    await setEndpointKey(paths, "openrouter", "mine");
    expect(await importableEndpointKeys(paths)).toEqual(["zai"]);

    expect(await importEndpointKeys(paths)).toEqual(["zai"]);
    expect(await endpointApiKey("zai", paths)).toBe("app-zai");
    // The fork's own key stays, the app's session isn't copied, and the app's items are untouched.
    expect(await endpointApiKey("openrouter", paths)).toBe("mine");
    expect(NodeFS.existsSync(item("t3code-lastdrop", "zai-session"))).toBe(false);
    expect(NodeFS.existsSync(item("lastdrop", "zai-api-key"))).toBe(true);

    // Done for good: a key cleared later, or one the app gains, isn't offered again.
    await clearEndpointKey(paths, "zai");
    appItem("lastdrop", "openrouter-api-key", "new-app-or");
    expect(await importableEndpointKeys(paths)).toEqual([]);
    expect(await importEndpointKeys(paths)).toEqual([]);
  });

  it("offers nothing when the app has no key, and nothing while a fallback has one", async () => {
    expect(await importableEndpointKeys(paths)).toEqual([]);
    appItem("lastdrop", "zai-api-key", "app-zai");
    expect(await importableEndpointKeys(paths, { ZAI_API_KEY: "env" })).toEqual([]);
  });
});
