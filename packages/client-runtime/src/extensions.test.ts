import {
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { withoutLastdropShadowSubagents, withoutLastdropShadowThreads } from "./extensions.ts";
import { v2Now, v2Projection, v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

// Ids as the server derives them for a lastdrop agent the fork's runner took over.
const parent = "2ccb3bdd-0791-4646-a1be-8d186d3b17a7";
const ids = (agentId: string) => ({
  nativeSubagent: `node:provider:claudeAgent:native-item:task%3A${agentId}`,
  nativeThread: `thread:provider:claudeAgent:native-thread:provider-thread%3Aprovider%3AclaudeAgent%3Anative-thread%3Apending%253Arun%253Athread%253A${parent}%253Aordinal%253A1%3A${agentId}`,
  delegated: `delegated-task:command%3Amcp%3Alastdrop-runner%253A${parent}%3Adelegate-task%3Alastdrop-runner%253A${agentId}`,
});
const routed = ids("a94c522ee496e68c8");
const plain = ids("b11111111111111111");

const decodeSubagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

const subagent = (id: string, childThreadId: string, native: string | null) =>
  decodeSubagent({
    id,
    threadId: parent,
    runId: null,
    parentNodeId: "node:run:root",
    origin: native === null ? "app_owned" : "provider_native",
    createdBy: "agent",
    driver: native === null ? "lastdropAgents" : "claudeAgent",
    providerInstanceId: native === null ? "lastdropAgents" : "claudeAgent",
    providerThreadId: null,
    childThreadId,
    nativeTaskRef:
      native === null ? null : { driver: "claudeAgent", nativeId: native, strength: "strong" },
    title: "Review",
    prompt: "Review",
    result: null,
    model: null,
    status: "running",
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
  });

const item = (subagentRow: OrchestrationV2Subagent, ordinal: number) =>
  decodeTurnItem({
    id: `turn-item:${subagentRow.id}`,
    threadId: parent,
    runId: null,
    nodeId: subagentRow.id,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "running",
    title: "Review",
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
    type: "subagent",
    subagentId: subagentRow.id,
    origin: subagentRow.origin,
    driver: subagentRow.driver,
    providerInstanceId: subagentRow.providerInstanceId,
    childThreadId: subagentRow.childThreadId,
    prompt: "Review",
    result: null,
  });

describe("lastdrop shadow subagents", () => {
  it("hides Claude's own subagent when the runner's delegated task runs the same agent", () => {
    const subagents = [
      subagent(routed.nativeSubagent, routed.nativeThread, "a94c522ee496e68c8"),
      subagent(`node:${routed.delegated}`, `thread:${routed.delegated}`, null),
      subagent(plain.nativeSubagent, plain.nativeThread, "b11111111111111111"),
    ];
    const turnItems = subagents.map((row, index) => item(row, index + 1));
    const projection = withoutLastdropShadowSubagents({
      ...v2Projection,
      subagents,
      turnItems,
      visibleTurnItems: turnItems.map((turnItem, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: ThreadId.make(parent),
        sourceItemId: turnItem.id,
        item: turnItem,
      })),
    });
    const shownIds = [subagents[1]!.id, subagents[2]!.id];
    expect(projection.subagents.map((row) => row.id)).toEqual(shownIds);
    expect(projection.turnItems.map((row) => row.type === "subagent" && row.subagentId)).toEqual(
      shownIds,
    );
    expect(
      projection.visibleTurnItems.map((row) => row.item.type === "subagent" && row.item.subagentId),
    ).toEqual(shownIds);
  });

  it("hides the Claude subagent's thread beside the delegated one", () => {
    const shell = (id: string): OrchestrationV2ThreadShell => ({
      ...v2ThreadShell,
      id: ThreadId.make(id),
      lineage: {
        rootThreadId: ThreadId.make(parent),
        parentThreadId: ThreadId.make(parent),
        relationshipToParent: "subagent",
      },
    });
    const threads = [
      shell(routed.nativeThread),
      shell(`thread:${routed.delegated}`),
      shell(plain.nativeThread),
    ];
    expect(withoutLastdropShadowThreads(threads).map((thread) => thread.id)).toEqual([
      `thread:${routed.delegated}`,
      plain.nativeThread,
    ]);
  });
});
