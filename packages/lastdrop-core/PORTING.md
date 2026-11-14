# Porting lastdrop-core from headroom

Pure logic ported from headroom (Swift, `main` at `d0730f5`): account picking, plan sizes, usage
rules, rate-limit backoff, transient errors, and what Claude Code's result event says about the
account. No I/O: the caller passes readings, environments, times (epoch ms) and randomness.

| Swift                                                                                          | TS                                                                         |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SubagentAccounts` (`pick`, `unknown`, `threadRoom`, `pickForThread`, `hasRoom`)               | `src/accounts.ts`                                                          |
| `SubagentAccounts.ownAccountUUID`                                                              | `ownAccountUuid(env, signedInUuid)`: the `.claude.json` read is a callback |
| `PlanSize`, `ClaudeProvider.planName`                                                          | `src/planSize.ts`                                                          |
| `UsageWindow`, `SubagentUsage` `Status`/`Reading`/`reading`/`resets`/backoff, `AgentPool.room` | `src/usage.ts` (statuses are values; storage is the caller's)              |
| `TransientError.reason`, `RetryPolicy`, `SubagentRunner.hasCode`                               | `src/transientError.ts`                                                    |
| `SubagentRunner.parse`/`classify` (Claude accounts), `Result.failedToStart`/`handsOn`          | `src/result.ts`                                                            |

## Tests: Swift → TS

Same inputs and expected outputs. Swift percentages and thresholds are unchanged; times are
milliseconds instead of seconds.

### SubagentTests.swift (40 cases: 15 ported)

| Swift                                                   | TS                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `testPicksTheAccountWithMostRoom`                       | accounts.test.ts "picks the account with most room"                                 |
| `testSkipsAccountsAtOrOverAThreshold`                   | "skips accounts at or over a threshold"                                             |
| `testUnknownUsageIsTheLastResort`                       | "unknown usage is the last resort"                                                  |
| `testTodaysIncidentGoesToTheUnknownAccount`             | "2026-11-11's incident goes to the unknown account"                                 |
| `testTheCeilingIsTheOnlyLimit`                          | "the ceiling is the only limit"                                                     |
| `testAPlanWithoutAFiveHourWindowHasRoom`                | "a plan without a five-hour window has room"                                        |
| `testTheRunsModelLimitCounts`                           | "the run's model limit counts"                                                      |
| `testTheSessionsOwnAccountTakesSubagentsUpToTheCeiling` | "the session's own account takes subagents up to the ceiling"                       |
| `testPlanSizeComesFromTheSignInsTier`                   | "plan size comes from the sign-in's tier"                                           |
| `testOwnAccountComesFromTheSession`                     | "own account comes from the session"                                                |
| `testOwnAccountFollowsTheSecureStorageFolderFirst`      | "own account follows the secure storage folder first" (fake reader, no temp folder) |
| `testNativeUsageKeepsTheCacheCountsSeparate`            | result.test.ts "native usage keeps the cache counts separate"                       |
| `testParsesClaudeCodesResult`                           | "parses Claude Code's result"                                                       |
| `testAUsageLimitReadsFromClaudeCodesApiError`           | "a usage limit reads from Claude Code's api_error"                                  |
| `testClaudeCodesLimitMessagesReadAsLimits`              | "Claude Code's limit messages read as limits"                                       |

Not ported (not picking; they test the runner, CLI protocol and transcript files that later steps
replace or drop): `testNativeTaskIDsSurviveTheRunnerProtocol`, `testArgumentsMirrorTheBuiltInParameters`,
`testPermissionModeFollowsTheSession`, `testEnvironmentDropsTheCallingSessionsIdentity`,
`testRunEnvironmentSignsInThroughTheAccountsFolderInTheMainProfile` (step 3/4: account environment),
`testMCPConfigIsOnlyPassedToAnEndpoint` (step 6), `testAnOldRunsSessionIsCopiedToTheMainProjectsOnce`,
`testMCPServersComeFromTheCallersConfig`, `testStepsReadLikeAgentProgress`,
`testAReadyProcessMatchesEverythingButTheSession`, `testATakenOverProcessIsSwitchedToTheRunsModelAndMode`,
`testAClaimedProcessCanBeStoppedWhileItsSwitchesAreStillPending`, `testPipesTravelOverTheSocket`,
`testThePromptIsAStreamJSONUserMessage`, `testForkRunStartsColdWithoutClaimingWarmPool` (warm pool and
CLI runner: dropped, T3's adapter runs Claude), `testTranscriptEntriesReadLikeTheAgentsRow`,
`testAFollowUpKeepsTheAgentTypeAndEffort`, `testClaudeCodesInitIsCheckedBeforeTheAgentCountsAsStarted`,
`testAgentsRecordedBeforeTheAgentTypeWasKeptStillLoad` (agent runner, step 5),
`testTransferDropsTheTrailingLimitNoticeOnly`, `testTransferCopiesTheTranscriptAndItsSideFiles`,
`testIsLimitNoticeCases`, `testThreadReaperChecksAndReapsLiveProcess`,
`testCarryOnRewritesTranscriptWhenSharedFolderAndForksToNewID` (moving sessions: step 4),
`testLiveAnAgentAtItsLimitContinuesOnTheSessionsOwnAccount` (live, needs two signed-in accounts).
25 not ported.

### TransientErrorTests.swift (22 cases: 7 ported)

| Swift                                                           | TS                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `testTheIncidentsErrorsArePassingWhateverTheSignIn`             | transientError.test.ts "the incident's errors are passing whatever the sign-in" |
| `testOverloadedServerAndNetworkErrorsArePassing`                | "overloaded, server and network errors are passing"                             |
| `testAnAuthenticationFailureIsPassingOnlyWhileTheSignInWorks`   | "an authentication failure is passing only while the sign-in works"             |
| `testTheSignInIsOnlyAskedAboutForAnAuthenticationFailure`       | "the sign-in is only asked about for an authentication failure"                 |
| `testOtherErrorsLimitsAndMissingModelsAreNotPassing`            | "other errors, limits and missing models are not passing"                       |
| `testTheIncidentsResultIsPassingAndFallsBackBeforeAnyWork`      | "the incident's result is passing and falls back before any work"               |
| `testRetriesWaitTenThirtyNinetySecondsThenThreeMinutesJittered` | "retries wait ten, thirty, ninety seconds then three minutes, jittered" (ms)    |

Not ported:

- `testAStopCutsAWaitShort`: `Nap` is a SIGUSR1-woken sleep for the CLI runner; Effect's interruption
  does this on the server.
- `testAPassingErrorMidRunResumesTheSameSession`, `testAPassingErrorAtStartRunsTheRequestAgain`,
  `testRetriesSpentLeaveThePassingErrorForTheCallerToHandOn`, `testOtherErrorsAndStopsAreNotRetried`:
  `SubagentRunner.runRetrying` drives Claude Code processes; the query-runner wrapper (step 4) retries
  on the SDK stream and gets its own tests.
- `testRetriesSpentPartwayHandTheWorkToTheNextAttempt`, `testRetriesSpentBeforeAnyWorkSkipToTheNextAttempt`,
  `testTheCallerReadsWhatHappenedWhenNothingCouldContinue`: agent fallback chains (step 5).
- `testAnAccountWhoseRetriesWereSpentIsLeftAloneForAWhile`: `AgentRegistry`'s file-backed "troubled"
  mark (step 4 keeps that state in the server).
- `testTheRelayTellsResultsAndPassingErrorsFromOtherLines`, `testTheRelayHoldsAPassingErrorRetries…`,
  `testT3SpeakingDuringAWaitLetsTheHeldResultThroughAndCancelsTheRetry`, `testLinesAreSplitWhereverTheChunksEnd`,
  `testTheRelayRetriesATurnInTheSameProcess`, `testTheRelayHandsTheThreadOnWhenRetriesAreSpent`:
  `ThreadRelay` (a stdio relay in front of Claude Code) is replaced by the query-runner wrapper (plan §3).

### UsageBackoffTests.swift (9 cases: 9 ported)

| Swift                                               | TS                                                        |
| --------------------------------------------------- | --------------------------------------------------------- |
| `testOneProcessBlocksTheOthers`                     | usage.test.ts "one process blocks the others" (see below) |
| `testBackoffGrowsAndIsCapped`                       | "backoff grows and is capped"                             |
| `testABurstCountsOnceAndServerRetryAfterWins`       | "a burst counts once and the server's Retry-After wins"   |
| `testSuccessClearsTheBlock`                         | "success clears the block"                                |
| `testRecentReadingIsUsedWhileBlocked`               | "a recent reading is used while blocked"                  |
| `testReadingOlderThanTwoHoursIsUnknownWhileBlocked` | "a reading older than two hours is unknown while blocked" |
| `testRunnerUsesTheAppsFreshReadingWithoutFetching`  | "a runner uses the app's fresh reading without fetching"  |
| `testOldStatusFilesDecode`                          | "old status files decode"                                 |
| `testPoolKeepsABlockedAccountsReadingLonger`        | "the pool keeps a blocked account's reading longer"       |

`testOneProcessBlocksTheOthers` also checks that `ClaudeProvider.fetch` refuses while blocked; that
assertion moves with the provider (step 3). The file round trip becomes passing the returned status.

### Added (no Swift test)

usage.test.ts "reading a status for routing": four cases pinning rules the Swift tests reach only
through `usage.json` (resets projected, a session left out beside a read week, sign-in state, "full
since" a limit answer).

Totals: of 71 Swift cases in these files, 31 are ported (15 + 7 + 9) as 31 TS cases, plus 4 added = 35;
the 40 others test runners, relays and files that later steps replace or drop.

## Behaviour that differs

- Times are epoch milliseconds; `decodeStatusFile` converts lastdrop's seconds. Retry-After is still
  taken in seconds.
- `retryDelayMs` needs the random draw (−1…1) from the caller; Swift defaulted to its own.
- `ownAccountUuid` treats an empty UUID from the folder reader as none (Swift returned `""`), and
  expands `~` with the environment's `HOME`.
- `readingFromStatus` takes `fullSince` (Swift read it from `AgentRegistry`) and accepts a missing
  status (no reading, usable).
- `parseClaudeResult` covers Claude accounts only: Z.ai/OpenRouter rules come in step 6, and the
  `declined` approval descriptions with the agent runner (step 5).
- Not ported: `SubagentUsage.usage` (app-heartbeat check, a runner's own read, the file lock),
  `TransientError.signInWorks` (reads the keychain): I/O for step 3.
