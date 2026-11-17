// @effect-diagnostics nodeBuiltinImport:off - Temporary catalog files.
/**
 * The catalog in the standalone app's format (`AgentCatalog.swift`, `AgentModelCache.swift`), the
 * model list it gives (`ACPServer.modelOptions`, `efforts(for:)`, `modelMeta`) and each entry's
 * selection (`resolveEffort`). Cases follow the standalone app's tests where they exist.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ServerProviderModel, type ServerProviderModel as Model } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  agentDescription,
  agentEfforts,
  agentModels,
  allAgents,
  closestEffort,
  fallbackThreads,
  modelName,
  parseCatalog,
  parseModelEfforts,
  stepSelection,
} from "./catalog.ts";
import { makeCatalogSource } from "./catalogSource.ts";

/** The real catalog's shape (2026-11-14), ids and texts shortened. */
const CATALOG = {
  revision: 37,
  saveClaude: false,
  agents: [
    {
      id: "00000000-0000-0000-0000-000000000001",
      name: "build",
      description: "Implementation and fixes in this repo, one topic per agent.",
      provider: "antigravity",
      model: "claude-sonnet-5-5",
      enabled: true,
      fallbacks: [{ provider: "claude", model: "sonnet" }],
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      name: "review",
      description: "Code reviews.",
      provider: "codex",
      model: "gpt-6.1-sol",
      enabled: true,
      icon: "eye",
      color: "violet",
      fallbacks: [
        { provider: "antigravity", model: "claude-opus-5-5" },
        { provider: "claude", model: "opus" },
      ],
    },
    {
      id: "00000000-0000-0000-0000-000000000003",
      name: "judge",
      description: "Judgement.",
      provider: "claude",
      model: "fable",
      effort: "high",
      enabled: true,
    },
    {
      id: "00000000-0000-0000-0000-000000000004",
      name: "cheap",
      description: "Cheap work.",
      provider: "zai",
      model: "glm-5.3-flash",
      enabled: true,
      fallbacks: [{ provider: "antigravity", model: "gemini-3.8-flash" }],
    },
    {
      id: "00000000-0000-0000-0000-000000000005",
      name: "off",
      description: "Disabled.",
      provider: "codex",
      model: "gpt-6.1-terra",
      enabled: false,
    },
    {
      id: "00000000-0000-0000-0000-000000000006",
      name: "sonnet",
      description: "A reserved name: Claude's own model wins.",
      provider: "codex",
      model: "gpt-6.1-terra",
      enabled: true,
    },
    {
      id: "bad",
      name: "broken",
      description: "Unknown provider.",
      provider: "x",
      model: "m",
      enabled: true,
    },
  ],
};

/** `agent-models.json` as the standalone app writes it (dates in seconds). */
const MODELS = {
  antigravity: {
    updated: 1794671491.4475,
    models: [
      { id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"] },
      { id: "claude-opus-5-5", efforts: ["low", "medium", "high"] },
      { id: "gemini-3.8-flash", efforts: ["low", "medium", "high"] },
      { id: "gemini-pro-orchestrator-g1-pro", efforts: [] },
    ],
  },
};

const decodeModel = Schema.decodeSync(ServerProviderModel);
const effortOf = (models: ReadonlyArray<Model>, slug: string) =>
  models
    .find((model) => model.slug === slug)
    ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "effort");

