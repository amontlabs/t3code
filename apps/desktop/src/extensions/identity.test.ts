import { assert, it } from "vitest";

import * as Identity from "./identity.ts";

it("keeps T3's identity until the entry point turns the fork's on", () => {
  const upstream = { current: "t3code-v2", legacy: "T3 Code (Alpha)" };
  assert.equal(Identity.appBaseName("T3 Code"), "T3 Code");
  assert.equal(Identity.userDataNames(false, upstream), upstream);

  Identity.activate();

  assert.equal(Identity.appBaseName("T3 Code"), "T3 Code lastdrop");
  assert.deepEqual(Identity.userDataNames(false, upstream), {
    current: "t3code-lastdrop",
    legacy: "t3code-lastdrop",
  });
  assert.deepEqual(Identity.userDataNames(true, upstream), {
    current: "t3code-lastdrop-dev",
    legacy: "t3code-lastdrop-dev",
  });
});
