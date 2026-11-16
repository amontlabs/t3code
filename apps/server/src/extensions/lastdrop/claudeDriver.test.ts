// @effect-diagnostics nodeBuiltinImport:off - Reads T3's registry source to pin its last-driver-wins rule.
import * as NodeFS from "node:fs";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import { ClaudeDriver } from "../../provider/Drivers/ClaudeDriver.ts";
import { insulatedSnapshot, LastdropClaudeDriver } from "./claudeDriver.ts";

const snapshot = (overrides: Partial<ServerProvider>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.322",
  status: "error",
  auth: { status: "unauthenticated" },
  message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
  checkedAt: "2026-11-16T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("T3's Claude driver as lastdrop runs it", () => {
  // T3 hides Claude's models while its probe of Claude Code's own login reads signed out
  // (apps/web/src/providerInstances.ts `isProviderInstancePickerReady`).
  it("reads as signed in while a lastdrop account can take work, whatever Claude Code's own login says", () => {
    const signedOut = snapshot({});
    const insulated = insulatedSnapshot(signedOut, true);
    expect(insulated.status).toBe("ready");
    expect(insulated.auth).toEqual({
      status: "authenticated",
      type: "lastdrop",
      label: "lastdrop accounts",
    });
    expect(insulated.message).toBeUndefined();
    expect(insulatedSnapshot(signedOut, false)).toBe(signedOut);
    const notInstalled = snapshot({ installed: false });
    expect(insulatedSnapshot(notInstalled, true)).toBe(notInstalled);
    const signedIn = snapshot({ status: "ready", auth: { status: "authenticated" } });
    expect(insulatedSnapshot(signedIn, true)).toBe(signedIn);
  });

  // The fork's driver replaces T3's without a seam of its own: it comes last in the server's driver list, and the
  // registry keeps the last driver of a kind. If a sync breaks either, the Claude card is T3's again.
  it("is the Claude driver the server's registry keeps", () => {
    const claude = BUILT_IN_DRIVERS.filter((d) => d.driverKind === "claudeAgent");
    expect(claude).toEqual([ClaudeDriver, LastdropClaudeDriver]);
    const { create: _t3, ...t3 } = ClaudeDriver;
    const { create: _fork, ...fork } = LastdropClaudeDriver;
    expect({ ...fork, defaultConfig: fork.defaultConfig() }).toEqual({
      ...t3,
      defaultConfig: t3.defaultConfig(),
    });
    const registry = NodeFS.readFileSync(
      new URL("../../provider/ProviderInstanceRegistry.ts", import.meta.url),
      "utf8",
    );
    expect(registry).toContain(
      "new Map<ProviderDriverKind, AnyProviderDriver<R>>(\n    input.drivers.map((driver) => [driver.driverKind, driver]),",
    );
  });
});
