# Porting lastdrop-core (and lastdrop-node) from headroom

Pure logic ported from headroom (Swift, `main` at `d0730f5`): account picking, plan sizes, usage
rules, rate-limit backoff, transient errors, what Claude Code's result event says about the
account, the account list, which profile keys are an account's own, the keeper's rules and reading
Anthropic's usage answers. No I/O: the caller passes readings, environments, times (epoch ms) and
randomness. The I/O half of step 3 is `packages/lastdrop-node` (Node, promises; the server wraps it
in Effect); its tests are listed here too, with temporary homes and a fake `security`.

| Swift                                                                                                                                                                                                                                                                                                                  | TS                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `SubagentAccounts` (`pick`, `unknown`, `threadRoom`, `pickForThread`, `hasRoom`)                                                                                                                                                                                                                                       | `src/accounts.ts`                                                            |
| `SubagentAccounts.ownAccountUUID`                                                                                                                                                                                                                                                                                      | `ownAccountUuid(env, signedInUuid)`: the `.claude.json` read is a callback   |
| `PlanSize`, `ClaudeProvider.planName`                                                                                                                                                                                                                                                                                  | `src/planSize.ts`                                                            |
| `UsageWindow`, `SubagentUsage` `Status`/`Reading`/`reading`/`resets`/backoff, `AgentPool.room`                                                                                                                                                                                                                         | `src/usage.ts` (statuses are values; storage is the caller's)                |
| `TransientError.reason`, `RetryPolicy`, `SubagentRunner.hasCode`                                                                                                                                                                                                                                                       | `src/transientError.ts`                                                      |
| `SubagentRunner.parse`/`classify` (Claude accounts), `Result.failedToStart`/`handsOn`                                                                                                                                                                                                                                  | `src/result.ts`                                                              |
| `Account`, `AccountsConfig`, `ClaudeAccount`, `ClaudeAccountsConfig` (Accounts.swift, ClaudeAccounts.swift)                                                                                                                                                                                                            | `src/accountsConfig.ts` (`accounts.json` decode/encode, migration)           |
| `ClaudeProfile.ownKeys`/`isOwn`/`merged`/`ownState`/`isShared`                                                                                                                                                                                                                                                         | `src/claudeProfile.ts`                                                       |
| `ClaudeKeeper` rules (`isDue`, `renewDue`, `nextAttempt`, `judge`, `endsSoon`; `check`/`finished` as `afterCheck`/`afterRenewal`)                                                                                                                                                                                      | `src/claudeKeeper.ts`                                                        |
| `ClaudeProvider` parsing (`windows`, `reading`, `extraUsage`, `cachedUsage(fromConfig:)`, `resetGrants`, `isModelOnly`, `place`, `planDisplayName(fromProfile:)`, `credentials`, `signInFacts`, `keychainService`, `plan(shown:)`, `isCloudflarePage`, `rateLimitedMessage`), `ClaudeSignIn.isSignedIn`, `LimitResets` | `src/claudeUsage.ts`, `src/usage.ts`                                         |
| `ClaudeCodeHeaders` (`oauth`, `userAgent`, `version`)                                                                                                                                                                                                                                                                  | `src/claudeCodeHeaders.ts`                                                   |
| `SubagentUsage.update` for a reading and sign-in, `writeStatus`                                                                                                                                                                                                                                                        | `src/usage.ts` (`statusWithReading`, `statusWithSignIn`, `encodeStatusFile`) |
| `AccountsConfig.load`/`ClaudeAccountsConfig.load`, `LastDropPaths`                                                                                                                                                                                                                                                     | lastdrop-node `claudeSignIn.ts` `loadAccounts` (read only), `paths.ts`       |
| `Keychain` (`read`, `writeOwn`, `readOwn`)                                                                                                                                                                                                                                                                             | lastdrop-node `keychain.ts`                                                  |
| `ClaudeProfile.prepare`/`link`/`sync`/`locked`, `ClaudeAccount.runEnvironment`, `SubagentRunner.environment`'s identity filter                                                                                                                                                                                         | lastdrop-node `claudeProfile.ts`                                             |
| `ClaudeProvider.storedCredentials`/`signedInAccount`, `ClaudeSignIn.renew`, `SubagentRunner.executable`, `ClaudeCodeHeaders.installedVersion`                                                                                                                                                                          | lastdrop-node `claudeSignIn.ts`                                              |
| `ClaudeProvider.fetch`/`snapshot`/`usage`/`resetGrants`/`planDisplayName`, `HourlyCache`                                                                                                                                                                                                                               | lastdrop-node `claudeUsage.ts`                                               |
| `ClaudeKeeper` (the loop)                                                                                                                                                                                                                                                                                              | lastdrop-node `keeper.ts`                                                    |
| `SubagentUsage` `usage.json` read-modify-write                                                                                                                                                                                                                                                                         | lastdrop-node `statusStore.ts` (`~/.t3/lastdrop/usage.json`)                 |
| `AppModel` refresh of Claude accounts (`AppModel+Claude.swift`)                                                                                                                                                                                                                                                        | lastdrop-node `monitor.ts`                                                   |
| `ThreadLauncher.decide`/`parse`/`parseTail`/`userAuthOverride`, `ThreadReaper.limit`, `ThreadRelay.Machine`, `SessionTransfer.withoutTrailingNotices`, `SubagentRunner.retryPrompt`                                                                                                                                    | `src/threadRouting.ts` (on the SDK's options, not Claude Code's arguments)   |
| `SessionLedger` (sessions, threads; `live` dropped: no processes to reap)                                                                                                                                                                                                                                              | lastdrop-node `sessionLedger.ts` (`~/.t3/lastdrop/sessions.json`)            |
| `SessionTransfer`, `ThreadLauncher.transcript(ofConversation:)`/`conversationFile`                                                                                                                                                                                                                                     | lastdrop-node `sessionTransfer.ts`                                           |
| `ThreadLauncher.choose`, `AgentRegistry.markFull`/`isFull`/`markTroubled`/`isTroubled` (in memory)                                                                                                                                                                                                                     | lastdrop-node `threadRouter.ts`                                              |
| `SubagentUsage.appIsRunning`                                                                                                                                                                                                                                                                                           | lastdrop-node `standalone.ts`                                                |
| `ThreadRelay.Relay` (the stdio relay), `ThreadReaper.check` (transcript polling + SIGTERM)                                                                                                                                                                                                                             | apps/server `extensions/lastdrop/queryRunner.ts` (on the SDK stream)         |

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
assertion moved with the provider: lastdrop-node claudeUsage.test.ts "one process blocks the others: a
429 is recorded and nobody asks again". The file round trip becomes passing the returned status.

### AccountsTests.swift (16 cases: 12 ported)

| Swift                                                     | TS                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `testEveryProviderHasOneMainAccount`                      | accountsConfig.test.ts "every provider has one main account"                                                                               |
| `testWhereEachAccountKeepsItsLogin`                       | "where each account keeps its login"                                                                                                       |
| `testAddingGoesToTheEndOfItsOwnPool`                      | "adding goes to the end of its own pool"                                                                                                   |
| `testAddingRefusesUnusableAndTakenNames`                  | "adding refuses unusable and taken names"                                                                                                  |
| `testMovingStaysInsideThePool`                            | "moving stays inside the pool"                                                                                                             |
| `testMainAccountsCantBeRemoved`                           | "main accounts can't be removed"                                                                                                           |
| `testNormalizeDropsDuplicatesAndRestoresMain`             | "normalize drops duplicates and restores main"                                                                                             |
| `testMigratingTheOldClaudeListKeepsItsOrderAndThresholds` | "migrating the old Claude list keeps its order and thresholds"                                                                             |
| `testLoadMigratesUntilSavedThenReadsItsOwnFile`           | "load migrates until saved, then reads its own file"; files: lastdrop-node signIn.test.ts "is read from the standalone lastdrop's folder…" |
| `testReplacingTheClaudePoolLeavesOtherProvidersAlone`     | "replacing the Claude pool leaves other providers alone"                                                                                   |
| `testNewAccountsNotifyAtTheLimitAndShowNothing`           | "new accounts notify at the limit and show nothing"                                                                                        |
| `testSavingTheClaudeListKeepsEachAccountsSettings`        | "saving the Claude list keeps each account's settings"                                                                                     |

Not ported: `testRemovingAnAccountOnlyTouchesItsOwnProvidersKeys` (the app's keychain items for Z.ai,
OpenRouter, Antigravity: step 6 or dropped), `testAlertsSayHowFarAlong`,
`testShortOfRoomTheMenuBarDropsAccountsFromTheEnd`, `testTheMenuBarKnowsWhenMacOSHidItsItem` (the menu bar
app's notifications and status item: dropped).

### ClaudeAccountsTests.swift (11 cases: 9 ported)

| Swift                                      | TS                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `testKeychainServiceMatchesClaudeCode`     | claudeUsage.test.ts "the keychain service matches Claude Code"               |
| `testFolders`                              | accountsConfig.test.ts "folders"                                             |
| `testSlug`                                 | "slug"                                                                       |
| `testNormalizeKeepsOneMainAndAddsAccounts` | "normalize keeps one main and adds accounts"                                 |
| `testOldThresholdFileStillLoads`           | "old threshold file still loads"                                             |
| `testClaudeResetGrants` (LimitResetsTests) | claudeUsage.test.ts "Claude reset grants"                                    |
| `testModelOnlyGrantsGoOnTheirModelRow`     | "model-only grants go on their model row (Anthropic's answer of 2026-11-10)" |
| `testClaudeCodeHeaders`                    | "Claude Code's headers" (the session id is the caller's: one per server run) |
| `testExpiredResetsDrop`                    | "expired resets drop"                                                        |

Not ported: `testCodexResetCredits` (Codex limits are T3's own), `testTooltipGroupsSameDeadline` (the
panel's reset badge; with the hover limits on the usage icon, later).

### ClaudeKeeperTests.swift (13 cases: 12 ported)

| Swift                                                        | TS                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `testSignInFactsReadClaudeCodesBlob`                         | claudeUsage.test.ts "sign-in facts read Claude Code's blob"           |
| `testJudgeNamesWhatOnlyTheUserCanFix`                        | claudeKeeper.test.ts "judge names what only the user can fix"         |
| `testRenewsFourMinutesBeforeExpiryThenJustAfterThenBacksOff` | "renews four minutes before expiry, then just after, then backs off"  |
| `testNoRenewalWithoutARefreshTokenAndAtOnceWithoutAToken`    | "no renewal without a refresh token, and at once without a token"     |
| `testTheBlobIsReadEveryFiveMinutesAnyway`                    | "the blob is read every five minutes anyway"                          |
| `testEndsSoonWarnsThreeDaysAhead`                            | "ends soon warns three days ahead"                                    |
| `testAWindowPastItsResetCountsAsUnused`                      | "a window past its reset counts as unused"                            |
| `testAReadingOlderThanTwoHoursIsUnknown`                     | "a reading older than two hours is unknown"                           |
| `testAnAccountThatNeedsSignInIsNotUsable`                    | "an account that needs sign-in is not usable" (status value, no file) |
| `testLimitReachedHoldsUntilANewerReading`                    | "limit reached holds until a newer reading" (`fullSince` passed in)   |
| `testResetsAreKeptByRowName`                                 | "resets are kept by row name"                                         |
| `testUpdateKeepsOtherWritersFields`                          | "an update keeps other writers' fields" (through the file encoding)   |

Not ported: `testWithoutTheAppARunnerSeesASignInRedoneInTerminal` (a CLI runner reading usage itself when
the app's heartbeat is old; in the fork the server is the only reader).

### ClaudeProfileTests.swift (11 cases: 11 ported)

| Swift                                                            | TS                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `testCachesAndAccountKeysAreOwnEverythingElseIsShared`           | claudeProfile.test.ts "caches and account keys are own, everything else is shared"                |
| `testMergedIsMainsConfigWithTheAccountsOwnKeys`                  | "merged is Main's config with the account's own keys"                                             |
| `testOwnStateFollowsTheProfileUntilTheFolderIsSignedInElsewhere` | "own state follows the profile until the folder is signed in elsewhere"                           |
| `testPrepareBuildsTheProfileAndLeavesEverythingElseAlone`        | lastdrop-node claudeProfile.test.ts "prepare builds the profile and leaves everything else alone" |
| `testNextStartKeepsTheAccountsAnswersAndTakesMainsChanges`       | "the next start keeps the account's answers and takes Main's changes"                             |
| `testNothingInTheProfileIsReplaced`                              | "nothing in the profile is replaced"                                                              |
| `testUnchangedConfigIsNotRewritten`                              | "an unchanged config is not rewritten"                                                            |
| `testManyRunnersStartingAtOnceLeaveOneWholeConfig`               | "many runners starting at once leave one whole config" (16 concurrent calls in one process)       |
| `testAHeldLockOrAnUnreadableMainConfigLeavesTheProfileAsItIs`    | "a held lock or an unreadable Main config leaves the profile as it is"                            |
| `testRunEnvironmentRunsAnAccountInItsProfile`                    | "the run environment runs an account in its profile"                                              |
| `testUsageCacheIsReadFromTheProfile`                             | "the usage cache is read from the profile"                                                        |

### ClaudeUsageCacheTests.swift (10 cases: 10 ported)

| Swift                                                  | TS                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `testMatchingAccountIsRead`                            | claudeUsage.test.ts "the matching account is read"                                                                                           |
| `testAnotherAccountsAnswerIsIgnored`                   | "another account's answer is ignored"                                                                                                        |
| `testStaleOrFutureAnswerIsIgnored`                     | "a stale or future answer is ignored"                                                                                                        |
| `testMalformedCacheIsIgnored`                          | "a malformed cache is ignored"                                                                                                               |
| `testMissingFilesAndUnknownAccount`                    | "missing files and an unknown account (parsed configs)"; files: lastdrop-node claudeUsage.test.ts "missing and unreadable files are skipped" |
| `testNewestMatchingFileWins`                           | "the newest matching file wins"                                                                                                              |
| `testProviderReadsTheSharedFileForItsOwnAccount`       | lastdrop-node claudeUsage.test.ts "the provider reads the shared file for its own account"                                                   |
| `testFetchServesTheCacheWithoutAskingEvenWhileBlocked` | lastdrop-node "fetch serves the cache without asking, even while blocked"                                                                    |
| `testTheProfilesPlanWinsOverTheSignInsStamp`           | "the profile's plan wins over the sign-in's stamp"                                                                                           |
| `testRenewalWaitsOnTheStoredSignIn`                    | "renewal waits on the stored sign-in"                                                                                                        |

### ProviderMappingTests.swift (18 cases: 2 ported)

| Swift                                 | TS                                                   |
| ------------------------------------- | ---------------------------------------------------- |
| `testClaudeWindowsAndPlan`            | claudeUsage.test.ts "Claude windows and plan"        |
| `testClaudeExtraUsageOnlyWhenEnabled` | "Claude extra usage only when enabled" (en-US money) |

Not ported: Codex (5) and Antigravity (5) mapping, dropped (T3 reads their limits); Z.ai (3) and
OpenRouter (1), step 6; `testDurations` and `testOnlySessionAndWeeklyShowByDefault` (the Swift panel's
formatting; the web section words its own).

### Added in step 3 (no Swift test)

- core claudeKeeper.test.ts: "a check starts a renewal when due and online, and gives up after failing long
  past expiry" (`check`/`finished` as pure steps); "a reading updates numbers only when newer, and the plan
  always" (the app's `SubagentUsage.update`, and the file round trip).
- core claudeProfile.test.ts: "the same config in another layout is the same" (Swift used `NSDictionary`).
- lastdrop-node claudeUsage.test.ts: "asks with Claude Code's headers, then the plan and grants once an
  hour"; "says what only the user can fix" (no sign-in, the credentials file, 401, a Cloudflare page).
- lastdrop-node signIn.test.ts: the keychain through a fake `security`, the signed-in account, the installed
  Claude Code and its version, renewal with a fake `claude`, the keeper's loop.
- lastdrop-node monitor.test.ts: the refresh loop (two cases).
- apps/server extensions/lastdrop/accounts.test.ts: the service stays off under vitest.
- apps/web extensions/lastdrop/accountsView.test.ts: the section's wording.

### Added (no Swift test)

usage.test.ts "reading a status for routing": four cases pinning rules the Swift tests reach only
through `usage.json` (resets projected, a session left out beside a read week, sign-in state, "full
since" a limit answer).

Totals for step 2: of 71 Swift cases in these files, 31 are ported (15 + 7 + 9) as 31 TS cases, plus 4
added = 35; the 40 others test runners, relays and files that later steps replace or drop.

Totals for step 3: of 79 Swift cases (16 + 11 + 13 + 11 + 10 + 18), 56 are ported (12 + 9 + 12 + 11 + 10 +
2); the 23 others test the menu bar app, other providers or the CLI runner.

### ThreadLauncherTests.swift (33 cases: 28 ported), step 4

core threadRouting.test.ts, same names in plain words ("a new thread starts on the roomiest account and records
it", "a cold thread moves to the roomiest account", … "a user line after the last answer keeps the thread warm",
"the user's own auth or profile is left alone"): the 15 decision cases, 2 moved-thread cases and 7 tail cases.
The two that read files (`testTheConversationFileIsFoundAcrossProjectsAndReadWarm`,
`testAnAnswerBeyondAHugeToolResultIsFoundBySearchingFurtherBack`) and `testAThreadThatAlreadyMovedResumesItsCurrentConversation`'s
real-ledger half are in lastdrop-node sessionLedger.test.ts and threadRouter.test.ts.

Not ported: `testEqualsFormOfFlagsIsParsedAndRewritten`, `testAStayKeepsTheEqualsFormOfResume` (the SDK passes
options, not `--flag=value` arguments), `testOnlyConversationsChooseAnAccount` (only queries reach the runner),
`testTheWrapperFallsBackToTheRealClaudeWhenLastdropIsGone`, `testTheWrapperScriptExecsTheLauncherAndIsRewrittenOnlyWhenItDiffers`
(no wrapper script: the fork wraps the runner).

### SharedConversationsTests.swift (5 cases: 3 ported), step 4

lastdrop-node sessionLedger.test.ts "shared conversations": "the ledger says which account a shared conversation
ran on", "an account folder keeps its own account", "lines from before a fork don't count"
(`transcriptAccount`, `linesAfterFork`, for a per-account usage reader later). Not ported:
`testRootsHaveMainAndEachAccountsOwnRealProjects`, `testRootsNeverWalkTheSameRealPathTwice` (Stats' index roots:
Stats is dropped, T3's Usage page reads transcripts itself).

### Step 4 cases from other Swift files

`testTransferDropsTheTrailingLimitNoticeOnly`, `testIsLimitNoticeCases` (core threadRouting.test.ts);
`testTransferCopiesTheTranscriptAndItsSideFiles`, `testAnOldRunsSessionIsCopiedToTheMainProjectsOnce`,
`testCarryOnRewritesTranscriptWhenSharedFolderAndForksToNewID` (as "a message id from before a move is found in the
fork", lastdrop-node sessionLedger.test.ts); the relay's `testTheRelayHoldsAPassingErrorRetries…`,
`testT3SpeakingDuringAWaitLetsTheHeldResultThroughAndCancelsTheRetry`, `testTheRelayHandsTheThreadOnWhenRetriesAreSpent`
(core "retrying a passing error", and apps/server queryRunner.test.ts on the stream). `testThreadReaperChecksAndReapsLiveProcess`
is replaced by "a usage limit mid-run is surfaced in the thread and ends the query" (no polling, no signal).

### Added in step 4 (no Swift test)

- lastdrop-node threadRouter.test.ts (8): the router over a temporary home (env per account, main as it is, the
  user's own sign-in, warm/cold, ids after a move, a full account told, children with `pick`, troubled accounts, T3's fork).
- lastdrop-node monitor.test.ts: the standalone app's `usage.json` read while it runs, nothing asked; its heartbeat.
- lastdrop-node sessionLedger.test.ts: records, the id map and lineage, an unreadable file kept aside, pruning.
- core threadRouting.test.ts: children pick with `pick`; message ids across one and two forks; the relay machine.
- apps/server queryRunner.test.ts (8 replays with a fake runner) and queryRunner.contract.test.ts (the adapter's
  shapes and the strings the wrapper relies on).

## Behaviour that differs

- Times are epoch milliseconds; `decodeStatusFile` converts lastdrop's seconds. Retry-After is still
  taken in seconds.
- `retryDelayMs` needs the random draw (−1…1) from the caller; Swift defaulted to its own.
- `ownAccountUuid` treats an empty UUID from the folder reader as none (Swift returned `""`), and
  expands `~` with the environment's `HOME`.
- `readingFromStatus` takes `fullSince` (Swift read it from `AgentRegistry`) and accepts a missing
  status (no reading, usable).
- Step 4 review: "troubled" (retries spent) no longer drops the account from the candidates as Swift's
  launcher did: a warm thread there stays, the account is only never a destination. A forced move (full, gone)
  may carry `resumeSessionAt`, which Swift never moved (T3 pins a rewound head until a turn completes). A
  route that fails or times out opens on the thread's recorded account, never Main with another account's id
  (Swift ran claude as asked); the ledger is locked across processes and an unreadable one is refused (Swift set
  it aside and started empty).
- Step 4: full and troubled marks live in the server's memory (Swift: `subagents.json`), so a restart forgets them;
  the next reading still says an account is full. A move's notice also says so when the account ran out before
  the thread opened (Swift only notified at the reaper's SIGTERM).
- `parseClaudeResult` covers Claude accounts only: Z.ai/OpenRouter rules come in step 6, and the
  `declined` approval descriptions with the agent runner (step 5).
- Not ported: `SubagentUsage.usage` (app-heartbeat check, a runner's own read, the file lock: the fork's
  server is the only reader and writer of its `usage.json`), `TransientError.signInWorks` (reads the
  keychain; with the query-runner wrapper, step 4).
- Step 3: `decodeAccountsConfig` leaves out accounts of unknown providers and gives an account without
  `addedAt` the current time (Swift failed the whole file). `Keychain.readOwn`'s move from the app's old
  service name is not ported (the fork reads only Claude Code's items so far). `ClaudeSignIn`'s browser and
  Terminal sign-ins (`openTerminalSignIn`, `browserSignIn`, `CLILogin`) are not ported: the section is read
  only. The fork's `usage.json` lives in `~/.t3/lastdrop/`, apart from the standalone app's, so each keeps
  its own 429 block. Extra usage money is formatted en-US.

## Step 7: the command judge

Ported from headroom `main` at `d0730f5`: `PermissionRules.swift`, `ReadOnlyCommands.swift`,
`ReadOnlyFlagTables.swift` (data, regenerated into `src/judge/readOnlyFlagTables.ts`, 73 commands,
1,748 entries), `CommandJudge.swift` and `AntigravityBackend.decide`. Codex's reviewer policy files
(Apache 2.0) are in `src/judge/codex-guardian/` (as `.md.txt`, byte for byte) with their LICENSE and NOTICE, and embedded as
strings in `src/judge/guardianPolicy.ts` (a test checks they still equal the files).

| Swift                                                                                                                     | TS                                                           |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `PermissionRules` (`add`, `bashSpecifier`, `check`, `matches`, `split`, `unwrap`, `redirects`, `needsExactRule`)          | `src/judge/permissionRules.ts`                               |
| `PermissionRules.load`, `mainCheckout`, `gitRoot`                                                                         | lastdrop-node `judge.ts` `loadPermissionRules`               |
| `ReadOnlyCommands` (all of it), `ReadOnlyFlagTables`                                                                      | `src/judge/readOnlyCommands.ts`, `readOnlyFlagTables.ts`     |
| `CommandJudge` `Verdict`, `Context.record`, `policy`, `prompt`, `parse`, `unavailable`, `problem`, `clip`, `defaultJudge` | `src/judge/commandJudge.ts`                                  |
| `CommandJudge.judge` (runs `agy`), `AntigravityBackend.executable`                                                        | lastdrop-node `judge.ts` `runCommandJudge`, `findAgy`        |
| `AntigravityBackend.modelUnavailable`                                                                                     | `agyModelUnavailable` (Claude's `modelUnavailable` is taken) |
| `AgentCatalog.judges[.antigravity]` decoding                                                                              | `catalogJudge`, lastdrop-node `readCatalogJudge`             |
| `AntigravityBackend.decide`, `Decision`                                                                                   | `src/judge/decide.ts` `decideAction`                         |

| Swift test                                                              | TS test                                                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionRulesTests.testOnlyBashRulesAreKeptAndParameterRulesSkipped` | `permissionRules.test.ts` "keeps only Bash rules and skips parameter rules"                                                                                                       |
| `testWildcardsMatchLikeClaudeCode`                                      | "matches wildcards like Claude Code"                                                                                                                                              |
| `testEveryPartOfACompoundCommandMustBeAllowed`                          | "needs every part of a compound command allowed"                                                                                                                                  |
| `testAllowNeverCoversSubstitutionsRedirectsOrControlFlow`               | "never allows substitutions, redirects or control flow"                                                                                                                           |
| `testDenyAndAskMatchAnyPartIncludingNestedOnes`                         | "matches deny and ask on any part, nested ones included"                                                                                                                          |
| `testWrappersAreStrippedAndExecWrappersNeedAnExactRule`                 | "strips wrappers, and exec wrappers need an exact rule"                                                                                                                           |
| `testLoadsUserAndProjectSettings`                                       | lastdrop-node `judge.test.ts` "loads user and project settings" (+ managed settings)                                                                                              |
| `ReadOnlyCommandsTests.testPlainAndSpecialCommandsRead`                 | `readOnlyCommands.test.ts` "allows plain and special commands that read"                                                                                                          |
| `testFlagTablesAllowListedFlagsOnly`                                    | "allows only the flags in the tables"                                                                                                                                             |
| `testGitReadsOnly`                                                      | "allows git only where it reads"                                                                                                                                                  |
| `testGhAndDockerReadsOnly`                                              | "allows gh and docker only where they read"                                                                                                                                       |
| `testDangerousShapesAreNeverReadOnly`                                   | "never takes dangerous shapes for read-only"                                                                                                                                      |
| `testCompoundCommandsNeedEveryPartReadOnly`                             | "needs every part of a compound command read-only"                                                                                                                                |
| `ReadOnlyTablesTests.testEveryFlagClaudeCodeAllowsIsReadOnly`           | "takes every flag Claude Code allows as read-only" (same 3 refused lines)                                                                                                         |
| `testNoFlagOutsideClaudeCodesTablesIsReadOnly`                          | "takes no flag outside Claude Code's tables as read-only" (none accepted)                                                                                                         |
| `CommandJudgeTests.testThePolicyFilesShipWithTheirLicence`              | `commandJudge.test.ts` "ships the policy files with their licence" (+ embedded copies equal the files)                                                                            |
| `testThePromptHoldsTheTaskAndCallInputsOnly`                            | "holds the task and call inputs only in the prompt"                                                                                                                               |
| `testContextKeepsTheLatestCalls`                                        | "keeps the latest calls"                                                                                                                                                          |
| `testOnlyAClearAllowAllows`                                             | "allows only on a clear allow"                                                                                                                                                    |
| `testAJudgeThatFailsOrHangsDenies`                                      | lastdrop-node "denies when the judge fails or hangs" (+ a real hang killed, `agy` missing)                                                                                        |
| `CommandJudgeSettingTests.testTheJudgeRunsTheConfiguredModelAndEffort`  | `commandJudge.test.ts` "runs the configured model and effort" (arguments) and lastdrop-node "runs the configured model and effort, and names a model agy won't run" (the process) |
| `testTheJudgeIsCheckedAgainstTheSessionsModels`                         | "checks the judge against the session's models"                                                                                                                                   |

Totals for step 7: all 22 Swift cases are ported (7 + 8 + 7), as 22 TS cases, plus 4 added
(`catalogJudge`, `findAgy`/`readCatalogJudge`, and `decideAction`'s rules, plan mode and failures in 3
cases). The router side (`apps/server/src/extensions/lastdrop/agents/commandAnswers.test.ts`) is new:
see `docs/lastdrop/step7.md`.

Behaviour that differs:

- Numbers: Swift's `isNumber` (any Unicode number) and `Double(...)` became ASCII digits and plain
  decimals: stricter, never looser.
- The judge's policy line names "the user or the main agent" as the task's author (T3 threads are
  started by a person), and its read-only line says "a plan run" instead of "an Explore or Plan agent".
- `judgeUnavailable` points at `lastdrop --agents judge antigravity <model> [effort]` (the fork has no
  Settings → Accounts row for it).
- Not ported: the agent's up-front note (`commandNote`, sent through ACP `_meta`) and continuing a turn
  `agy` ended at a refusal (`continuePrompt`, `maxContinues`): T3's ACP adapter owns the session, and the
  person sees the refusal in the thread. Where the provider takes feedback (Claude instances), the
  refusal carries `continuePrompt`'s text.
