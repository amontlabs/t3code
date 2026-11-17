// @effect-diagnostics nodeBuiltinImport:off - The catalog files in a temporary folder.
/**
 * The fork's agent list: what a save validates and writes (`agents.json`, the app's catalog format),
 * the one-time import from the app's folder, and the source the driver reads. Temporary folders only.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseCatalog } from "./catalog.ts";
import { appCatalogFiles, readCatalogDocument, validateAgents } from "./catalogEdit.ts";
import {
  agentCatalogFiles,
  bindCatalogDir,
  boundCatalogFiles,
  makeCatalogSource,
} from "./catalogSource.ts";
import { makeAgentsEditor } from "./editor.ts";

const folder = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-editor-"));

const build = {
  name: "build",
  description: "Implementation.",
  enabled: true,
  provider: "antigravity",
  model: "claude-sonnet-5-5",
  fallbacks: [{ provider: "claude", model: "sonnet" }],
};

const APP_CATALOG = {
  revision: 37,
  saveClaude: true,
  judges: { zai: "glm-5.3" },
  agents: [{ id: "A1", ...build, futureKey: 1, color: "teal" }],
};

/** A home with the app's files, a fork folder, and an editor over them. */
const setup = (input: { readonly app: boolean }) => {
  const home = folder();
  const dataDir = NodePath.join(home, ".t3", "lastdrop");
  const files = agentCatalogFiles(dataDir);
  const app = appCatalogFiles(home);
  if (input.app) {
    NodeFS.mkdirSync(NodePath.dirname(app.catalog), { recursive: true });
    NodeFS.writeFileSync(app.catalog, JSON.stringify(APP_CATALOG));
    NodeFS.writeFileSync(
      app.models,
      JSON.stringify({ codex: { models: [{ id: "gpt-6.1-sol", efforts: ["low", "high"] }] } }),
    );
  }
  const editor = makeAgentsEditor({ files, app, models: () => Effect.undefined });
  return { home, files, app, editor, done: () => NodeFS.rmSync(home, { recursive: true }) };
};

describe("validating the agents a save sends", () => {
  it("refuses what the catalog could not run", () => {
    const refused = (agents: unknown) => {
      const result = validateAgents(agents);
      return result.ok ? undefined : result.error;
    };
    assert.include(refused([{ ...build, name: "has space" }]) ?? "", "name");
    assert.include(refused([{ ...build, name: "opus" }]) ?? "", "Claude Code");
    assert.include(refused([build, { ...build, name: "BUILD" }]) ?? "", "Two agents");
    assert.include(refused([{ ...build, provider: "gemini" }]) ?? "", "provider");
    assert.include(refused([{ ...build, model: "two words" }]) ?? "", "model");
    assert.include(refused([{ ...build, effort: "turbo" }]) ?? "", "effort");
    assert.include(
      refused([{ ...build, fallbacks: [{ provider: "claude", model: "" }] }]) ?? "",
      "fallback 1",
    );
    assert.include(refused({}) ?? "", "list");
    const ok = validateAgents([{ ...build, name: " build ", effort: "" }]);
    assert.isTrue(ok.ok);
    if (ok.ok) {
      assert.equal(ok.agents[0]!.name, "build");
      assert.isUndefined(ok.agents[0]!.effort);
      assert.isString(ok.agents[0]!.id);
    }
  });
});

