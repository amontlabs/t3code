// Ported from headroom Tests/LastDropTests/EndpointBackendTests.swift (pure parts) and the Z.ai and OpenRouter
// usage mapping (ZAIProvider, OpenRouterProvider). The runner's environment and arguments become the T3
// instance's environment and launch arguments; the parse of a failed run becomes `endpointLimitReached` on
// T3's failure.
import { describe, expect, it } from "vite-plus/test";

import {
  checkInferenceKey,
  creditsWindow,
  endpointEnvironment,
  endpointInstance,
  endpointJudge,
  endpointLimitReached,
  endpointModels,
  endpointOutUntil,
  isManagementKey,
  MODEL_VARIABLES,
  openRouterBalance,
  openRouterKey,
  openRouterKeys,
  openRouterKeyUsage,
  openRouterModels,
  SCRUBBED_VARIABLES,
  shellQuote,
  zaiPlan,
  zaiWindows,
} from "./endpoints.ts";

const now = Date.UTC(2026, 10, 14, 12, 0, 0);
const minutes = (n: number) => n * 60_000;
const thresholds = { sessionThreshold: 0.9, weeklyThreshold: 0.9 };

describe("endpoint environment", () => {
  it("scrubs credentials and pins every model role", () => {
    const env = endpointEnvironment({ provider: "zai", model: "glm-5.3" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(""); // apiKeyHelper supplies the token at launch.
    for (const key of MODEL_VARIABLES) expect(env[key]).toBe("glm-5.3");
    expect(env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
    expect(env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe("glm-5.3");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(endpointEnvironment({ provider: "openrouter", model: "m" }).ANTHROPIC_BASE_URL).toBe(
      "https://openrouter.ai/api",
    );
  });

  it("has auto mode judged by the provider's strong model", () => {
    const flash = endpointEnvironment({ provider: "zai", model: "glm-5.3-flash" });
    expect(flash.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
    expect(flash.CLAUDE_CODE_AUTO_MODE_MODEL).toBe("glm-5.3");
    const routed = endpointEnvironment({ provider: "openrouter", model: "provider/model" });
    expect(routed.CLAUDE_CODE_AUTO_MODE_MODEL).toBe("provider/model");
  });

  it("uses the judge chosen in Settings", () => {
    expect(
      endpointEnvironment({ provider: "zai", model: "glm-5.3-flash", judge: "glm-5.4" })
        .CLAUDE_CODE_AUTO_MODE_MODEL,
    ).toBe("glm-5.4");
    expect(
      endpointEnvironment({
        provider: "openrouter",
        model: "provider/model",
        judge: "other/strong",
      }).CLAUDE_CODE_AUTO_MODE_MODEL,
    ).toBe("other/strong");
    expect(endpointJudge("openrouter", "provider/model")).toBe("provider/model");
    expect(endpointJudge("zai", "glm-5.3-flash")).toBe("glm-5.3");
  });

  it("leaves the roles alone without a model, and OpenRouter's judge with them", () => {
    const env = endpointEnvironment({ provider: "openrouter", model: undefined });
    for (const key of MODEL_VARIABLES) expect(env[key]).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
    expect(
      endpointEnvironment({ provider: "zai", model: undefined }).CLAUDE_CODE_AUTO_MODE_MODEL,
    ).toBe("glm-5.3");
  });
});

describe("endpoint instance", () => {
  it("is a Claude instance in its own profile, labelled lastdrop's, with no key in it", () => {
    const { instanceId, instance } = endpointInstance({
      provider: "zai",
      home: "/h/.t3/lastdrop/endpoints/zai",
      sessionSettings: "/h/.t3/lastdrop/endpoints/zai/session-settings.json",
      model: "glm-5.3-flash",
      models: endpointModels("zai", ["glm-5.3-flash"]),
    });
    expect(instanceId).toBe("zai");
    expect(instance.driver).toBe("claudeAgent");
    expect(instance.displayName).toBe("Z.ai (lastdrop)");
    expect(instance.config.homePath).toBe("/h/.t3/lastdrop/endpoints/zai");
    expect(instance.config.launchArgs).toBe(
      "--settings /h/.t3/lastdrop/endpoints/zai/session-settings.json",
    );
    const env = Object.fromEntries(instance.environment.map((v) => [v.name, v.value]));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("");
    for (const key of SCRUBBED_VARIABLES) expect(env[key]).toBe("");
    for (const key of MODEL_VARIABLES) expect(env[key]).toBe("glm-5.3-flash");
    expect(env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe("glm-5.3");
    expect(instance.environment.every((v) => !v.sensitive)).toBe(true);
    expect(instance.config.customModels.map((m) => m.slug)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    const effort = instance.config.customModels[0]!.capabilities.optionDescriptors[0]!;
    expect(effort.options.map((o) => o.id)).toEqual(["low", "high", "max"]);
    expect(effort.options.find((o) => o.isDefault)?.id).toBe("max");
  });

  it("omits --settings for a path T3 would split", () => {
    const { instance } = endpointInstance({
      provider: "openrouter",
      home: "/Users/a b/x",
      sessionSettings: "/Users/a b/x/session-settings.json",
      model: undefined,
      models: [],
    });
    expect(instance.config.launchArgs).toBe("");
  });

  it("offers OpenRouter's catalog models with their listed efforts", () => {
    const models = endpointModels(
      "openrouter",
      ["a/one", "b/two", "a/one"],
      [{ id: "a/one", name: "One", efforts: ["low", "high"], defaultEffort: "high" }],
    );
    expect(models).toEqual([
      { id: "a/one", name: "One", efforts: ["low", "high"], defaultEffort: "high" },
      { id: "b/two", efforts: [] },
    ]);
  });

  it("quotes for a shell", () => {
    expect(shellQuote("/a/b")).toBe("/a/b");
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});

describe("endpoint models", () => {
  it("requires tools and decodes reasoning", () => {
    const models = openRouterModels({
      data: [
        { id: "plain", supported_parameters: ["temperature"] },
        { id: "tools", name: "Tools", supported_parameters: ["tools"] },
        { id: "fallback", supported_parameters: ["tools", "reasoning"] },
        {
          id: "metadata",
          supported_parameters: ["tools", "reasoning"],
          reasoning: { supported_efforts: ["low", "high", "max"], default_effort: "high" },
        },
      ],
    });
    expect(new Set(models.map((m) => m.id))).toEqual(new Set(["tools", "fallback", "metadata"]));
    expect(models.find((m) => m.id === "tools")?.efforts).toEqual([]);
    expect(models.find((m) => m.id === "fallback")?.efforts).toEqual(["low", "medium", "high"]);
    expect(models.find((m) => m.id === "metadata")?.efforts).toEqual(["low", "high", "max"]);
    expect(models.find((m) => m.id === "metadata")?.defaultEffort).toBe("high");
    expect(() => openRouterModels({})).toThrow();
  });
});

describe("endpoint errors", () => {
  it("separates exhaustion from throttling", () => {
    for (const code of [1308, 1310, 1316, 1317, 1318, 1319, 1320, 1321]) {
      expect(
        endpointLimitReached("zai", {
          code: "api_error_429",
          message: `API Error: 429 {"error":{"code":"${code}","message":"window exhausted"}}`,
        }),
      ).toBe(true);
    }
    for (const code of [1302, 1305]) {
      expect(
        endpointLimitReached("zai", {
          code: "api_error_429",
          message: `API Error: ${code}: rate limit reached`,
        }),
      ).toBe(false);
    }
    expect(
      endpointLimitReached("openrouter", { code: "api_error_429", message: "rate limit" }),
    ).toBeUndefined();
    expect(
      endpointLimitReached("openrouter", {
        code: "api_error_402",
        message: "Insufficient credits",
      }),
    ).toBe(true);
    expect(endpointLimitReached("zai", { code: "api_error_401", message: "unauthorized" })).toBe(
      undefined,
    );
  });
});

describe("OpenRouter keys", () => {
  it("rejects management keys", () => {
    expect(() => checkInferenceKey({ data: { is_management_key: false } })).not.toThrow();
    for (const field of ["is_management_key", "is_provisioning_key"]) {
      expect(() => checkInferenceKey({ data: { [field]: true } })).toThrow(
        /Management keys can't run models/u,
      );
    }
    expect(() => checkInferenceKey({})).toThrow();
    expect(isManagementKey({ is_provisioning_key: true })).toBe(true);
  });

  it("maps a regular key's own usage", () => {
    const one = openRouterKey({
      label: "sk-or-v1-abc",
      usage: 3,
      usage_daily: 1,
      limit: 10,
      limit_remaining: 7,
    })!;
    expect(one).toMatchObject({ name: "sk-or-v1-abc", total: 3, today: 1, limitRemaining: 7 });
    const usage = openRouterKeyUsage(one);
    expect(usage.summary).toBe("$7.00");
    expect(usage.windows[0]).toMatchObject({ label: "Credits", detail: "$7.00 left on this key" });
    expect(usage.windows[0]!.usedPercent).toBeCloseTo(30);
    expect(openRouterKeyUsage({ name: "k", total: 1, disabled: false }).windows).toEqual([]);
    expect(openRouterKey({ name: "no usage" })).toBeUndefined();
  });

  it("maps the account balance and keys of a management key", () => {
    const balance = openRouterBalance({ data: { total_credits: 20, total_usage: 5 } })!;
    expect(creditsWindow(balance)).toEqual({
      label: "Credits",
      usedPercent: 25,
      detail: "$15.00 of $20.00 left",
    });
    expect(creditsWindow({ total: 0, used: 0 }).usedPercent).toBe(100);
    expect(openRouterBalance({ data: {} })).toBeUndefined();
    const keys = openRouterKeys({ data: [{ name: "a", usage: 1 }, { name: "b", usage: 4 }, {}] });
    expect(keys.map((k) => k.name)).toEqual(["b", "a"]);
  });
});

describe("Z.ai usage", () => {
  it("maps session, weekly and web search rows", () => {
    const reset = Math.floor(now / 1000) + 3600;
    const windows = zaiWindows({
      success: true,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: reset * 1000 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 120, nextResetTime: reset },
          { type: "TOKENS_LIMIT", unit: 9, number: 1, percentage: 1 },
          { type: "TIME_LIMIT", currentValue: 30, usage: 100, nextResetTime: reset },
        ],
      },
    });
    expect(windows).toEqual([
      { label: "Session", usedPercent: 42, resetsAt: reset * 1000 },
      { label: "Weekly", usedPercent: 100, resetsAt: reset * 1000 },
      { label: "Web Searches", usedPercent: 30, resetsAt: reset * 1000, detail: "70 / 100 left" },
    ]);
  });

  it("reports Z.ai's own error and a missing body", () => {
    expect(() => zaiWindows({ success: false, msg: "token expired" })).toThrow("token expired");
    expect(() => zaiWindows({ data: {} })).toThrow();
  });

  it("reads the plan name", () => {
    expect(zaiPlan({ data: [{ productName: "GLM Coding Pro" }] })).toBe("GLM Coding Pro");
    expect(zaiPlan({ data: [] })).toBeUndefined();
  });
});

describe("endpoint room", () => {
  it("is out at a threshold until the row resets, and for credits used up", () => {
    const reset = now + minutes(90);
    expect(
      endpointOutUntil(
        { at: now - minutes(1), windows: [{ label: "Session", usedPercent: 95, resetsAt: reset }] },
        thresholds,
        now,
      ),
    ).toBe(reset);
    expect(
      endpointOutUntil(
        { at: now - minutes(1), windows: [{ label: "Credits", usedPercent: 100 }] },
        thresholds,
        now,
      ),
    ).toBe(now - minutes(1) + minutes(30));
    expect(
      endpointOutUntil(
        {
          at: now,
          windows: [
            { label: "Session", usedPercent: 50 },
            { label: "Web Searches", usedPercent: 100 },
          ],
        },
        thresholds,
        now,
      ),
    ).toBeUndefined();
  });

  it("never stops an agent on an old or missing reading", () => {
    expect(endpointOutUntil(undefined, thresholds, now)).toBeUndefined();
    expect(
      endpointOutUntil(
        { at: now - minutes(31), windows: [{ label: "Weekly", usedPercent: 100 }] },
        thresholds,
        now,
      ),
    ).toBeUndefined();
  });
});
