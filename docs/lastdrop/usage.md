# Usage and limits per account

The plan (headroom `docs/t3-fork-plan.md` §3 "Usage fetching" and "Limits display", §6 Q5) asks for usage through T3's own Usage page, with every account lastdrop routes across, and the limits on hover over the usage icon.

## What shows

- **Usage → Limits** pools every Claude account lastdrop knows (the fork's account list) with T3's own Claude reading, one segment per account in each window: Session, Weekly, and each model's weekly ("Weekly · Fable"). An Ultra account has no Session segment (no 5-hour window), which T3 draws as a gap. Hover or tap a segment for the account's e-mail, plan, reset and source ("lastdrop").
- **Z.ai** (Session, Weekly, Web Searches) and **OpenRouter** (Credits) show as their own pools, named `Zai` and `OpenRouter` (see Gaps).
- **Hover on the sidebar's Usage icon**: a card with each account's limits, by provider: room left in each window, a bar, and when it resets. Accounts lastdrop cannot read (sign-in needed, a failed read) follow with why. It shows every account Limits pools, including T3's own (Codex, a hub). Clicking still opens Usage. Keyboard focus opens it too; screen readers hear the button as "Usage" with the card as one sentence for its description, and each bar is a meter (room left, 0-100).
- `/usage-limits` and the thread details' limits use the same data, so they also see lastdrop's accounts.

## How

T3 already pools accounts from **usage limit sources**, the snapshots a CLIProxyAPI hub reports (`UsageLimitSources`, contracts `UsageLimitSourceSnapshot`: accounts with a driver, e-mail, plan and `ServerProviderUsageLimits`). lastdrop adds one more source, `lastdrop`, without a hub:

- `apps/server/src/extensions/lastdrop/limitSources.ts`: turns the accounts view (`accounts.ts`), the Codex accounts view (`codex/accounts.ts`, T3's own Codex windows per account, driver `codex`) and the endpoints view (`endpoints.ts`) into that snapshot. Windows take T3's own Claude ids (`five_hour`, `seven_day`, `seven_day_<model>`), so a reading pools with T3's probe of the same account; T3 merges the two by e-mail and keeps the fresher. Banked resets: see below.
- `limitSourcesLive.ts`: a publisher (every 15 s) and the wrapper around T3's `UsageLimitSources` layer (`Extensions.usageLimitSourcesLayer`, one line at the `server.ts` seam), which appends the source to `current` and `streamChanges`. T3's layer sits below `Extensions.layer`, so the two meet through a feed the publisher layer owns (emptied when it builds and closes). A round whose content is unchanged (ignoring check times of the source and of accounts without a reading) pushes nothing to clients. Nothing published (off macOS, under vitest): the wrapper adds nothing.
- An account that can't be converted (no read time, a bad date) shows as unavailable on its own; the others still publish. An account whose last read failed shows its error, not its last numbers; a reading older than 2 hours (`READING_VALID_MS`) shows none, and a window whose reset has passed shows as unused.
- Banked resets: a count only, and only for accounts no T3 provider reports itself. T3 redeems through the fresher count's source, and lastdrop's has no credit id, so for T3's own Claude account its count would hide **Use reset**.
- Before this server's first read, an account's windows are rebuilt from the numbers and reset times `usage.json` keeps (`windowsFromStatus` in `lastdrop-core`). Session comes from the plan: every plan has one except Ultra. `usage.json` keeps no banked resets, so no count shows until the first read.
- Web: `apps/web/src/extensions/lastdrop/UsageSidebarItem.tsx` (`SidebarChrome.tsx` seam) and `usageHoverView.ts` (T3's `collectLimitAccounts`, plus lastdrop's unread accounts).

### Why not one T3 Claude instance per account (plan option a)

T3 counts an instance's limits only when it is enabled, installed and available (`providersWithLimits` in `packages/shared/src/usageLimits.ts`), so a hidden or disabled instance reports nothing. Enabled per-account instances would each appear in the model picker and run their own `get_usage` probe beside lastdrop's, and threads on them would bypass the routing. The limit source needs no T3 instance, no settings, and two seams of a few lines.

## Gaps

- **Cost and tokens per account**: not done. T3's Cost and Tokens split by provider kind, a fixed list in `packages/contracts/src/usage.ts` (`UsageProviderKind`), and all Claude accounts write transcripts T3 reads as one Claude. Splitting by account (the session ledger knows each conversation's account) would need a contracts and Usage page change, well beyond a seam.
- **Pool names on Limits**: T3 names a pool by its driver's client label; Z.ai and OpenRouter have no client of their own (registering one would offer them under **Add provider**), so the headers read `Zai` and `OpenRouter` with initials for icons. The hover names them properly.
- **Plan names**: where T3's own probe reads the same account, its plan label ("Claude Pro Subscription") can win over lastdrop's ("Max 5x"); T3 keeps the freshest.
- Resets are not spent from T3 for lastdrop's accounts.

## Checked

2026-11-15, the fork's dev server and web on a scratch `T3CODE_HOME`, real accounts (usage reads only), Playwright's bundled headless Chromium: Limits showed the two Claude accounts as segments (Ultra with no Session), Z.ai and OpenRouter as pools; the hover listed Codex, both Claude accounts, Z.ai and OpenRouter with room and resets.
