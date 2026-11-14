# Step 6: Z.ai and OpenRouter as T3 Claude instances

Status: built on `lastdrop-step6`, 2026-11-14. No new seam: everything is in fork folders.

## What it does

- **Instances.** For each endpoint provider that has a key able to run models, lastdrop keeps one T3 Claude-driver instance: `zai` and `openrouter`, the ids the agents driver's targets map those providers to (step 5). They are labelled `Z.ai (lastdrop)` and `OpenRouter (lastdrop)`. They are created, updated and removed through T3's own `ServerSettingsService.updateProviderInstance` (the same call the settings UI makes), never by writing `settings.json`. T3 has no hidden flag for instances, so they show in the provider list under that label.
  - **Ownership**: `~/.t3/lastdrop/endpoint-instances.json` lists the ids lastdrop made. lastdrop changes or removes only those. If the user has their own instance under the same id, it is left alone (logged once in `lastdrop.log`), and the Accounts section says "Your instance". On lastdrop's own instance, the user's on/off switch, accent colour and T3's other config fields are kept.
  - **Removal**: when the key goes, or (on OpenRouter) when it turns out to be a management key, the instance is removed. If the user deletes lastdrop's instance while the key is still there, the next pass (every minute) makes it again.
- **Environment**, as the standalone's `EndpointProfile`:
  - `ANTHROPIC_BASE_URL`, with `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` empty.
  - Every model role (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) set to the catalog's first model on that provider (Z.ai with no agent: `glm-5.3`; OpenRouter with no agent: roles left alone).
  - `CLAUDE_CODE_AUTO_MODE_SERVER=0`, and `CLAUDE_CODE_AUTO_MODE_MODEL` set to the catalog's `judges.<provider>.model`, else `glm-5.3` on Z.ai or the agent's model on OpenRouter.
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `API_TIMEOUT_MS`.
  - Inherited routing variables (`ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`, …) set empty. An instance can only set variables, not unset them.
  - The same env goes in `session-settings.json`, passed as `--settings` in launch arguments, so a project's settings can't switch the endpoint.
- **Profile** `~/.t3/lastdrop/endpoints/<provider>/` (the instance's `homePath`): `settings.json` holds only `apiKeyHelper` → `~/.t3/lastdrop/endpoints/key-helper <provider>`, and onboarding is marked done. It links to `~/.claude`'s agents, skills, `CLAUDE.md` and commands. The helper reads the standalone's keychain item (`lastdrop`/`zai-api-key`, `openrouter-api-key`, also the old `Headroom` service) through `/usr/bin/security`, then the same fallbacks as the standalone (`~/.config/zai/key.json`, `ZAI_API_KEY`/`GLM_API_KEY`, `OPENROUTER_API_KEY`). The key is never in T3's settings or in any file. Nothing of the standalone's is written.
- **Models**: Z.ai `glm-5.3`, `glm-5.3-flash` (plus any other catalog model), effort low/high/max. OpenRouter: the catalog's models, with efforts from its public model list. These are set as the instance's `customModels`.
- **Usage**: Z.ai quota and plan (web session, else key), and OpenRouter credit (regular key, or a management key's balance and keys), every 5 minutes. They show in the Accounts section of every Claude card, and alone ("Usage (lastdrop)") on lastdrop's own instance card. Route: `GET /api/lastdrop/endpoints`.
- **Room**: the agents' `Room` also asks `endpointRoom.ts`. An entry is out while the provider's last reading (under 30 minutes old) is at the account thresholds (Session/Weekly) or its credits are used up, until that window resets. Unknown usage never stops an entry.
- **Limit classes**: at the end of a run the router uses `isUsageLimit`.
  - Z.ai codes 1308/1310/1316–1321 count as a limit, so the run moves to the next entry.
  - Z.ai 1302/1305 is throttling, so it does not count, even though T3 calls a 429 `usage_limit`.
  - OpenRouter's 402 (credits spent) counts as a limit.

Touched outside the new files: `agents/room.ts` (optional `external` out-of-room), `agents/shared.ts` (passes it), and one line in `agents/router.ts` (`isUsageLimit`). Also `extensions/index.ts`: the layer, loaded lazily because `serverSettings.ts` imports the extension lists, and the route.

## Tests

- `packages/lastdrop-core/src/endpoints.test.ts`: environment, judge, instance spec, OpenRouter models, error classes, management keys, Z.ai/OpenRouter usage mapping, room.
- `packages/lastdrop-node/src/endpoints.test.ts`: keys and fallbacks; the profile never writes through a symlinked settings file; the key helper prints the key and embeds none; usage readers; monitor cadence. Opt-in live: `LASTDROP_LIVE_ENDPOINT=1`.
- `apps/server/src/extensions/lastdrop/endpoints.test.ts`: reconcile (create, unchanged, update keeping the user's switch, the user's own id untouched, remove), catalog facts, room from usage, limit classes.
- `apps/web/src/extensions/lastdrop/accountsView.test.ts`: endpoint status words.

## Live, 2026-11-14

- Usage with the real keys: Z.ai read (Session 0%, Weekly 0%). The saved OpenRouter key is a **management key**: its balance reads, but it can't run models, so no `openrouter` instance is made.
- Fork server, isolated `T3CODE_HOME`: within seconds it created `zai` (the log says "instance zai created"). Roles were `glm-5.3-flash` (from the `cheap` agent) and the judge `glm-5.3`. No key was in `settings.json`.
- `t3 thread start --provider zai --model glm-5.3-flash --wait . "Reply with exactly: zai live ok"` answered `zai live ok`. The transcript in the profile shows `glm-5.3-flash`.
- **Auto mode on Z.ai** (Claude Code 2.1.322): `claude -p --permission-mode auto` with the instance's profile and env ran `curl -sI https://example.com`. The debug log shows `classifier_request_started … model=glm-5.3` and `outcome=ok` (1.8 s), and the command ran. So Claude Code's client-side check works on Z.ai today. (A `touch` in the folder skips the classifier, since acceptEdits would allow it.) The thread CLI has no permission-mode flag, so this ran outside T3. `permissions.ts` (step 7) still turns Z.ai/OpenRouter `auto` into `approval-required`; step 7 can now let `auto` through for Z.ai.

## Gaps

- **Step 4's query-runner wrapper** wraps every Claude query, these instances' included. It must leave `zai`/`openrouter` alone: no Claude account, no `CLAUDE_SECURESTORAGE_CONFIG_DIR`, no account move.
- **T3's Usage → Limits** reads limits from each instance's snapshot, which the Claude driver fills from Anthropic's endpoint. Feeding Z.ai/OpenRouter limits there would need a seam in the driver, so they show only in the Accounts section. Token and cost lines from these threads come from T3's own transcript reader, as for any Claude instance.
- T3's Claude probe on these instances asks Anthropic-style account questions. The instance still runs, as above.
- Only the main Z.ai/OpenRouter account is used (as the standalone's agents do by default); other accounts of those providers are not instances.
- OpenRouter is untested live (management key only).
