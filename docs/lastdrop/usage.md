# Usage and limits per account

The plan (headroom `docs/t3-fork-plan.md` §3 "Usage fetching" and "Limits display", §6 Q5) asks for usage through T3's own Usage page, with every account lastdrop routes across, and the limits on hover over the usage icon.

## What shows

- **Usage → Limits** pools every Claude account lastdrop knows (the standalone app's account list) with T3's own Claude reading, one segment per account in each window: Session, Weekly, and each model's weekly ("Weekly · Fable"). An Ultra account has no Session segment (no 5-hour window), which T3 draws as a gap. Hover or tap a segment for the account's e-mail, plan, reset and source ("lastdrop").
- **Z.ai** (Session, Weekly, Web Searches) and **OpenRouter** (Credits) show as their own pools, named `Zai` and `OpenRouter` (see Gaps).
- **Hover on the sidebar's Usage icon**: a card with each account's limits, by provider: room left in each window, a bar, and when it resets. Accounts lastdrop cannot read (sign-in needed, a failed read) follow with why. It shows every account Limits pools, including T3's own (Codex, a hub). Clicking still opens Usage.
- `/usage-limits` and the thread details' limits use the same data, so they also see lastdrop's accounts.

## How

T3 already pools accounts from **usage limit sources**, the snapshots a CLIProxyAPI hub reports (`UsageLimitSources`, contracts `UsageLimitSourceSnapshot`: accounts with a driver, e-mail, plan and `ServerProviderUsageLimits`). lastdrop adds one more source, `lastdrop`, without a hub:

- `apps/server/src/extensions/lastdrop/limitSources.ts`: turns the accounts view (`accounts.ts`) and the endpoints view (`endpoints.ts`) into that snapshot. Windows take T3's own Claude ids (`five_hour`, `seven_day`, `seven_day_<model>`), so a reading pools with T3's probe of the same account; T3 merges the two by e-mail and keeps the fresher. Banked resets show as a count only (no credit id, so T3 offers no **Use reset**; asking anyway is refused).
- `limitSourcesLive.ts`: a publisher (every 15 s) and the wrapper around T3's `UsageLimitSources` layer (`server.ts` seam), which appends the source to `current` and `streamChanges`. T3's layer sits below `Extensions.layer`, so the two meet through a process-wide feed. Nothing published (off macOS, under vitest): the wrapper adds nothing.
- When the standalone lastdrop app runs, it reads usage for both apps and keeps only numbers and resets in `usage.json`; the accounts view now rebuilds the windows from those (`windowsFromStatus` in `lastdrop-core`).
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
