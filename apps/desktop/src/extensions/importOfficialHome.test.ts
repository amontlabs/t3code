import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, beforeEach, describe, it } from "vitest";

import { importOfficialHome } from "./importOfficialHome.ts";

let root: string;
let sourceHome: string;
let targetHome: string;

const write = (relative: string, content: string) => {
  const file = NodePath.join(sourceHome, relative);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
};

const fingerprint = (file: string) => {
  const stat = NodeFS.statSync(file);
  const hash = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
  return { hash, mtimeMs: stat.mtimeMs, size: stat.size };
};

/** A WAL database with committed rows only in the WAL, held open like a running server. */
const openLiveDatabase = (file: string, rows: number) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE thread (id INTEGER PRIMARY KEY, title TEXT)");
  const insert = db.prepare("INSERT INTO thread (title) VALUES (?)");
  for (let index = 0; index < rows; index += 1) insert.run(`thread ${index}`);
  return db;
};

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-import-"));
  sourceHome = NodePath.join(root, ".t3");
  targetHome = NodePath.join(root, ".t3-lastdrop");
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("importOfficialHome", () => {
  it("snapshots a database the official app holds open, without changing its files", () => {
    const sourceDb = NodePath.join(sourceHome, "userdata", "statev2.sqlite");
    const live = openLiveDatabase(sourceDb, 50);
    try {
      assert.isTrue(NodeFS.statSync(`${sourceDb}-wal`).size > 0);
      const before = [sourceDb, `${sourceDb}-wal`].map(fingerprint);

      const outcome = importOfficialHome({ sourceHome, targetHome });

      assert.deepEqual(outcome, { _tag: "Imported", databases: 1, files: 0 });
      assert.deepEqual([sourceDb, `${sourceDb}-wal`].map(fingerprint), before);
      const copy = new NodeSqlite.DatabaseSync(
        NodePath.join(targetHome, "userdata", "statev2.sqlite"),
        {
          readOnly: true,
        },
      );
      try {
        assert.deepEqual(copy.prepare("SELECT count(*) AS n FROM thread").get(), { n: 50 });
        assert.deepEqual(copy.prepare("PRAGMA journal_mode").get(), { journal_mode: "wal" });
        assert.deepEqual(copy.prepare("PRAGMA integrity_check").get(), {
          integrity_check: "ok",
        });
      } finally {
        copy.close();
      }
    } finally {
      live.close();
    }
  });

  it("copies settings and tools but leaves the running server's files and paths into ~/.t3", () => {
    write("userdata/settings.json", "{}");
    write("userdata/secrets/provider", "key");
    write("userdata/server-runtime.json", "{}");
    write("userdata/server-owner.sqlite", "lock");
    write("userdata/environment-id", "env");
    write("userdata/logs/server.log", "log");
    write("tools/antigravity-acp/bin", "binary");
    write("worktrees/project/file", "work");
    write("scratch/thread/file", "scratch");
    write("bin/t3", "#!/bin/sh");
    write("caches/status.json", "{}");
    write("usage-host-id", "host");

    const outcome = importOfficialHome({ sourceHome, targetHome });

    assert.deepEqual(outcome, { _tag: "Imported", databases: 0, files: 3 });
    const listed = NodeFS.readdirSync(targetHome, { recursive: true }).map(String).toSorted();
    assert.deepEqual(listed, [
      "tools",
      "tools/antigravity-acp",
      "tools/antigravity-acp/bin",
      "userdata",
      "userdata/secrets",
      "userdata/secrets/provider",
      "userdata/settings.json",
    ]);
  });

  it("clones a database with no writer open, with its hot journal", () => {
    const sourceDb = NodePath.join(sourceHome, "userdata", "providers", "conversation.db");
    const db = openLiveDatabase(sourceDb, 3);
    db.exec("PRAGMA journal_mode = DELETE");
    db.close();
    write("userdata/providers/conversation.db-journal", "hot journal");

    importOfficialHome({ sourceHome, targetHome });

    const copied = NodePath.join(targetHome, "userdata", "providers", "conversation.db");
    assert.equal(fingerprint(copied).hash, fingerprint(sourceDb).hash);
    assert.equal(NodeFS.readFileSync(`${copied}-journal`, "utf8"), "hot journal");
    assert.isFalse(NodeFS.existsSync(`${sourceDb}-wal`));
    assert.isFalse(NodeFS.existsSync(`${sourceDb}-shm`));
  });

  it("runs once: an existing fork home is never replaced", () => {
    write("userdata/settings.json", '{"official":true}');
    NodeFS.mkdirSync(NodePath.join(targetHome, "userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(targetHome, "userdata", "settings.json"), "{}");

    const outcome = importOfficialHome({ sourceHome, targetHome });

    assert.deepEqual(outcome, { _tag: "Skipped", reason: "target-exists" });
    assert.equal(
      NodeFS.readFileSync(NodePath.join(targetHome, "userdata", "settings.json"), "utf8"),
      "{}",
    );
  });

  it("does nothing without an official home", () => {
    assert.deepEqual(importOfficialHome({ sourceHome, targetHome }), {
      _tag: "Skipped",
      reason: "no-source",
    });
    assert.isFalse(NodeFS.existsSync(targetHome));
  });

  it("leaves no fork home after a failed copy, so the next launch tries again", () => {
    write("userdata/settings.json", "{}");
    write("userdata/unreadable.json", "{}");
    NodeFS.chmodSync(NodePath.join(sourceHome, "userdata", "unreadable.json"), 0o000);

    assert.throws(() => importOfficialHome({ sourceHome, targetHome }));

    assert.deepEqual(NodeFS.readdirSync(root), [".t3"]);
  });
});
