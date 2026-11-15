// Ported from headroom Tests/LastDropTests/ReadOnlyCommandsTests.swift (ReadOnlyCommandsTests and
// ReadOnlyTablesTests; see PORTING.md).
import { describe, expect, it } from "vite-plus/test";

import { readOnlyCommands } from "./readOnlyCommands.ts";
import { FLAG_TABLES, type FlagValue } from "./readOnlyFlagTables.ts";

const allowed = (commands: Array<string>) => {
  for (const command of commands) expect(readOnlyCommands(command), command).toBeDefined();
};
const refused = (commands: Array<string>) => {
  for (const command of commands) expect(readOnlyCommands(command), command).toBeUndefined();
};

describe("ReadOnlyCommands", () => {
  it("allows plain and special commands that read", () => {
    allowed([
      "ls",
      "ls -la src",
      "cat README.md",
      "head -n 20 a.txt",
      "tail -5 log.txt",
      "wc -l *.swift",
      "pwd",
      "whoami",
      "du -sh .",
      "df -h",
      "diff a b",
      "stat a",
      "cd src",
      "echo hello",
      `echo 'a b' "c"`,
      `printf '%s\\n' hi`,
      "find . -name '*.swift' -type f",
      "uniq -c",
      "sort a.txt | uniq",
      "jq '.name' package.json",
      "test -f a.txt",
      "[ -d src ]",
      "node --version",
      "docker ps",
      "date",
      "date +%Y-%m-%d",
      "which swift",
      "file a.png",
      "sha256sum a",
      "tree -L 2",
      "ps aux",
      "true",
      "tput cols",
    ]);
  });

  it("allows only the flags in the tables", () => {
    allowed([
      "grep -rn foo src",
      "grep -E 'a|b' file",
      "grep -A3 -i foo f",
      "rg -n --hidden foo",
      "rg -t swift foo",
      "sort -rn",
      "sort -k 2,2n -t , f",
      "sed -n '1,20p' f",
      "sed -n -e '/foo/p' f",
      "sed 's/a/b/g' f",
      "base64 -d",
      "fd -e swift",
      "xargs grep foo",
      "xargs -0 grep -l foo",
      "hostname",
    ]);
    refused([
      "grep --frobnicate foo",
      "rg --pre ./x foo",
      "fd -x rm",
      "fd --exec rm",
      "sort -o out.txt in.txt",
      "sort --output=out in",
      "sed -i 's/a/b/' f",
      "sed -i.bak 's/a/b/' f",
      "sed 's/a/b/w out' f",
      "sed 'e date' f",
      "sed '1w out' f",
      "sed -f script.sed f",
      "base64 -o out in",
      "tree -o out",
      "xargs rm",
      "xargs -0 rm",
      "hostname evil",
      "date 010100002030",
      "date -s 2030-01-01",
      "tput reset",
      "uniq in out",
      "sort -t, f",
      "git log -n5",
      "git cat-file --textconv HEAD:a",
      "git cat-file --filters HEAD:a",
      "ss -K",
      "ps --frobnicate",
      "lsof -+L1x",
      "gh pr list --web",
      "gh pr view 1 -R host.example/o/r",
      "git log --format=%G?",
      "git log --pretty=myalias",
      "tput reset",
      "uniq a.txt",
      "git -C .. status",
      "jq -f prog.jq",
      "jq 'env' f",
      "jq --rawfile a b .",
    ]);
  });

  it("allows git only where it reads", () => {
    allowed([
      "git status",
      "git status -sb",
      "git status --porcelain",
      "git diff --stat HEAD~3",
      "git diff --cached -- a.swift",
      "git log --oneline -20",
      "git log -n 5 --format=%H",
      "git show HEAD:a.txt",
      "git branch",
      "git branch -a -v",
      "git branch --list 'feat/*'",
      "git branch --contains HEAD",
      "git tag",
      "git tag -l 'v*'",
      "git rev-parse --abbrev-ref HEAD",
      "git blame -L 1,20 a.swift",
      "git remote -v",
      "git stash list",
      "git config --get user.name",
      "git worktree list",
      "git ls-files",
      "git merge-base main HEAD",
      "git --no-pager log -1",
    ]);
    refused([
      "git branch -D main",
      "git branch -d x",
      "git branch newname",
      "git branch -m a b",
      "git tag v1",
      "git tag -d v1",
      "git checkout main",
      "git commit -m x",
      "git push",
      "git stash",
      "git stash pop",
      "git config user.name x",
      "git diff --output=out",
      "git diff --ext-diff",
      "git log --output=x",
      "git -c core.pager=sh log",
      "git --git-dir=/x log",
      "git grep -O foo",
      "git grep --open-files-in-pager foo",
      "git reflog expire --all",
      "git remote add x y",
      "git ls-remote origin",
      "git worktree add x",
    ]);
  });

  it("allows gh and docker only where they read", () => {
    allowed([
      "gh pr view 12",
      "gh pr list --state open",
      "gh pr checks",
      "gh run view 1 --log",
      "docker logs -n 50 web",
      "docker inspect -f '{{.State}}' web",
    ]);
    refused([
      "gh pr merge 12",
      "gh api repos/x",
      "gh pr view 12 --web",
      "docker run x",
      "docker -H tcp://x ps",
      "docker logs --details=x",
    ]);
  });

  it("never takes dangerous shapes for read-only", () => {
    refused([
      `find . -exec rm {} \\;`,
      "find . -delete",
      "find . -fprint out",
      `find . -execdir sh -c x \\;`,
      "echo $HOME",
      "echo `id`",
      "echo $(id)",
      "cat a > b",
      "cat a >> b",
      "ls > out",
      "cat < /etc/passwd",
      "(ls)",
      "{ ls; }",
      "ls && rm -rf x",
      "ls; rm x",
      "cat a | sh",
      "for f in *; do cat $f; done",
      "if true; then ls; fi",
      "FOO=1 ls",
      "env",
      "rm -rf x",
      "curl https://x",
      "bash -c ls",
      "python3 -c 1",
      "echo hi #comment",
      `cat a\\ b`,
      "printf -v x hi",
      "printf '%d' abc",
      `printf '\\x41'`,
      "pwd -P",
      "cd a b",
      "ls &",
      "echo 'unterminated",
      "test -v x",
      "[[ a =~ b ]]",
      "sed -n '$p' f",
      "grep 'x$' f",
    ]);
  });

  it("needs every part of a compound command read-only", () => {
    expect(readOnlyCommands("git status && ls -la | head -5")).toEqual([
      "git status",
      "ls",
      "head",
    ]);
    expect(readOnlyCommands("cd src; git log -1 2>&1")).toEqual(["cd", "git log"]);
    expect(readOnlyCommands("ls missing 2>/dev/null || echo none")).toEqual(["ls", "echo"]);
    expect(readOnlyCommands("timeout 5 git status")).toEqual(["git status"]);
    expect(readOnlyCommands("git status && git push")).toBeUndefined();
    expect(readOnlyCommands("ls | xargs rm")).toBeUndefined();
    expect(readOnlyCommands("grep -l foo * | xargs sed -i s/a/b/")).toBeUndefined();
  });
});

