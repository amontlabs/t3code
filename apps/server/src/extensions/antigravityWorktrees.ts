/**
 * The repository's other worktrees, which an Antigravity session lists beside its own folder.
 * One counts only if its `.git` file points back: an agent cannot write that from its checkout.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

interface Services {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** What the latest session started in a folder was given. The client's own file reads allow the same. */
const listed = new Map<string, ReadonlyArray<string>>();

const none: ReadonlyArray<string> = [];

/** The path after `gitdir:` in a worktree's `.git` file. */
const gitdirOf = (line: string) =>
  line.startsWith("gitdir:") ? line.slice("gitdir:".length).trim() : "";

const siblingWorktrees = Effect.fn("antigravityWorktrees.siblingWorktrees")(function* (
  { fileSystem, path }: Services,
  cwd: string,
) {
  const real = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => undefined));
  /** The real path a file's first line names, read relative to `base`. */
  const pointer = (file: string, base: string, parse: (line: string) => string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => parse(text.split("\n", 1)[0]?.trim() ?? "")),
      Effect.flatMap((target) =>
        target === "" ? Effect.undefined : real(path.resolve(base, target)),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  // The checkout this folder is in: the nearest folder up that has a `.git`.
  let root = yield* real(cwd);
  while (root !== undefined) {
    if (yield* fileSystem.exists(path.join(root, ".git")).pipe(Effect.orElseSucceed(() => false))) {
      break;
    }
    const parent = path.dirname(root);
    root = parent === root ? undefined : parent;
  }
  if (root === undefined) return none;

  // The repository: this checkout's own `.git` folder, or the one a linked worktree's `.git` file names.
  const dotGit = yield* real(path.join(root, ".git"));
  if (dotGit === undefined) return none;
  const info = yield* fileSystem.stat(dotGit).pipe(Effect.orElseSucceed(() => undefined));
  let common: string | undefined;
  if (info?.type === "Directory") {
    common = dotGit;
  } else {
    const admin = yield* pointer(dotGit, root, gitdirOf);
    if (admin === undefined) return none;
    if ((yield* pointer(path.join(admin, "gitdir"), admin, (line) => line)) !== dotGit) return none;
    common =
      (yield* pointer(path.join(admin, "commondir"), admin, (line) => line)) ??
      (yield* real(path.dirname(path.dirname(admin))));
  }
  if (common === undefined) return none;

  const roots = new Set<string>();
  // The main checkout is the folder whose `.git` is the repository itself. A bare repository has none.
  const main = path.dirname(common);
  if ((yield* real(path.join(main, ".git"))) === common) roots.add(main);
  const names = yield* fileSystem
    .readDirectory(path.join(common, "worktrees"))
    .pipe(Effect.orElseSucceed(() => none));
  for (const name of names) {
    const admin = path.join(common, "worktrees", name);
    const worktreeDotGit = yield* pointer(path.join(admin, "gitdir"), admin, (line) => line);
    if (worktreeDotGit === undefined) continue;
    const back = yield* pointer(worktreeDotGit, path.dirname(worktreeDotGit), gitdirOf);
    if (back === undefined || back !== (yield* real(admin))) continue;
    roots.add(path.dirname(worktreeDotGit));
  }
  roots.delete(root);
  return [...roots].toSorted();
});

/**
 * Finds the other worktrees of the repository `cwd` is in, for a session starting there. It finds
 * none where `cwd` is in no repository, or in a checkout the repository does not list.
 */
export const findSiblingWorktrees = Effect.fn("antigravityWorktrees.find")(function* (
  services: Services,
  cwd: string,
) {
  const found = yield* siblingWorktrees(services, cwd).pipe(
    Effect.catchCause(() => Effect.succeed(none)),
  );
  listed.set(cwd, found);
  return found;
});

/** The worktrees the latest session started in `cwd` was given. */
export const listedWorktrees = (cwd: string | null): ReadonlyArray<string> =>
  cwd === null ? none : (listed.get(cwd) ?? none);