describe("lastdrop agent catalog", () => {
  const agents = allAgents(parseCatalog(CATALOG));
  const known = parseModelEfforts(MODELS);
  const models = agentModels(agents, known);

  it("reads the standalone format: enabled agents after Claude's own models", () => {
    assert.deepEqual(
      models.map((model) => model.slug),
      ["fable", "opus", "sonnet", "haiku", "build", "review", "judge", "cheap"],
    );
    for (const model of models) decodeModel(model);
    const build = agents.find((agent) => agent.name === "build")!;
    assert.deepEqual(
      build.chain.map((step) => [step.instanceId, step.model]),
      [
        ["antigravity", "claude-sonnet-5-5"],
        ["claudeAgent", "sonnet"],
      ],
    );
    const cheap = agents.find((agent) => agent.name === "cheap")!;
    assert.equal(cheap.chain[0]!.instanceId, "zai");
  });

  it("gives each agent's model its look, its chain and the threads on a fallback entry", () => {
    const review = agents.find((agent) => agent.name === "review")!;
    const [codex, antigravity, claude] = review.chain.map(
      (step) => `${step.instanceId}/${step.model}/${step.effort ?? ""}`,
    );
    // Oldest first, as the entry map keeps them; t2 moved back to its first entry later.
    const onFallback = fallbackThreads(agents, [
      ["n1", { entry: antigravity!, agent: "review", appThreadId: "t1" }],
      ["n2", { entry: claude!, agent: "review", appThreadId: "t2" }],
      ["n3", { entry: codex!, agent: "review", appThreadId: "t2" }],
      ["n4", { entry: "gone/x/", agent: "review", appThreadId: "t3" }],
      ["n5", { entry: antigravity! }],
    ]);
    assert.deepEqual([...onFallback], [["review", { t1: 1 }]]);
    const look = agentModels(agents, known, onFallback).find((model) => model.slug === "review")!;
    decodeModel(look);
    assert.deepEqual(look.lastdropAgent, {
      icon: "eye",
      color: "violet",
      chain: [
        { instanceId: "codex", model: "gpt-6.1-sol" },
        { instanceId: "antigravity", model: "claude-opus-5-5" },
        { instanceId: "claudeAgent", model: "opus" },
      ],
      fallbackThreads: { t1: 1 },
    });
    assert.deepEqual(models.find((model) => model.slug === "judge")!.lastdropAgent, {
      chain: [{ instanceId: "claudeAgent", model: "fable", effort: "high" }],
    });
  });

  it("names and describes models as the standalone ACP provider does", () => {
    const name = (slug: string) => models.find((model) => model.slug === slug)!.name;
    assert.equal(name("build"), "build · Antigravity Claude Sonnet 5.5");
    assert.equal(name("judge"), "judge · Claude Fable 5.2");
    assert.equal(name("review"), "review · Codex GPT-6.1 Sol");
    assert.equal(name("cheap"), "cheap · Z.ai glm-5.3-flash");
    assert.equal(name("opus"), "Claude Opus 5.5");
    assert.equal(models.find((model) => model.slug === "review")!.subProvider, "Codex");
    assert.equal(
      agentDescription(agents.find((agent) => agent.name === "review")!),
      "Code reviews. (Codex · gpt-6.1-sol, then Antigravity · claude-opus-5-5, then Claude · opus)",
    );
    assert.equal(modelName("gemini-3.8-flash"), "Gemini 3.8 Flash");
    assert.equal(modelName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
  });

  it("offers efforts every entry of the chain takes; a fixed-effort agent offers none", () => {
    const levels = (slug: string) =>
      (
        effortOf(models, slug) as { options: ReadonlyArray<{ id: string }> } | undefined
      )?.options.map((option) => option.id);
    // Antigravity's Sonnet listed low/medium/high; Claude takes them all.
    assert.deepEqual(levels("build"), ["low", "medium", "high"]);
    // Codex is not in the cache: its caller levels, cut by Antigravity's Opus.
    assert.deepEqual(levels("review"), ["low", "medium", "high"]);
    // Z.ai takes low/high/max; Gemini Flash low/medium/high: low and high.
    assert.deepEqual(levels("cheap"), ["low", "high"]);
    assert.isUndefined(effortOf(models, "judge"));
    assert.deepEqual(levels("opus"), ["low", "medium", "high", "xhigh", "max"]);
    // A first entry that takes no effort gives no option.
    const orchestrator = allAgents(
      parseCatalog({
        agents: [
          {
            name: "orch",
            description: "x",
            provider: "antigravity",
            model: "gemini-pro-orchestrator-g1-pro",
            enabled: true,
          },
        ],
      }),
    ).at(-1)!;
    assert.isUndefined(agentEfforts(orchestrator, known));
  });

  it("gives each entry its own model and the closest effort it offers", () => {
    const build = agents.find((agent) => agent.name === "build")!;
    const outer = {
      instanceId: "lastdropAgents",
      model: "build",
      options: [{ id: "effort", value: "xhigh" }],
    } as never;
    const antigravityModels: ReadonlyArray<Model> = [
      {
        slug: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
    ];
    // Antigravity's own option id, at its closest level.
    assert.deepEqual(stepSelection(build.chain[0]!, outer, antigravityModels), {
      instanceId: "antigravity",
      model: "claude-sonnet-5-5",
      options: [{ id: "thought_level", value: "high" }],
    } as never);
    // Claude without a published list: its own option id, the level as asked.
    assert.deepEqual(stepSelection(build.chain[1]!, outer), {
      instanceId: "claudeAgent",
      model: "sonnet",
      options: [{ id: "effort", value: "xhigh" }],
    } as never);
    // A fixed effort wins over the run's.
    const judge = agents.find((agent) => agent.name === "judge")!;
    assert.deepEqual(stepSelection(judge.chain[0]!, outer), {
      instanceId: "claudeAgent",
      model: "fable",
      options: [{ id: "effort", value: "high" }],
    } as never);
    assert.equal(closestEffort("xhigh", ["low", "medium"]), "medium");
    assert.equal(closestEffort("minimal", ["low", "high"]), "low");
    assert.isUndefined(closestEffort("turbo", ["low"]));
  });

  it("reloads live and keeps the last good list when the file breaks", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-catalog-"));
    const files = {
      catalog: NodePath.join(dir, "agent-catalog.json"),
      models: NodePath.join(dir, "agent-models.json"),
    };
    const write = (json: unknown) => NodeFS.writeFileSync(files.catalog, JSON.stringify(json));
    try {
      const source = makeCatalogSource({ files });
      assert.equal(source.current().agents.length, 4);
      assert.isUndefined(source.current().problem);
      write({ revision: 1, agents: [CATALOG.agents[0]] });
      assert.isTrue(source.reloadIfChanged());
      assert.deepEqual(
        source.current().agents.map((agent) => agent.name),
        ["fable", "opus", "sonnet", "haiku", "build"],
      );
      assert.isFalse(source.reloadIfChanged());
      NodeFS.writeFileSync(files.catalog, "{ not json");
      assert.isTrue(source.reloadIfChanged());
      assert.equal(source.current().agents.at(-1)!.name, "build");
      assert.isDefined(source.current().problem);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
