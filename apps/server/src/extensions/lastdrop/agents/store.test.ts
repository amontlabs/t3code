// @effect-diagnostics nodeBuiltinImport:off - The map's file in a temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { makeStoredMap } from "./store.ts";

describe("a stored map", () => {
  it("keeps another server's entries when it writes, and its own deletions", () => {
    const file = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-store-")),
      "agent-runs.json",
    );
    const one = makeStoredMap<string>();
    const two = makeStoredMap<string>();
    one.attach(file);
    two.attach(file);
    one.set("a", "from one");
    two.set("b", "from two");
    one.set("c", "from one");
    one.delete("a");
    const stored = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, string>;
    assert.deepStrictEqual(stored, { b: "from two", c: "from one" });
    assert.deepStrictEqual(
      one.entries().map(([key]) => key),
      ["b", "c"],
    );
  });
});
