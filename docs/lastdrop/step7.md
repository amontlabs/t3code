# Step 7: the command judge for agent threads

Under `auto`, lastdrop answers the approval requests an agent thread's entry raises, as the standalone
app answers an Antigravity agent's. The pure logic is in `packages/lastdrop-core/src/judge/`, the I/O in
`packages/lastdrop-node/src/judge.ts`, and the wiring in
`apps/server/src/extensions/lastdrop/agents/commandAnswers.ts`. No T3 file changed. The port's case
table is in `packages/lastdrop-core/PORTING.md`.

## What it does

- **Where**: the router (`router.ts`) passes each inner event through `answers.onEvent` before
  restamping it. A waiting `approval_request` item (T3's ACP, Codex and Claude adapters all emit one,
  right after `runtime_request.updated`) is answered in the background through the inner adapter's
  `respondToRuntimeRequest`: `accept` or `decline`. The row still reaches T3 and resolves as usual. Only
  T3's own event pump (`events`) answers; `subscribeEvents` only watches. Each request is answered once.
- **What is checked** (review fix): never the approval row's text, which is only a summary (T3's ACP
  path falls back to the title, `run_command` for agy). The action is the tool item the provider emitted
  for the same native call (`nativeItemRef`) before asking:
  - a `command_execution` item is a shell command: Antigravity's `rawInput.CommandLine` (T3's
    Antigravity normalizer), Claude's `Bash.command`, Codex's command. Only these go through the shell
    rules and the read-only list. Text that may be the title, a generic fallback or a cut command is not
    a command;
  - any other item (an MCP tool, `WebFetch`/`WebSearch`, `Agent`, a file edit or read) goes to the judge
    with its tool name and input, as the standalone app sends non-command actions; edits are refused in
    plan mode;
  - no tool item for the call, or a command that can't be read: refused, never judged on the summary.
