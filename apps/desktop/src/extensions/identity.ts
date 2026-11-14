/**
 * The fork's own app identity, so it installs beside the official T3 Code and never shares its
 * data. The desktop entry point turns it on (`startup.ts`) before any T3 module reads it; until
 * then every lookup returns T3's own value, which keeps T3's tests about T3's identity true.
 * The bundle id lives in `scripts/lastdrop/desktop.ts`, read by the build script.
 */

/** Folder under the home directory used as `T3CODE_HOME` when the user set none. */
export const HOME_DIR_NAME = ".t3-lastdrop";
export const DEV_HOME_DIR_NAME = ".t3-lastdrop-dev";

/** The official app's home: read once by `importOfficialHome.ts`, never written. */
export const OFFICIAL_HOME_DIR_NAME = ".t3";

/** App name in the menu bar, About panel and window titles. */
export const APP_BASE_NAME = "T3 Code lastdrop";

/**
 * Electron profile folders under Application Support. A separate profile also gives the fork its
 * own single-instance lock, so both apps run at once.
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
