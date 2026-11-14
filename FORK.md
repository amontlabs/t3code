# FORK.md: T3 Code + lastdrop

Read this before resolving an upstream conflict or touching a T3 file.

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The `lastdrop` branch is the latest stable upstream tag (`vX.Y.Z`) plus a short stack of fork commits on top. The fork adds lastdrop (several Claude accounts picked by remaining limits, the user's own agents with fallbacks across providers) and installs as its own app beside the official T3 Code.

## Rules

1. **Share as little code with T3 as possible.** Fork code lives only in the fork's folders (below). T3 files change only at the seams listed here, a few lines each, and never in large files such as `ClaudeAdapterV2.ts` or `OrchestratorMcpService.ts`.
2. **The guard enforces it.** `node scripts/lastdrop/check-fork-paths.ts` compares `HEAD` with the upstream tag it is based on and fails on any changed path outside the fork's folders, or on a seam whose changed lines (added + deleted) exceed its budget in `scripts/lastdrop/seams.json`. `pnpm-lock.yaml` is exempt (regenerate it, never hand-merge it).
3. **A new seam needs an entry in `seams.json` and a section here**, in the same PR. A change to a seam updates its section.
4. **Upstream tests stay untouched and green.** Where the fork changes behaviour that T3's tests pin (the app identity), the change is switched on at runtime by the fork's entry point, not by editing T3's defaults or tests.

## Fork folders

| Folder                                      | Owns                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/extensions/`               | `index.ts`: the server lists T3 spreads (drivers, usage readers, provider clients for the server's copies, Claude query-runner wrapper, layer, routes). Later `extensions/lastdrop/**`. |
| `apps/web/src/extensions/`                  | `index.tsx`: per-driver sections in a provider instance's settings card.                                                                                                                |
| `apps/desktop/src/extensions/`              | App identity (`identity.ts`), startup (`startup.ts`), the one-time copy of `~/.t3` (`importOfficialHome.ts`), and their tests.                                                          |
| `packages/client-runtime/src/extensions.ts` | Provider client definitions (label, icon, settings schema) shared by web and mobile.                                                                                                    |
| `packages/lastdrop-*`                       | Future: `lastdrop-core` (pure logic), `lastdrop-provider` (T3 provider package).                                                                                                        |
| `scripts/lastdrop/`                         | Guard (`check-fork-paths.ts`, `seams.json`), build settings (`desktop.ts`), mac signing hook (`sign-macos.ts`).                                                                         |
| `docs/lastdrop/`                            | Fork docs.                                                                                                                                                                              |
| `.github/workflows/lastdrop-*`              | Sync, release and guard workflows.                                                                                                                                                      |
| `FORK.md`, README's top section             | This file; the README's fork section is a seam.                                                                                                                                         |

## Seams

Line numbers are at v0.1.9 and drift; find each seam by the code it sits beside. "Must survive" is what a merge must keep. With every extension list empty the app behaves exactly as upstream, so if a seam is lost, the app still runs but the fork's features silently disappear: check each seam after every sync.

### `apps/server/src/provider/builtInDrivers.ts` (budget 9)

- **Lines**: import `* as Extensions from "../extensions/index.ts"` (19); `| Extensions.ExtensionDriversEnv` at the end of `BuiltInDriversEnv` (32-33); `...Extensions.EXTENSION_DRIVERS` last in `BUILT_IN_DRIVERS` (47); `| Extensions.ExtensionUsageReadersEnv` at the end of `BuiltInUsageReadersEnv` (58-59); `...Extensions.EXTENSION_USAGE_DRIVERS` last in `BUILT_IN_USAGE_DRIVERS` (73).
- **Why**: registers the fork's provider drivers (the `lastdrop` agents driver) and their transcript readers for the Usage page, the same way T3 registers its own.
- **Must survive**: both spreads stay last in their arrays (T3 keeps the first duplicate usage record), and both env unions keep the extension member.
- **Conflict**: take upstream's version of the file, then re-add the five lines. If upstream renamed the arrays or moved driver registration elsewhere, put the spreads into the new list and update this section and `seams.json`.

### `apps/server/src/settingsSecrets.ts` (budget 2)

- **Lines**: import `EXTENSION_PROVIDER_CLIENTS` (23); `...EXTENSION_PROVIDER_CLIENTS` last in the client list inside `providerSecretFields` (45).
- **Why**: the server's own copy of the client list, used to redact and store each provider's secret settings fields.
- **Must survive**: the spread in whichever list maps driver kinds to `secretSettingsFields(...)`.
- **Conflict**: take upstream's file, re-add both lines.

### `apps/server/src/policy/managedProviders.ts` (budget 2)

- **Lines**: import `EXTENSION_PROVIDER_CLIENTS` (27); `...EXTENSION_PROVIDER_CLIENTS` last in `PACKAGED_CLIENTS` (55).
- **Why**: a managed policy refuses drivers it does not know; this makes it know the fork's.
- **Must survive**: the spread in the list that feeds `KNOWN_DRIVERS`.
- **Conflict**: take upstream's file, re-add both lines.

### `apps/server/src/provider/ProviderOrchestrationAdapterInfrastructure.ts` (budget 3)

- **Lines**: import `* as Extensions` (9); `Extensions.wrapClaudeQueryRunner(ClaudeAdapterV2.layerQueryRunner)` in `layer` (20).
- **Why**: every Claude Agent SDK query opens through this layer. The fork will pick the Claude account per thread here (environment, resume, forks across accounts) without touching `ClaudeAdapterV2.ts`. Today the wrapper returns the layer unchanged.
- **Must survive**: the wrapper around whatever layer provides `ClaudeAgentSdkQueryRunner`. If upstream renames the service or changes its `open` input, the wrapper's contract test (future) must be updated in the fork's folder.
- **Conflict**: take upstream's file, wrap the Claude query-runner layer again.

### `apps/server/src/server.ts` (budget 3)

- **Lines**: import `* as Extensions` (165); `Extensions.layer,` last in `layerRuntimeCoreDependenciesBase`'s `Layer.mergeAll(...)` (688); `Extensions.routes,` last in the inner `Layer.mergeAll(...)` of `layerMakeRoutes` (806).
- **Why**: the fork's long-lived services (accounts, usage fetching) and HTTP routes.
- **Must survive**: `Extensions.layer` inside the merge that gets T3's core services provided below it; `Extensions.routes` beside T3's routes.
- **Conflict**: take upstream's file, re-add the three lines in the equivalent merges.

### `packages/client-runtime/src/providerClients.ts` (budget 2)

- **Lines**: import `extensionProviderClients` from `./extensions.ts` (18); `...extensionProviderClients` last in `makeProviderClientRegistry([...])` (61).
- **Why**: the fork's providers get a label, icon and settings schema in web and mobile, like T3's.
- **Must survive**: the spread last in the registry list.
- **Conflict**: take upstream's file, re-add both lines.

### `apps/web/src/components/settings/ProviderInstanceCard.tsx` (budget 7)

- **Lines**: import `ExtensionInstanceSection` from `~/extensions` (2); `<ExtensionInstanceSection environmentId instanceId provider={liveProvider} readOnly />` right after the `acpRegistry` `AcpSessionManagementSection` block (1389-1394).
- **Why**: the fork's per-driver settings sections (accounts, agents), rendered only for the fork's driver kinds.
- **Must survive**: the element inside the card's fragment, with the four props.
- **Conflict**: take upstream's file, re-add the import and the element after the last per-driver section.

### `apps/desktop/src/main.ts` (budget 1)

- **Lines**: `import "./extensions/startup.ts";` as the **first** line (1).
- **Why**: runs before any T3 module loads: turns on the fork's identity and sets `T3CODE_HOME` (see "App identity").
- **Must survive**: it stays the first import. If it moves below a T3 import, that module may read the identity before it is on.
- **Conflict**: take upstream's file, put the import back on line 1.

### `apps/desktop/src/app/DesktopEnvironment.ts` (budget 3)

- **Lines**: import `appBaseName` (7); `const APP_BASE_NAME = appBaseName("T3 Code");` (89).
- **Why**: the app name in the About panel, window titles, menus and Electron's name.
- **Must survive**: T3's literal stays the argument, so T3's tests (identity off) still see `"T3 Code"`.
- **Conflict**: take upstream's file; wrap whatever literal names the app again.

### `apps/desktop/src/app/DesktopUserData.ts` (budget 4)

- **Lines**: import `userDataNames` (6); `const names = input.isDevelopment` renamed `upstreamNames` (43); `const names = userDataNames(input.isDevelopment, upstreamNames);` after it (46).
- **Why**: the Electron profile folder (`~/Library/Application Support/t3code-lastdrop`). A separate profile keeps Chromium storage apart and gives the fork its own single-instance lock, so both apps can run at once.
- **Must survive**: T3's names as the argument; `names` used below unchanged.
- **Conflict**: take upstream's file; rename T3's `names` again and add the line.

### `apps/desktop/package.json` (budget 2)

- **Lines**: `"productName": "T3 Code lastdrop"` (43).
- **Why**: the `.app` bundle name and the name in the menu bar and Dock.
- **Conflict**: keep upstream's file, set `productName` again.

### `scripts/build-desktop-artifact.ts` (budget 9)

- **Lines**: import `* as Lastdrop from "./lastdrop/desktop.ts"` (62); `appId: Lastdrop.APP_ID,` in `createBuildConfig` (2785); the mac `sign` option `...(signed ? { sign: ... } : Lastdrop.macSelfSigning())` (2875-2877); `name: Lastdrop.PACKAGE_NAME,` in `stagePackageJson` (3878).
- **Why**: the fork's bundle id (`com.amontlabs.t3code-lastdrop`); the packaged package name (`t3code-lastdrop`), which names Electron's safe-storage keychain item (T3's is `t3code Safe Storage`; sharing it would hand the fork the official app's key, behind a keychain prompt) and electron-updater's cache (`~/Library/Caches/t3code-lastdrop-updater`, so neither app deletes the other's pending update); and signing with the fork's self-signed certificate when `LASTDROP_MAC_SIGN_IDENTITY` is set (unset: T3's ad-hoc signing).
- **Must survive**: `DESKTOP_APP_ID` itself is left alone (T3's passkey signing tests pin it; the fork never builds `--signed`).
- **Conflict**: take upstream's file, re-apply the three edits.

### `README.md` (budget 20)

- **Lines**: the "T3 Code + lastdrop" section above upstream's README.
- **Conflict**: take upstream's README, put the section back on top.

## App identity and data

The fork never touches the official app's data, so both install side by side and an official update cannot change the fork's data.

|                            | Official T3 Code                          | Fork                                                 |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| App / bundle id            | `T3 Code (Beta)` / `com.t3tools.t3code`   | `T3 Code lastdrop` / `com.amontlabs.t3code-lastdrop` |
| T3 home (`T3CODE_HOME`)    | `~/.t3`                                   | `~/.t3-lastdrop` (dev runs: `~/.t3-lastdrop-dev`)    |
| Electron profile           | `~/Library/Application Support/t3code-v2` | `~/Library/Application Support/t3code-lastdrop`      |
| `t3` command shim          | `~/.t3/bin/t3`                            | `~/.t3-lastdrop/bin/t3`                              |
| Safe-storage keychain item | `t3code Safe Storage`                     | `t3code-lastdrop Safe Storage`                       |
| Updater cache              | `~/Library/Caches/t3code-updater`         | `~/Library/Caches/t3code-lastdrop-updater`           |
| Updates                    | pingdotgg/t3code releases                 | amontlabs/t3code releases                            |

How: `apps/desktop/src/extensions/startup.ts` runs first. It calls `Identity.activate()` (the seams above then return the fork's names; until then they return T3's, which is what T3's tests see) and sets `T3CODE_HOME` to `~/.t3-lastdrop` unless the user set one. T3 already derives its state folder, CLI shim and backend home from `T3CODE_HOME`, so no T3 path code changes. The backend gets the home as an explicit argument and T3 strips `T3CODE_HOME` from the backend's environment.

**First launch copies `~/.t3` once** (`importOfficialHome.ts`, packaged app only, only when `~/.t3-lastdrop` does not exist and `T3CODE_HOME` is unset):

- Copied: `userdata/` (database, settings, secrets, attachments, provider homes, client settings) and `tools/` (downloaded helper binaries). Files are APFS clones: instant, no extra space.
- Left behind: the running server's files (`server-owner.sqlite`, `server-runtime.json`), `logs/`, `environment-id` (the fork is its own environment for remote clients and the relay; a fresh id is made), and top-level `bin/` (the fork writes its own shim), `caches/` (rebuilt), `worktrees/` and `scratch/` (git worktrees cannot be copied; threads keep their absolute paths, see below), `usage-host-id`.
- SQLite while the official app runs: a database with a `-wal` file is snapshotted through a read-only connection with `VACUUM INTO`, which reads one committed state, WAL included, and writes nothing to the source. Copying `-db`, `-wal` and `-shm` one after another is not consistent (a checkpoint can land between the copies). A database without `-wal` has no open WAL writer, so its file is cloned as is, with a hot `-journal` if present (the fork's first open rolls it back); opening it instead could create `-wal`/`-shm` files in `~/.t3`. The copy is then switched back to WAL mode.
- The copy is built in `~/.t3-lastdrop.importing-<pid>` and renamed into place, so a failed copy leaves nothing and runs again next launch; the user sees a dialog. `~/.t3` is never written.
- Known limits: threads whose worktree or scratch folder is under `~/.t3/worktrees` or `~/.t3/scratch` keep those paths, so agents in those threads work in the official app's folders. Scheduled tasks are copied too: if both apps run, both fire them. Saved remote environments encrypted with the official app's safe-storage key do not decrypt in the fork and must be re-added. The `t3code://` URL scheme is shared with the official app (Clerk and Codex sign-in callbacks register it); macOS sends those links to one of the two apps.

**Data the fork will store** (none yet): its settings in provider instance `config` and its own files under `~/.t3-lastdrop/userdata/lastdrop/`.

## Releases

- **Versions**: `v<upstream>-ld.<n>`, for example `v0.1.10-ld.1`, then `-ld.2` for a fork-only release on the same base. Semver orders them after the upstream version, and electron-updater compares plain semver, so updates flow across bases.
- **Update feed**: the build writes `app-update.yml` for `T3CODE_DESKTOP_UPDATE_REPOSITORY` (`amontlabs/t3code`). The app reads the stable channel: GitHub's latest full release and its `latest-mac.yml`. Releases must not be marked prerelease.
- **Release signing**: a self-signed code-signing certificate, the same one forever, in secrets `LASTDROP_SIGNING_CERT_P12` (base64 `.p12`) and `LASTDROP_SIGNING_CERT_PASSWORD`. Squirrel.Mac installs an update only if it satisfies the running app's designated requirement; ad-hoc signing makes that the code hash, so every update would fail, while a fixed certificate makes it `certificate leaf = H"<sha1>"`. No notarization: the first install is opened once through System Settings → Privacy & Security. `lastdrop-release.yml` imports the certificate into a temporary keychain added to the search list (codesign finds an untrusted self-signed identity only there), and the build signs through `scripts/lastdrop/sign-macos.ts` (electron-builder is told `identity: "-"` so it skips its Apple-only certificate lookup). Releases are never published unsigned. To make the certificate: Keychain Access → Certificate Assistant → Create a Certificate, type "Code Signing", self-signed root; export it as `.p12`. Verify a two-version update before relying on it.

## Sync

`.github/workflows/lastdrop-sync.yml`, hourly and on manual dispatch (both use the copy of the workflow on the repository's default branch):

1. Turns off every workflow that is not `lastdrop-*` (upstream's would fail or wait for upstream's runners).
2. Finds the newest stable upstream tag (`^v\d+\.\d+\.\d+$`; nightly and preview tags are skipped). Nothing newer than the base of `lastdrop`: done.
3. `git rebase --onto <new> <previous> lastdrop`.
4. Clean: pushes `lastdrop-sync/<tag>`, then on it runs the guard, install, `vp run typecheck`, `vp run -r test` and `vp run build:desktop`.
5. Green: moves `lastdrop` (only if nobody pushed meanwhile), tags `v<tag>-ld.<n>`, deletes the sync branch and calls `lastdrop-release.yml` (a tag pushed with the workflow token starts no workflow by itself).
6. Conflict or red: `lastdrop-sync/<tag>` stays (the upstream tag on a conflict, the rebased branch on red) with a PR into `lastdrop` carrying the log. While that branch exists the hourly job does not retry. Creating the PR needs "Allow GitHub Actions to create and approve pull requests" in the repository's Actions settings.

`lastdrop-guard.yml` runs the guard on every push and PR to `lastdrop`. A person can release by pushing a `v*-ld.*` tag, which runs `lastdrop-release.yml` directly.

### Resolving a sync

1. `git fetch origin && git fetch https://github.com/pingdotgg/t3code.git 'refs/tags/<tag>:refs/tags/<tag>'`.
2. `git switch lastdrop && git rebase --onto <tag> <previous>` (or start from `lastdrop-sync/<tag>` when checks were red).
3. For each conflict: a fork folder → keep ours; a seam → take upstream's file and re-apply the seam from its section above; `pnpm-lock.yaml` → take upstream's, then run `pnpm install --lockfile-only` at the end; anything else → it should not differ from upstream: take upstream's.
4. `node scripts/lastdrop/check-fork-paths.ts`, then the checks for the packages you touched (`vp run check:changed`) and the desktop tests.
5. `git push --force-with-lease origin lastdrop`, then push tag `v<tag>-ld.1` to release. Close the PR and delete `lastdrop-sync/<tag>`.
