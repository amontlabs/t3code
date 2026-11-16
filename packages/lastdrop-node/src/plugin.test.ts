import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installPlugin, pluginDirectory } from "./plugin.ts";
import { PLUGIN_FILES } from "./pluginFiles.generated.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

const vendored = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../lastdrop-plugin/lastdrop",
);

const filesBelow = (directory: string, prefix = ""): Array<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesBelow(NodePath.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );

let home: TestHome;
beforeEach(() => {
  home = makeTestHome();
});
afterEach(() => home.remove());

describe("the embedded plugin", () => {
  it("is the vendored folder (run scripts/lastdrop/sync-plugin.sh when this fails)", () => {
    expect(Object.keys(PLUGIN_FILES).toSorted()).toEqual(filesBelow(vendored).toSorted());
    for (const [path, contents] of Object.entries(PLUGIN_FILES)) {
      expect(NodeFS.readFileSync(NodePath.join(vendored, path), "utf8"), path).toBe(contents);
    }
    const manifest = JSON.parse(PLUGIN_FILES[".claude-plugin/plugin.json"]!) as { name: string };
    expect(manifest.name).toBe("lastdrop");
  });
});

describe("installPlugin", () => {
  it("writes the plugin under lastdrop's folder, keeps it current and drops stale files", async () => {
    const dataDir = home.paths.dataDir;
    const root = await installPlugin(dataDir);
    expect(root).toBe(pluginDirectory(dataDir));
    expect(root.startsWith(`${dataDir}/`)).toBe(true);
    for (const [path, contents] of Object.entries(PLUGIN_FILES)) {
      expect(NodeFS.readFileSync(NodePath.join(root, path), "utf8")).toBe(contents);
    }

    const manifest = NodePath.join(root, ".claude-plugin/plugin.json");
    NodeFS.writeFileSync(manifest, "changed");
    NodeFS.writeFileSync(NodePath.join(root, "hooks/old.tsx"), "stale");
    await installPlugin(dataDir);
    expect(NodeFS.readFileSync(manifest, "utf8")).toBe(PLUGIN_FILES[".claude-plugin/plugin.json"]);
    expect(NodeFS.existsSync(NodePath.join(root, "hooks/old.tsx"))).toBe(false);
  });
});
