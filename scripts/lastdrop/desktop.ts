/**
 * The fork's desktop build settings, read by `scripts/build-desktop-artifact.ts` at the seams
 * listed in FORK.md.
 */
import * as NodeURL from "node:url";

/** Bundle id: its own, so macOS keeps the fork's preferences, permissions and updates apart. */
export const APP_ID = "com.amontlabs.t3code-lastdrop";

/**
 * `mac` options to sign with the fork's self-signed certificate, no notarization; empty unless
 * `LASTDROP_MAC_SIGN_IDENTITY` is set. `identity: "-"` skips electron-builder's Apple-only
 * certificate lookup and hands signing to `sign-macos.ts`. Why: FORK.md, "Release signing".
 */
export function macSelfSigning(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, unknown> {
  if (!env.LASTDROP_MAC_SIGN_IDENTITY?.trim()) return {};
  return {
    identity: "-",
    sign: NodeURL.fileURLToPath(new URL("./sign-macos.ts", import.meta.url)),
  };
}