- **Who answers** (`permissions.ts` `lastdropAnswers`, after docs/agents.md "Permission modes"):

  | Thread mode                              | Antigravity entry                                                                                                                                                | Z.ai / OpenRouter / Claude entry                                                                                                                          | Codex entry                                                                                                   |
  | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `auto`                                   | runs `auto-accept-edits`; lastdrop answers: rules, read-only list, judge                                                                                         | Z.ai, Claude: `auto` (Claude Code's own check; what it still asks, lastdrop answers). OpenRouter: `auto-accept-edits`, every command answered by lastdrop | runs `auto` (`auto_review`); what it leaves to a person: rules and read-only list allow, the rest is declined |
  | `auto` + plan                            | runs `approval-required`, so edits reach lastdrop too; lastdrop answers read-only: deny/ask rules, read-only list, judge told to allow only reads; edits refused | same                                                                                                                                                      | same, without the judge                                                                                       |
  | `approval-required`, `auto-accept-edits` | the person                                                                                                                                                       | the person                                                                                                                                                | the person                                                                                                    |
  | `full-access`                            | the person (only the provider's own checks ask)                                                                                                                  | the person                                                                                                                                                | the person                                                                                                    |

  `auto-accept-edits` stays with the person: in T3 that mode means "ask me about commands", and a person
  is there, unlike in the standalone app's headless runs. MCP elicitations always go to the person.

- **The checks**: `decideAction`, the port of `AntigravityBackend.decide`. The rules are read for each
  request from the thread's folder (user settings or `$CLAUDE_CONFIG_DIR`, managed settings, the
  project's two files, the main checkout's from a worktree). The judge prompt holds the agent's name,
  provider and role (the catalog description), the thread's messages and steers (trusted), earlier
  commands, edits and searches (inputs only, never outputs), and the planned action with its folder. The
  latest 10 messages are kept, as in the standalone. Rules are read again for every request; only the
  judge's verdicts are kept, per identical action and mode, and a failure (timeout, `agy` error) is never
  kept, so the next identical request is judged again.
- **The judge**: one `agy -p … --mode plan --model <m> [--effort <e>] --disable-slash-commands
  --print-timeout 120s` per check, from an empty temporary folder, in its own process group: at 150 s, or
  when its session closes, the whole group is killed and the request refused at once. At most 3 judges
  run at once across the server; the rest wait. This is the
  standalone's way, chosen over a native T3 instance: same prompt and parsing, no T3 thread per check, and
  it works whether or not T3's own Antigravity is signed in. The model is the standalone catalog's
  `judges.antigravity` (`lastdrop --agents judge antigravity <model> [effort]`), read read-only for each
  check, default `gemini-3.8-flash` at low effort. Z.ai and OpenRouter requests use the same judge; their
  own judge setting is Claude Code's `CLAUDE_CODE_AUTO_MODE_MODEL`, applied inside Claude Code (step 6).
- **Never allowed by default**: `agy` missing, failing, timing out, answering anything but a clear
  `{"outcome": "allow"}`, a model it won't run, or an exception: all decline, with the reason.
- **Reporting**: every decision is a `system_notice` row in the thread ("Allowed as read-only (ls): ls",
  "Declined: rm -rf ~/Documents (not covered by your allow rules; judge: critical risk, user authorization unknown. …)") shown before
  the next event, and a line in `~/.t3/lastdrop/lastdrop.log` (`agent live (Antigravity · …), thread
  <id>: …`), the standalone's step and `•` note. Where the provider takes feedback (Claude instances), a
  refusal tells the agent it is final and to name what it needed. If the person answered first, the
  adapter refuses lastdrop's answer and nothing is shown.
- **Modes**: the interim rule of step 5 is lifted. Under `auto` an Antigravity entry runs
  `auto-accept-edits` (also while its modes are unknown). Z.ai runs `auto`: step 6 verified Claude Code 2.1.322's client-side check there (glm-5.3 allowed `curl -sI https://example.com` in about 1.8 s), as in the standalone. OpenRouter stays conservative: it runs `auto-accept-edits`, so Claude Code asks about every command and lastdrop's rules and judge answer (its auto check is untested live; the saved key is management-only).

## Evidence

- Review fixes: `commandAnswersAcp.test.ts` runs T3's real Antigravity adapter on T3's ACP replay agent
  with agy's shapes (title `run_command`, `rawInput.CommandLine`): `rm -rf ~/Documents` is judged and
  declined, `ls -la` under the same title allowed as read-only, a title "Run \`ls\`" over an `rm`
  declined, with the exact ACP answers checked. `commandAnswersClaude.test.ts` runs T3's real Claude
  adapter on frames from T3's recorded `tool_call_denied_write` fixture: a Bash `rm`, an
  `mcp__ssh__exec {command: "cat /etc/shadow"}` (judged as the MCP tool, not read-only) and a Bash `ls`,
  with the exact SDK answers checked. Both fail if the summary or a non-shell tool's input is read as the
  command (checked by mutation). `commandAnswersSession.test.ts`: no tool item, title-only, fallback and
  cut commands refused; MCP, fetch and Agent calls judged as themselves, not covered by a bare `Bash`
  rule; rules re-read, failures not kept; 10 messages kept; a closed session's judge aborted.

- Ported Swift cases, all 22, plus 4 added: `lastdrop-core` `src/judge/*.test.ts`, `lastdrop-node`
  `judge.test.ts` (temporary homes, fake `agy` scripts, a hang killed).
- `commandAnswers.test.ts`, through the router with a fake native adapter that raises requests the
  way T3's ACP adapter does: an Antigravity prompt allowed as read-only (no judge), declined by the
  judge (the prompt holds the task and call inputs, not outputs), refused when the judge fails or throws,
  allowed by the judge and by an allow rule, refused by a deny rule before the judge; `approval-required`,
  `auto-accept-edits` and `full-access` threads left to the person; plan mode read-only (allow rules
  ignored, edits refused); Codex's left-over requests; Z.ai on `auto` with refusal feedback; nothing
  shown when the person answered first. `targets.test.ts` checks the new mode mapping.
- **Live, 2026-11-14**:
  1. A full T3 run: the fork's server with an isolated `T3CODE_HOME`, a copy of `~/.t3/tools/antigravity-acp`,
     `defaultRuntimeMode: auto`, `t3 thread start --provider lastdropAgents --model live`. T3's
     Antigravity runtime is installed but not signed in ("Sign in to Antigravity in Settings before you
     continue"), so the entry failed to open, the notice said so, and the thread ran on Claude · sonnet
     under Claude Code's own auto mode: no request reached lastdrop. Signing in needs the person.
  2. Then `LASTDROP_LIVE_JUDGE=1 vp test run src/extensions/lastdrop/agents/commandAnswers.test.ts`
     (the case "live: the real judge answers a prompt"). The router ran with a fake Antigravity adapter and
     the real services: the user's real rules, real `agy` with `gemini-3.8-flash` low, and a real log
     file. Task: "List the files in this folder."
     - `ls` was allowed as read-only, without the judge.
     - `rm -rf /tmp/x` was allowed by the judge: "low risk … a narrowly scoped temporary path". That is
       Codex's policy, more permissive than Claude's (see docs/agents.md, Limits). The fake adapter
       ran nothing.
     - `rm -rf ~/Documents` was declined: "critical risk, user authorization unknown".
     - Each check took about 4 s. Three log lines were written.
  3. Directly (`decideAction` + `runCommandJudge`, the same judge, cwd `/tmp`): `rm -rf /tmp/x` was
     declined there ("medium risk … unrelated to the task"). The judge is not deterministic on that
     borderline case.

## Gaps

- Not checked live end to end through T3's real Antigravity adapter (needs its sign-in in T3).
- The agent isn't told up front that its commands are reviewed, and a turn `agy` ends at a refusal is
  not continued automatically (the standalone did both through its own ACP client). The refusal row
  and the agent's report show what was refused; the person can send a follow-up.
- Rules cover only `Bash(...)`; other requests (edits outside accept-edits, reads, permissions) always go
  to the judge, as in the standalone.
- OpenRouter: once Claude Code's auto check is verified there, it can run `auto` like Z.ai (one line in
  `permissions.ts`).
