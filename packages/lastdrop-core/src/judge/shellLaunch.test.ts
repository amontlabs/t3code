// Codex's launches as T3's recorded Codex fixtures show them (see shellLaunch.ts).
import { describe, expect, it } from "vite-plus/test";

import { unwrapShellLaunch } from "./shellLaunch.ts";

describe("unwrapShellLaunch", () => {
  it("unwraps Codex's shell launch to its script", () => {
    expect(unwrapShellLaunch(`/bin/zsh -lc "git status"`)).toBe("git status");
    expect(
      unwrapShellLaunch(
        `/bin/bash -lc "printf 'subagent approval fixture' > subagent-approval.txt"`,
      ),
    ).toBe("printf 'subagent approval fixture' > subagent-approval.txt");
    // shlex-style concatenation, as in command_output_streaming.
    expect(unwrapShellLaunch(`/bin/zsh -lc "for i in 1 2; do printf '%s' "'$i; done'`)).toBe(
      "for i in 1 2; do printf '%s' $i; done",
    );
    expect(unwrapShellLaunch(`/bin/zsh -lc 'ls -la'`)).toBe("ls -la");
    expect(unwrapShellLaunch(`/bin/zsh -lc "echo \\"a\\" \\$HOME \\x"`)).toBe('echo "a" $HOME \\x');
  });

  it("leaves anything else as it is", () => {
    for (const command of [
      "git status",
      `/bin/zsh -lc git status`,
      `/bin/zsh -lc "ls" && rm -rf x`,
      `/bin/zsh -lc "ls"; rm x`,
      `/usr/local/bin/evil -lc "ls"`,
      `/bin/zsh -x "ls"`,
      `/bin/zsh -lc "unterminated`,
      `/bin/zsh -lc $(rm x)`,
    ])
      expect(unwrapShellLaunch(command), command).toBeUndefined();
  });
});
