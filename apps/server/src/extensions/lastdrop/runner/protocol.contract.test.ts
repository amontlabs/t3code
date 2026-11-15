/**
 * Pins the lines the fork's runner writes against what lastdrop's Claude Code plugin reads
 * (`ClaudePlugin/lastdrop/hooks/register.tsx` in the standalone repo, with `AgentRun.swift` and
 * `AgentCatalog.pluginLine`). The `plugin*` functions below restate the plugin's parsing; if the plugin
 * changes how it reads a line, change them with it, then the runner.
 */
import { assert, describe, it } from "@effect/vitest";

import { RUNNER_SCRIPT } from "./endpoint.ts";
import { catalogLine, parseRunRequest, stepFields, type RunnerLine } from "./protocol.ts";
import { fakeCatalog } from "./testkit.ts";

/** Every flag the plugin passes to its runner (`$.process.spawn`/`run` with `runner($)`). */
const PLUGIN_FLAGS = [
  "--agent-catalog",
  "--agent-run",
  "--agent-warm",
  "--agent-route",
  "--agent-stop",
  "--agent-selftest",
  "--agent-open",
  "--delegate-note",
  "--agents",
];

/** `syncCatalog`: the fields it reads, and how. */
const pluginCatalog = (line: Record<string, unknown>) => ({
  nativeTasks: line.nativeTasks === true,
  agentModels: line.agentModels === true,
  t3Instance: line.t3Instance === true,
  delegateNotes: line.delegateNotes === true,
  revision: line.revision as number | undefined,
  saveClaude: line.saveClaude === true,
  agents: (line.agents ?? []) as Array<{
    name: string;
    description: string;
    provider: string;
    summary: string;
    prompt: string;
  }>,
});

/** `start()`: reads until `started`, collecting `moved`/`step`. */
const pluginStart = (lines: ReadonlyArray<RunnerLine>) => {
  const early: RunnerLine[] = [];
  for (const line of lines) {
    if (line.type === "moved" || line.type === "step") early.push(line);
    if (line.type === "no_room") return { noRoom: true } as const;
    if (line.type === "native") return { native: true } as const;
    if (line.type === "started") return { line, early } as const;
    if (line.type === "error" || line.type === "result") {
      return { error: String(line.text ?? "lastdrop could not start the agent.") } as const;
    }
  }
  return { error: "lastdrop’s runner ended before the agent started." } as const;
};

/** `admission()`: one line, `routed` or `no_room`, else its text is the error. */
const pluginAdmission = (line: RunnerLine | undefined) => {
  if (line?.type === "routed" || line?.type === "no_room") return line.type;
  throw new Error(String(line?.text ?? "lastdrop’s routing check ended without an answer."));
};

/** The line types `remoteTurn` and `record` act on after `started`. */
const AFTER_START = new Set([
  "step",
  "moved",
  "tick",
  "item",
  "result",
  "error",
  "native",
  "started",
]);

describe("the plugin's runner protocol", () => {
  it("the script answers every flag the plugin passes", () => {
    for (const flag of PLUGIN_FLAGS) assert.include(RUNNER_SCRIPT, flag, flag);
  });

  it("the catalog line reads as the standalone app's", () => {
    const read = fakeCatalog();
    const line = catalogLine(read.agents, read.extras);
    // One JSON object on one line, as `JSON.parse(text.trim())` reads it.
    const parsed = JSON.parse(JSON.stringify(line)) as Record<string, unknown>;
    const seen = pluginCatalog(parsed);
    assert.isTrue(seen.nativeTasks, "admission() throws without nativeTasks");
    assert.isTrue(seen.agentModels, "types are registered only with agentModels");
    assert.isFalse(
      seen.t3Instance,
      "the fork's instance is lastdropAgents, not the plugin's `lastdrop`",
    );
    assert.isFalse(seen.delegateNotes, "the fork routes Claude children itself");
    assert.strictEqual(seen.revision, 7);
    assert.isTrue(seen.saveClaude);
    assert.strictEqual(parsed.saveClaudeText, "Delegate first.");
    assert.deepStrictEqual(seen.agents, [
      {
        name: "review",
        description: "Code reviews.",
        provider: "codex",
        summary: "Codex · gpt-6.1-sol, then Claude · opus",
        prompt: "",
      },
      {
        name: "build",
        description: "Implementation.",
        provider: "antigravity",
        summary: "Antigravity · claude-sonnet-5-5",
        prompt: "",
      },
    ]);
  });

  it("a revision is a number even when the file has none", () => {
    const read = fakeCatalog();
    const a = catalogLine(read.agents, { ...read.extras, revision: undefined });
    const b = catalogLine(read.agents, { ...read.extras, revision: undefined });
    assert.isNumber(a.revision);
    assert.strictEqual(a.revision, b.revision);
  });

  it("a run's lines start, step, tick and end as the plugin reads them", () => {
    const review = fakeCatalog().agents[0]!;
    const run: ReadonlyArray<RunnerLine> = [
      { type: "started", agentId: "a1", ...stepFields(review.chain[0]!), childThreadId: "c" },
      { type: "step", text: "Bash: ls" },
      { type: "tick" },
      { type: "result", text: "ok", isError: false, ...stepFields(review.chain[0]!) },
    ];
    const begun = pluginStart(run);
    assert.isTrue("line" in begun);
    if (!("line" in begun)) return;
    // remoteTurn refuses a runner that doesn't keep the agent id.
    assert.strictEqual(String(begun.line.agentId), "a1");
    // started(): account, model and provider are strings.
    assert.strictEqual(begun.line.account, "Codex");
    assert.strictEqual(begun.line.model, "gpt-6.1-sol");
    assert.strictEqual(begun.line.provider, "codex");
    for (const line of run.slice(1)) assert.isTrue(AFTER_START.has(line.type), line.type);
    const result = run.at(-1)!;
    assert.isString(result.text);
    assert.isBoolean(result.isError);
  });

  it("errors before the start reach the plugin as its error", () => {
    assert.deepStrictEqual(pluginStart([{ type: "error", text: "No agent x is enabled." }]), {
      error: "No agent x is enabled.",
    });
    assert.deepStrictEqual(pluginStart([{ type: "no_room" }]), { noRoom: true });
  });

  it("route lines are routed, no_room or an error with its text", () => {
    assert.strictEqual(pluginAdmission({ type: "routed" }), "routed");
    assert.strictEqual(pluginAdmission({ type: "no_room" }), "no_room");
    assert.throws(() => pluginAdmission({ type: "error", text: "off" }), "off");
  });

  it("reads the plugin's request as AgentRun.Request does", () => {
    const request = parseRunRequest(
      JSON.stringify({
        prompt: "p",
        description: "d",
        subagentType: "general-purpose",
        effort: "high",
        cwd: "/repo",
        permissionMode: "auto",
        parentModel: "claude-opus-5-5",
        agent: "review",
        id: "a1b2",
        isolation: "worktree",
      }),
    );
    assert.deepInclude(request, {
      prompt: "p",
      agent: "review",
      id: "a1b2",
      isolation: "worktree",
    });
    assert.deepStrictEqual(parseRunRequest("{}"), {
      type: "result",
      text: "lastdrop couldn't read the subagent request.",
      isError: true,
    });
    assert.deepStrictEqual(parseRunRequest(JSON.stringify({ prompt: "", cwd: "/", id: "a b" })), {
      type: "error",
      text: "lastdrop received an invalid native agent id.",
    });
  });
});
