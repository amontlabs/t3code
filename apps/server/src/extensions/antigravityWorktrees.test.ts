import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { findSiblingWorktrees, listedWorktrees } from "./antigravityWorktrees.ts";

/**
 * A repository as git lays it out on disk: a main checkout whose `.git` is a folder, and linked
 * worktrees, each listed in `.git/worktrees/<name>` and holding a `.git` file that points back.
 */
const makeRepository = Effect.fn("antigravityWorktrees.test.makeRepository")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-worktrees-" }),
  );
  const main = path.join(base, "main");
  yield* fileSystem.makeDirectory(path.join(main, ".git", "worktrees"), { recursive: true });
  /** Lists `folder` in the repository. With `pointsBack`, the folder holds the `.git` file git writes there. */
  const link = Effect.fn(function* (name: string, pointsBack = true) {
    const folder = path.join(base, name);
    const admin = path.join(main, ".git", "worktrees", name);
    yield* fileSystem.makeDirectory(admin, { recursive: true });
    yield* fileSystem.makeDirectory(path.join(folder, "src"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(admin, "gitdir"), `${folder}/.git\n`);
    yield* fileSystem.writeFileString(path.join(admin, "commondir"), "../..\n");
    if (pointsBack) {
      yield* fileSystem.writeFileString(path.join(folder, ".git"), `gitdir: ${admin}\n`);
    }
    return folder;
  });
  const given = (cwd: string) => findSiblingWorktrees({ fileSystem, path }, cwd);
  /** Every sibling the session's folder may read. */
  const find = (cwd: string) => given(cwd).pipe(Effect.map(() => listedWorktrees(cwd)));
  return { fileSystem, path, base, main, link, given, find };
});

describe("the worktrees an Antigravity session is given", () => {
  it.effect("are the repository's other checkouts, from any folder of any of them", () =>
    Effect.gen(function* () {
      const { path, main, link, given, find } = yield* makeRepository();
      const item = yield* link("item");
      const gate = yield* link("gate");

      assert.deepEqual(yield* find(main), [gate, item]);
      assert.deepEqual(yield* find(item), [gate, main]);
      assert.deepEqual(yield* find(path.join(gate, "src")), [item, main]);
      assert.deepEqual(listedWorktrees(path.join(item, "src")), []);
      assert.deepEqual(listedWorktrees(null), []);
      // agy runs commands from its first folder, so the session gets only the siblings after its own.
      assert.deepEqual(yield* given(main), []);
      assert.deepEqual(yield* given(item), [main]);
      assert.deepEqual(yield* given(path.join(gate, "src")), [item, main]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leave out a folder whose link does not hold both ways", () =>
    Effect.gen(function* () {
      const { fileSystem, path, base, main, link, find } = yield* makeRepository();
      const item = yield* link("item");
      const other = yield* makeRepository();
      const otherItem = yield* other.link("item");
      // What an agent can write from inside its checkout: entries in its own repository that name
      // folders it wants. None of those folders points back to this repository.
      const claim = Effect.fn(function* (name: string, dotGit: string) {
        const admin = path.join(main, ".git", "worktrees", name);
        yield* fileSystem.makeDirectory(admin, { recursive: true });
        yield* fileSystem.writeFileString(path.join(admin, "gitdir"), `${dotGit}\n`);
        yield* fileSystem.writeFileString(path.join(admin, "commondir"), "../..\n");
      });
      // Another repository's main checkout, another repository's worktree, and a plain folder.
      yield* claim("other-main", path.join(other.main, ".git"));
      yield* claim("other-item", path.join(otherItem, ".git"));
      yield* link("plain", false);
      assert.deepEqual(yield* find(main), [item]);
      assert.deepEqual(yield* find(item), [main]);
      // The other repository is untouched by the claims.
      assert.deepEqual(yield* other.find(other.main), [otherItem]);

      // A checkout that names a repository which does not list it gains nothing from it.
      const stray = path.join(base, "stray");
      yield* fileSystem.makeDirectory(stray, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(stray, ".git"),
        `gitdir: ${path.join(main, ".git", "worktrees", "item")}\n`,
      );
      assert.deepEqual(yield* find(stray), []);

      // Not in a repository at all.
      assert.deepEqual(yield* find(base), []);
      assert.deepEqual(yield* find(path.join(base, "missing")), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
