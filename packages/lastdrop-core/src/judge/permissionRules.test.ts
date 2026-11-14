// Ported from headroom Tests/LastDropTests/PermissionRulesTests.swift (see PORTING.md). The loading case is in
// lastdrop-node's judge.test.ts.
import { describe, expect, it } from "vite-plus/test";

import {
  addPermissions,
  checkRules,
  EMPTY_RULES,
  matchesRule,
  type PermissionRules,
} from "./permissionRules.ts";

const rules = (input: {
  allow?: Array<string>;
  deny?: Array<string>;
  ask?: Array<string>;
}): PermissionRules =>
  addPermissions(EMPTY_RULES, {
    allow: input.allow ?? [],
    deny: input.deny ?? [],
    ask: input.ask ?? [],
  });

const NONE = { type: "none" } as const;
const allow = (...used: Array<string>) => ({ type: "allow", rules: used });

describe("PermissionRules", () => {
  it("keeps only Bash rules and skips parameter rules", () => {
    const r = rules({
      allow: [
        "Bash",
        "Bash(npm test:*)",
        "Read(./x)",
        "WebFetch(domain:a.b)",
        "Bash(run_in_background:true)",
        "Bash()",
      ],
    });
    expect(r.allow).toEqual(["*", "npm test:*"]);
  });

  it("matches wildcards like Claude Code (its Wildcard patterns table)", () => {
    const cases: Array<[string, Array<string>, Array<string>]> = [
      ["npm run build", ["npm run build"], ["npm run build --watch"]],
      ["npm run *", ["npm run build", "npm run test --watch", "npm run"], ["npm install"]],
      [
        "git log * main",
        ["git log --oneline main", "git log -5 main"],
        ["git log main", "git push origin main"],
      ],
      ["git * main", ["git merge main", "git push origin main"], ["git log"]],
      ["* --version", ["node --version"], ["node -v"]],
      ["ls *", ["ls -la", "ls"], ["lsof"]],
      ["ls*", ["ls -la", "lsof"], []],
      ["* --help *", ["npm --help x"], ["npm --help"]],
      ["ls:*", ["ls -la", "ls"], ["lsof"]],
      ["git:* push", [], ["git push", "git x push"]],
      ["*", ["anything at all"], []],
    ];
    for (const [rule, yes, no] of cases) {
      for (const command of yes)
        expect(matchesRule(rule, command), `${rule} should match ${command}`).toBe(true);
      for (const command of no)
        expect(matchesRule(rule, command), `${rule} should not match ${command}`).toBe(false);
    }
  });

  it("needs every part of a compound command allowed", () => {
    const r = rules({ allow: ["Bash(git status)", "Bash(npm test *)"] });
    expect(checkRules(r, "git status && npm test")).toEqual(
      allow("Bash(git status)", "Bash(npm test *)"),
    );
    expect(checkRules(r, "git status; npm test --watch | npm test")).toEqual(
      allow("Bash(git status)", "Bash(npm test *)"),
    );
    expect(checkRules(r, "git status && rm -rf x")).toEqual(NONE);
    expect(checkRules(r, "npm test &&"), "a dangling operator is unparseable").toEqual(NONE);
    expect(checkRules(r, "git status & curl x")).toEqual(NONE);
    expect(checkRules(r, "echo 'git status && npm test'")).toEqual(NONE);
    // Separators inside quotes don't split.
    expect(checkRules(rules({ allow: ["Bash(echo *)"] }), "echo 'a && b; c'")).toEqual(
      allow("Bash(echo *)"),
    );
  });

  it("never allows substitutions, redirects or control flow", () => {
    const r = rules({ allow: ["Bash(echo *)", "Bash(git status)", "Bash(cat *)"] });
    for (const command of [
      "echo $(rm -rf x)",
      "echo `whoami`",
      'echo "$(id)"',
      "(git status)",
      "{ git status; }",
      "echo x > out.txt",
      "cat < /etc/passwd",
      "cat <<EOF\nx\nEOF",
      "for f in a; do echo $f; done",
      "if git status; then echo y; fi",
      "FOO=1 echo x",
      "echo 'unterminated",
    ])
      expect(checkRules(r, command), command).toEqual(NONE);
    expect(checkRules(r, "echo x 2>&1")).toEqual(allow("Bash(echo *)"));
    expect(checkRules(r, "echo x >/dev/null 2>/dev/null")).toEqual(allow("Bash(echo *)"));
    expect(checkRules(r, "echo 'a > b'")).toEqual(allow("Bash(echo *)"));
  });

  it("matches deny and ask on any part, nested ones included", () => {
    const r = rules({ allow: ["Bash"], deny: ["Bash(rm *)"], ask: ["Bash(git push *)"] });
    const deny = { type: "deny", rule: "Bash(rm *)" };
    expect(checkRules(r, "rm -rf build")).toEqual(deny);
    expect(checkRules(r, "cd /tmp && rm -rf build")).toEqual(deny);
    expect(checkRules(r, 'echo "$(rm -rf x)"')).toEqual(deny);
    expect(checkRules(r, "for f in a; do rm $f; done")).toEqual(deny);
    expect(checkRules(r, "FOO=bar rm -rf tmp/")).toEqual(deny);
    expect(checkRules(r, "timeout 30 rm x")).toEqual(deny);
    expect(checkRules(r, "git status; git push origin main")).toEqual({
      type: "ask",
      rule: "Bash(git push *)",
    });
    expect(checkRules(r, "ls -la")).toEqual(allow("Bash(*)"));
    // Deny wins over allow, whatever the order of files.
    expect(
      checkRules(rules({ allow: ["Bash(rm -rf build)"], deny: ["Bash(rm *)"] }), "rm -rf build"),
    ).toEqual(deny);
  });

  it("strips wrappers, and exec wrappers need an exact rule", () => {
    const r = rules({
      allow: [
        "Bash(npm test *)",
        "Bash(grep *)",
        "Bash(find *)",
        "Bash(watch *)",
        "Bash(find build -type f -delete)",
      ],
    });
    expect(checkRules(r, "timeout 30 npm test")).toEqual(allow("Bash(npm test *)"));
    expect(checkRules(r, "nice -n 5 nohup npm test --ci")).toEqual(allow("Bash(npm test *)"));
    expect(checkRules(r, "xargs grep pattern")).toEqual(allow("Bash(grep *)"));
    expect(checkRules(r, "xargs -n1 grep pattern")).toEqual(NONE);
    expect(checkRules(r, "find . -name x")).toEqual(allow("Bash(find *)"));
    expect(checkRules(r, "find . -name x -delete")).toEqual(NONE);
    expect(checkRules(r, "find . -exec rm {} ;")).toEqual(NONE);
    expect(checkRules(r, "find build -type f -delete")).toEqual(
      allow("Bash(find build -type f -delete)"),
    );
    expect(checkRules(r, "watch ls")).toEqual(NONE);
    expect(checkRules(r, "command -v npm")).toEqual(NONE);
  });
});