/** A line that uses `flag` on `command`, with a value of its kind and whatever the command needs around it. */
const line = (command: string, flag: string, kind: FlagValue | undefined): string => {
  const value =
    kind === "number"
      ? " 5"
      : kind === "string" || kind === "char"
        ? " x"
        : kind === "braces"
          ? " {}"
          : kind === "eof"
            ? " EOF"
            : "";
  const quoted = flag.includes("?") ? `'${flag}'` : flag;
  // git takes `--format`/`--pretty` as a format, not a name from config (Claude Code refuses that too).
  if ((flag === "--format" || flag === "--pretty") && command.startsWith("git"))
    return `${command} ${flag} %h`;
  switch (command) {
    case "sed":
      return `sed ${quoted}${value} p`;
    case "git remote show":
      return `git remote show -n ${quoted}${value} origin`;
    case "test":
      return `test ${quoted}${value}`;
    default:
      return `${command} ${quoted}${value}`;
  }
};

describe("ReadOnlyTables: lastdrop's matcher against Claude Code 2.1.319's own flag tables", () => {
  it("takes every flag Claude Code allows as read-only", () => {
    const refusedLines: Array<string> = [];
    let count = 0;
    for (const [command, table] of Object.entries(FLAG_TABLES))
      for (const [flag, kind] of Object.entries(table)) {
        if (flag === "--") continue;
        count += 1;
        const text = line(command, flag, kind);
        if (readOnlyCommands(text) === undefined) refusedLines.push(text);
      }
    expect(count).toBeGreaterThan(1700);
    // Claude Code's own extra checks refuse the first two too (the value reads as a date to set, or a branch
    // name). lastdrop is stricter on an unquoted `{}`, which its parser takes for a group: `-I '{}'` passes.
    expect(refusedLines.sort()).toEqual([
      "date --iso-8601 x",
      "git branch --abbrev 5",
      "xargs -I {}",
    ]);
    expect(readOnlyCommands("xargs -I '{}' grep foo '{}'")).toBeDefined();
  });

  it("takes no flag outside Claude Code's tables as read-only", () => {
    const longs = new Set(
      Object.values(FLAG_TABLES).flatMap((table) =>
        Object.keys(table).filter((flag) => flag.startsWith("--") && flag !== "--"),
      ),
    );
    const letters = Array.from(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ).map((c) => `-${c}`);
    const accepted: Array<string> = [];
    // `test` operators are checked by lastdrop's own `test` rule, which only refuses `-v` and `-R`.
    for (const [command, table] of Object.entries(FLAG_TABLES)) {
      if (command === "test") continue;
      for (const flag of new Set([...longs, ...letters])) {
        if (Object.prototype.hasOwnProperty.call(table, flag)) continue;
        // Claude Code takes `-<digits>` on every git command (`git log -20`).
        if (command.startsWith("git ") && /^-[0-9]+$/.test(flag)) continue;
        for (const text of [line(command, flag, undefined), line(command, flag, "string")])
          if (readOnlyCommands(text) !== undefined) accepted.push(text);
      }
    }
    expect(accepted.sort(), "Claude Code doesn't allow these").toEqual([]);
  });
});

describe("ReadOnlyCommands whitespace, as Swift reads it (never looser)", () => {
  it("never splits or allows at a CRLF", () => {
    refused(["gh pr list\r\ncomm x", "ls\r\nrm x"]);
  });

  it("does not take U+FEFF for a space, and takes U+0085 for one", () => {
    refused(["echo﻿git tag"]);
    expect(readOnlyCommands("ls\u0085-la")).toEqual(["ls"]);
  });
});
