import { describe, expect, it } from "vite-plus/test";

import {
  accountTitle,
  endpointMeters,
  endpointStatus,
  type EndpointView,
  signInLabel,
  usedLabel,
} from "./accountsView";

describe("the accounts section", () => {
  it("names accounts and words their state", () => {
    expect(accountTitle({ key: "main" })).toBe("Main");
    expect(accountTitle({ key: "Pro" })).toBe("Pro");
    expect(accountTitle({ key: "Pro", name: "Work" })).toBe("Work");
    expect(usedLabel(undefined)).toBe("Unknown");
    expect(usedLabel(41.6)).toBe("42% used");
    expect(signInLabel({ signIn: "ok", signInEndsSoon: false })).toEqual({
      text: "Signed in",
      variant: "success",
    });
    expect(signInLabel({ signIn: "ok", signInEndsSoon: true }).variant).toBe("warning");
    expect(signInLabel({ signIn: "needsSignIn", signInEndsSoon: false }).text).toBe(
      "Needs sign-in",
    );
  });
});

describe("endpoints", () => {
  const base: EndpointView = {
    provider: "zai",
    title: "Z.ai",
    instanceId: "zai",
    configured: true,
    instance: "ours",
  };

  it("words where the provider stands for agents", () => {
    expect(endpointStatus({ ...base, configured: false }).text).toBe("No key");
    expect(endpointStatus({ ...base, problem: "management key" }).text).toBe("Can't run agents");
    expect(endpointStatus({ ...base, outUntil: 1 }).text).toBe("Out of room");
    expect(endpointStatus({ ...base, instance: "user" }).text).toBe("Your instance");
    expect(endpointStatus(base)).toEqual({ text: "Ready", variant: "success" });
  });

  it("shows only rows with a share used as meters", () => {
    const meters = endpointMeters({
      ...base,
      usage: {
        windows: [
          { label: "Session", usedPercent: 3 },
          { label: "Credits", detail: "$1" },
        ],
      },
    });
    expect(meters.map((w) => w.label)).toEqual(["Session"]);
  });
});
