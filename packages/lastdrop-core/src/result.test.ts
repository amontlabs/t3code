// Ported from headroom Tests/LastDropTests/SubagentTests.swift: the cases on Claude Code's result event
// (see PORTING.md).
import { describe, expect, it } from "vite-plus/test";

import { parseClaudeResult } from "./result.ts";

describe("Claude Code's result event", () => {
  it("native usage keeps the cache counts separate", () => {
    const result = parseClaudeResult({
      type: "result",
      result: "report",
      usage: {
        input_tokens: 30,
        output_tokens: 10,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
      },
    });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(10);
    expect(result.cacheReadInputTokens).toBe(50);
    expect(result.cacheCreationInputTokens).toBe(20);
  });

  it("parses Claude Code's result", () => {
    const ok = parseClaudeResult({
      type: "result",
      is_error: false,
      result: "HELLO",
      num_turns: 2,
      permission_denials: [],
      duration_ms: 1200,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(ok.text).toBe("HELLO");
    expect(ok.isError).toBe(false);
    expect(ok.durationMs).toBe(1200);
    expect(ok.outputTokens).toBe(5);
    const limit = parseClaudeResult({
      is_error: true,
      result: "Claude AI usage limit reached",
      api_error_status: 429,
      num_turns: 1,
    });
    expect(limit.limitReached).toBe(true);
    const model = parseClaudeResult({
      is_error: true,
      result:
        "Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
      api_error_status: 429,
    });
    expect(model.modelUnavailable).toBe(true);
    expect(model.limitReached).toBe(false);
  });

  it("a usage limit reads from Claude Code's api_error", () => {
    const limit = parseClaudeResult({
      is_error: true,
      result: "You've hit your weekly limit",
      api_error: "usage_limit_reached",
    });
    expect(limit.limitReached).toBe(true);
  });

  it("Claude Code's limit messages read as limits", () => {
    for (const text of [
      "You've hit your session limit · resets 10:40pm (Europe/Paris)",
      "You've hit your weekly limit · resets 5am",
      "You've hit your Opus limit",
      "You've hit your limit",
    ]) {
      expect(parseClaudeResult({ is_error: true, result: text }).limitReached, text).toBe(true);
    }
    expect(parseClaudeResult({ is_error: true, result: "You've hit a snag" }).limitReached).toBe(
      false,
    );
  });
});