describe("saving the agents", () => {
  it.effect(
    "round-trips through the file the driver parses, keeping what the editor does not know",
    () =>
      Effect.gen(function* () {
        const { files, app, editor, done } = setup({ app: true });
        try {
          yield* editor.importFromApp;
          const before = (yield* editor.view).agents;
          assert.equal(before[0]!.id, "A1");
          assert.equal(before[0]!.color, "teal");
          const { color: _color, ...uncolored } = before[0]!;
          const saved = yield* editor.save({
            agents: [
              { ...uncolored, description: "Changed", fallbacks: [], icon: "eye" },
              { ...build, name: "review", provider: "codex", model: "gpt-6.1-sol", effort: "high" },
            ],
            revision: 37,
          });
          assert.equal(saved.revision, 38);
          const written = JSON.parse(NodeFS.readFileSync(files.catalog, "utf8"));
          assert.equal(written.saveClaude, true);
          assert.deepEqual(written.judges, { zai: "glm-5.3" });
          assert.equal(written.agents[0].futureKey, 1);
          assert.notProperty(written.agents[0], "fallbacks");
          // A cleared color leaves the file; the new icon is written.
          assert.notProperty(written.agents[0], "color");
          assert.equal(written.agents[0].icon, "eye");
          assert.equal(parseCatalog(written)[0]!.icon, "eye");
          assert.deepEqual(
            parseCatalog(written).map((agent) => [
              agent.name,
              agent.description,
              agent.chain.length,
            ]),
            [
              ["build", "Changed", 1],
              ["review", "Implementation.", 2],
            ],
          );
          assert.equal(readCatalogDocument(files).agents[1]!.effort, "high");
          // The app's own file was only read.
          assert.deepEqual(JSON.parse(NodeFS.readFileSync(app.catalog, "utf8")), APP_CATALOG);
          assert.deepEqual(
            NodeFS.readdirSync(NodePath.dirname(files.catalog)).filter((name) =>
              name.endsWith(".tmp"),
            ),
            [],
          );
        } finally {
          done();
        }
      }),
  );

  it.effect("refuses a list that changed elsewhere, an invalid one, and a file it can't read", () =>
    Effect.gen(function* () {
      const { files, editor, done } = setup({ app: false });
      try {
        yield* editor.save({ agents: [build] });
        const stale = yield* Effect.flip(editor.save({ agents: [build], revision: 0 }));
        assert.equal(stale.status, 409);
        const invalid = yield* Effect.flip(editor.save({ agents: [{ ...build, model: "" }] }));
        assert.equal(invalid.status, 400);
        NodeFS.writeFileSync(files.catalog, "{ not json");
        const view = yield* editor.view;
        assert.include(view.problem ?? "", "isn't valid JSON");
        const broken = yield* Effect.flip(editor.save({ agents: [build] }));
        assert.equal(broken.status, 409);
        assert.equal(NodeFS.readFileSync(files.catalog, "utf8"), "{ not json");
      } finally {
        done();
      }
    }),
  );
});

describe("importing from the app", () => {
  it.effect("copies once, only while the fork has no agents", () =>
    Effect.gen(function* () {
      const { files, editor, done } = setup({ app: true });
      try {
        assert.isTrue((yield* editor.view).canImport);
        const imported = yield* editor.importFromApp;
        assert.isFalse(imported.canImport);
        assert.deepEqual(JSON.parse(NodeFS.readFileSync(files.catalog, "utf8")), APP_CATALOG);
        assert.isTrue(NodeFS.existsSync(files.models));
        const again = yield* Effect.flip(editor.importFromApp);
        assert.equal(again.status, 409);
      } finally {
        done();
      }
    }),
  );

  it.effect("offers nothing without the app, or once the fork has agents", () =>
    Effect.gen(function* () {
      const none = setup({ app: false });
      try {
        assert.isFalse((yield* none.editor.view).canImport);
        const refused = yield* Effect.flip(none.editor.importFromApp);
        assert.equal(refused.status, 409);
      } finally {
        none.done();
      }
      const some = setup({ app: true });
      try {
        yield* some.editor.save({ agents: [build] });
        assert.isFalse((yield* some.editor.view).canImport);
      } finally {
        some.done();
      }
    }),
  );
});

describe("the catalog source", () => {
  it.effect("reads the fork's file, an empty list while it is missing, and the bound folder", () =>
    Effect.gen(function* () {
      const { files, home, editor, done } = setup({ app: true });
      try {
        const source = makeCatalogSource({ files });
        assert.isUndefined(source.current().problem);
        assert.deepEqual(
          source.current().agents.map((agent) => agent.name),
          ["fable", "opus", "sonnet", "haiku"],
        );
        yield* editor.save({ agents: [build] });
        assert.isTrue(source.reloadIfChanged());
        assert.equal(source.current().agents.at(-1)!.name, "build");
        // The driver opens before the layer binds the folder, then follows it.
        const lazy = makeCatalogSource({ files: boundCatalogFiles });
        assert.equal(lazy.current().agents.length, 4);
        bindCatalogDir(NodePath.join(home, ".t3", "lastdrop"));
        try {
          assert.isTrue(lazy.reloadIfChanged());
          assert.equal(lazy.current().agents.at(-1)!.name, "build");
        } finally {
          bindCatalogDir(undefined);
        }
      } finally {
        done();
      }
    }),
  );
});
