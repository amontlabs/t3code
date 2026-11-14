import { describe, expect, it } from "vite-plus/test";

import { accountTitle, signInLabel, usedLabel } from "./accountsView";

describe("the accounts section", () => {
  it("names accounts and words their state", () => {
    expect(accountTitle({ isMain: true, key: "main" })).toBe("Main");
    expect(accountTitle({ isMain: false, key: "Pro" })).toBe("Pro");
    expect(accountTitle({ isMain: false, key: "Pro", name: "Work" })).toBe("Work");
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
