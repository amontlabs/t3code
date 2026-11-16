import { describe, expect, it } from "vite-plus/test";

import {
  blankAgent,
  changeEntry,
  draftProblem,
  moveItem,
  withAgent,
  withEnabled,
  withoutAgent,
  type AgentRecord,
  type ProviderChoice,
} from "./agentsView";

const providers: ReadonlyArray<ProviderChoice> = [
  {
    provider: "claude",
    label: "Claude",
    available: false,
    models: [{ id: "opus", name: "Opus", efforts: ["low", "high"] }],
    efforts: ["low", "medium", "high"],
  },
  {
    provider: "codex",
    label: "Codex",
    available: true,
    models: [{ id: "gpt-6.1-sol", name: "Sol", efforts: [] }],
    efforts: ["low", "high"],
  },
];

const build: AgentRecord = {
  id: "A1",
  name: "build",
  description: "",
  enabled: true,
  provider: "codex",
  model: "gpt-6.1-sol",
  fallbacks: [{ provider: "claude", model: "opus" }],
};

describe("editing the agents", () => {
  it("starts on a provider that can run, and checks the draft like the server", () => {
    expect(blankAgent(providers).provider).toBe("codex");
    expect(draftProblem({ ...build, name: "a b" }, [])).toContain("Name");
    expect(draftProblem({ ...build, name: "Build" }, [build])).toContain("Another agent");
    expect(draftProblem({ ...build, name: "opus" }, [])).toContain("Claude Code");
    expect(
      draftProblem({ ...build, fallbacks: [{ provider: "claude", model: " " }] }, []),
    ).toContain("model");
    expect(draftProblem(build, [])).toBeUndefined();
  });

  it("clears an effort the new model does not take, and keeps one it does", () => {
    const high = { provider: "claude", model: "opus", effort: "high" } as const;
    expect(changeEntry(providers, high, { model: "opus" }).effort).toBe("high");
    expect(
      changeEntry(providers, high, { provider: "codex", model: "gpt-6.1-sol" }).effort,
    ).toBeUndefined();
    // A model typed by hand takes the provider's levels.
    expect(changeEntry(providers, high, { model: "claude-x" }).effort).toBe("high");
  });

  it("adds, replaces, toggles and removes, and reorders fallbacks", () => {
    expect(withAgent([build], { ...build, id: "", name: " new " }).map((a) => a.name)).toEqual([
      "build",
      "new",
    ]);
    expect(withAgent([build], { ...build, description: "x" })[0]!.description).toBe("x");
    expect(withEnabled([build], "A1", false)[0]!.enabled).toBe(false);
    expect(withoutAgent([build], "A1")).toEqual([]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});
