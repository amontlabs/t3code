import { assert, describe, it } from "@effect/vitest";

import { keyFromBody, writeRefusal } from "./endpointKeys.ts";

describe("who may change a key", () => {
  it("refuses a remote (DPoP) session and one without the operate scope", () => {
    assert.isUndefined(writeRefusal({ scopes: ["orchestration:read", "orchestration:operate"] }));
    assert.strictEqual(
      writeRefusal({
        scopes: ["orchestration:read", "orchestration:operate"],
        proofKeyThumbprint: "t",
      })?.error,
      "Keys are set on the Mac that runs them.",
    );
    assert.strictEqual(writeRefusal({ scopes: ["orchestration:read"] })?.status, 403);
  });
});

describe("a key in a request", () => {
  it("is one line of printable characters", () => {
    assert.strictEqual(keyFromBody('{"key":"  sk-abc.123  "}'), "sk-abc.123");
    for (const bad of [
      "",
      "not json",
      "{}",
      '{"key":7}',
      '{"key":"   "}',
      '{"key":"two words"}',
      '{"key":"line\\nbreak"}',
      `{"key":"${"k".repeat(5000)}"}`,
    ]) {
      assert.isUndefined(keyFromBody(bad), bad.slice(0, 30));
    }
  });
});
