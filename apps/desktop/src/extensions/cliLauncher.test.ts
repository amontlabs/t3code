// @effect-diagnostics nodeBuiltinImport:off -- The launcher path is checked under both POSIX and Windows path rules.
import { assert, it } from "@effect/vitest";
import * as NodePath from "node:path";

import { launcherPath } from "../app/DesktopCliShim.ts";
import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as Identity from "./identity.ts";

const environment = (platform: string, path: typeof NodePath.posix | typeof NodePath.win32) =>
  ({
    platform,
    path,
    baseDir: path.join(platform === "win32" ? "C:\\Users\\me" : "/home/me", ".t3"),
  }) as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

it("puts the fork's t3 launcher in its own folder, never T3's bin", () => {
  const posix = environment("darwin", NodePath.posix);
  const windows = environment("win32", NodePath.win32);

  assert.equal(launcherPath(posix), "/home/me/.t3/bin/t3");
  assert.equal(launcherPath(windows), "C:\\Users\\me\\.t3\\bin\\t3.cmd");

  Identity.activate();

  assert.equal(launcherPath(posix), "/home/me/.t3/lastdrop/bin/t3");
  assert.equal(launcherPath(windows), "C:\\Users\\me\\.t3\\lastdrop\\bin\\t3.cmd");
});
