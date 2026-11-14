/**
 * electron-builder's `mac.sign` hook for self-signed releases (see `desktop.ts`): signs with
 * `LASTDROP_MAC_SIGN_IDENTITY` in place of the ad-hoc identity electron-builder passes.
 */
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

export default async function sign(options: SignOptions): Promise<void> {
  const identity = process.env.LASTDROP_MAC_SIGN_IDENTITY?.trim();
  if (!identity) throw new Error("LASTDROP_MAC_SIGN_IDENTITY is not set.");
  const keychain = process.env.LASTDROP_MAC_SIGN_KEYCHAIN?.trim();
  await signApplication({
    ...options,
    identity,
    ...(keychain ? { keychain } : {}),
    identityValidation: false,
    batchCodesignCalls: true,
  });
}
