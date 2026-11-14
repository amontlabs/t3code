// The wrapper's assumptions about T3's Claude adapter, pinned so an upstream change fails here, loudly,
// instead of silently routing nothing (plan §6, risk 3). When one fails after a sync: read what upstream
// changed, adapt `queryRunner.ts` (never the adapter), then update the pin.
// @effect-diagnostics nodeBuiltinImport:off - reads T3's own sources to pin the seam.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { identityOf, withIdentity } from "./queryRunner.ts";

const here = NodePath.dirname(new URL(import.meta.url).pathname);
const source = (relative: string) => NodeFS.readFileSync(NodePath.join(here, relative), "utf8");

// Type-level pins: a method or field added, renamed or removed upstream breaks the typecheck here.
const runnerMethods: Record<keyof ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape, true> = {
  allocateSessionId: true,
  open: true,
  forkSession: true,
  subagentLaunchToolUseId: true,
  assertComplete: true,
};
const openFields: Record<keyof ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput, true> = {
  options: true,
  threadId: true,
  providerSessionId: true,
};
const forkFields: Record<keyof ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput, true> = {
  sessionId: true,
  options: true,
  environment: true,
  threadId: true,
  providerSessionId: true,
};
const lookupFields: Record<keyof ClaudeAdapterV2.ClaudeAgentSdkSubagentLookupInput, true> = {
  sessionId: true,
  agentId: true,
  dir: true,
  threadId: true,
  providerSessionId: true,
};
// The session methods the wrapper replaces must stay on the session.
type Session = ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
const sessionMethods: Pick<
  Record<keyof Session, true>,
  "messages" | "offer" | "interrupt" | "close"
> = {
  messages: true,
  offer: true,
  interrupt: true,
  close: true,
};

const selection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-haiku-4-5",
} satisfies ModelSelection;
const settings = Schema.decodeSync(ClaudeSettings)({});

describe("the wrapper's contract with T3's Claude adapter", () => {
  it("the runner and its inputs have the shape the wrapper wraps", () => {
    assert.lengthOf(Object.keys(runnerMethods), 5);
    assert.lengthOf(Object.keys(openFields), 3);
    assert.lengthOf(Object.keys(forkFields), 5);
    assert.lengthOf(Object.keys(lookupFields), 5);
    assert.lengthOf(Object.keys(sessionMethods), 4);
  });

  it("a new thread opens with `sessionId`, a resumed one with `resume`, a rewind adds `resumeSessionAt`", () => {
    const fresh = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: selection,
      nativeThreadId: "native-1",
      resume: false,
      cwd: "/workspace",
      settings,
      environment: { PATH: "/bin" },
    });
    assert.deepEqual(identityOf(fresh), { sessionId: "native-1" });
    // The environment the runner gives Claude Code is `options.env` (the wrapper sets the account's there).
    assert.deepEqual(fresh.env, { PATH: "/bin" });
    assert.isString(fresh.model);

    const resumed = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: selection,
      nativeThreadId: "native-1",
      resume: true,
      resumeSessionAt: "msg-1",
      cwd: "/workspace",
      settings,
    });
    assert.deepEqual(identityOf(resumed), { resume: "native-1", resumeSessionAt: "msg-1" });

    // A move: the SDK takes `sessionId` beside `resume` once `forkSession` is set; nothing else changes.
    const moved = withIdentity(
      resumed,
      { resume: "native-1", forkSession: true, sessionId: "new-1" },
      { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/a" },
    ) as unknown as Record<string, unknown>;
    assert.equal(moved["resume"], "native-1");
    assert.equal(moved["sessionId"], "new-1");
    assert.equal(moved["forkSession"], true);
    assert.isUndefined(moved["resumeSessionAt"]);
    assert.deepEqual(moved["env"], { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/a" });
    assert.equal(moved["model"], resumed.model);
  });

  it("every Claude query still opens through the wrapped runner layer", () => {
    const seam = source("../../provider/ProviderOrchestrationAdapterInfrastructure.ts");
    assert.include(seam, "Extensions.wrapClaudeQueryRunner(ClaudeAdapterV2.layerQueryRunner)");
  });

  it("the adapter still shows an `informational` notice and a result's `errors` in the thread", () => {
    const adapter = source("../../orchestration-v2/Adapters/ClaudeAdapterV2.ts");
    // The wrapper's notices are `system`/`informational` messages with level "notice": a system_notice item.
    assert.include(adapter, '(message.subtype === "informational" && message.level !== "info")');
    assert.include(adapter, 'type: "system_notice"');
    // A failed result's first `errors` entry is the turn's failure message.
    assert.match(adapter, /function resultUserFacingError[\s\S]{0,400}errors\.find\(/u);
    // The native id T3 passes is the one the wrapper translates: `resume`/`sessionId` from nativeThreadId.
    assert.include(adapter, "? { resume: input.nativeThreadId }");
    // T3's own forks go through the runner (so their ids are translated too).
    assert.include(adapter, "queryRunner.forkSession({");
    assert.include(adapter, ".subagentLaunchToolUseId({");
  });
});
