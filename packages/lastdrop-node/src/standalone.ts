/**
 * The standalone lastdrop app, when it runs beside the fork. It touches `app.heartbeat` in its support folder
 * every few seconds, reads every account's usage and keeps their sign-ins renewed, writing the readings to its
 * own `usage.json`. While it runs, the fork reads that file instead of asking Anthropic and renewing sign-ins
 * itself, so the two apps never double the requests. Port of headroom's `SubagentUsage.appIsRunning`.
 */
import * as NodeFSP from "node:fs/promises";

import type { AccountStatus } from "@t3tools/lastdrop-core";

import { type LastdropPaths, statusFile } from "./paths.ts";
import { StatusStore } from "./statusStore.ts";

/** The app counts as running while its heartbeat is younger than this (headroom's `heartbeatFresh`). */
export const HEARTBEAT_FRESH_MS = 60_000;

export const standaloneHeartbeatFile = (p: LastdropPaths) => `${p.swiftSupport}/app.heartbeat`;
/** The standalone app's readings (same format as the fork's own `usage.json`). */
export const standaloneStatusFile = (p: LastdropPaths) => `${p.swiftSupport}/usage.json`;

/** True while the standalone app's heartbeat is less than a minute old. */
export async function standaloneAppRunning(paths: LastdropPaths, now: number): Promise<boolean> {
  try {
    const { mtimeMs } = await NodeFSP.stat(standaloneHeartbeatFile(paths));
    return now - mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * The readings routing uses: the standalone app's while it runs (it is the one reader of Anthropic's usage
 * then), else the fork's own `usage.json`.
 */
export async function routingStatuses(
  paths: LastdropPaths,
  now: number,
): Promise<Record<string, AccountStatus>> {
  const file = (await standaloneAppRunning(paths, now))
    ? standaloneStatusFile(paths)
    : statusFile(paths);
  return new StatusStore(file).read();
}
