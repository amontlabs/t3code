/**
 * The fork's app name and Electron profile; its T3 home and safe-storage key stay T3's
 * (FORK.md, "App identity and data"). Off until `startup.ts` turns it on, so T3's tests still
 * see T3's identity. The bundle id is in `scripts/lastdrop/desktop.ts`.
 */

/** App name in the menu bar, About panel and window titles. */
const APP_BASE_NAME = "T3 Code lastdrop";

/**
 * Electron profile folders under Application Support: Chromium storage must not be opened by two
 * apps at once. Both apps can be open, but only one server owns the shared T3 home; the other's
 * server refuses to start (T3's `server-owner.sqlite` lock) and that app quits.
 */
const USER_DATA_NAMES = {
  development: { current: "t3code-lastdrop-dev", legacy: "t3code-lastdrop-dev" },
  production: { current: "t3code-lastdrop", legacy: "t3code-lastdrop" },
} as const;

let active = false;

/** Called once by the desktop entry point, before T3's modules load. */
export function activate(): void {
  active = true;
}

/** The app name to use where T3 would use `upstream`. */
export function appBaseName(upstream: string): string {
  return active ? APP_BASE_NAME : upstream;
}

/** Electron profile folder names to use where T3 would use `upstream`. */
export function userDataNames(
  isDevelopment: boolean,
  upstream: { readonly current: string; readonly legacy: string },
): { readonly current: string; readonly legacy: string } {
  return active ? USER_DATA_NAMES[isDevelopment ? "development" : "production"] : upstream;
}

/**
 * Folder holding the `t3` launcher (`<folder>/bin/t3`) where T3 would use `upstream` (its home).
 * The fork keeps its own under `<home>/lastdrop/`, the folder `lastdropDataDir` names, so it never
 * overwrites the official app's `<home>/bin/t3`.
 */
export function cliLauncherDir(
  path: { readonly join: (...parts: ReadonlyArray<string>) => string },
  upstream: string,
): string {
  return active ? path.join(upstream, "lastdrop") : upstream;
}
