import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";

import { OwnedFenceContentionError, OwnedFenceLockUnavailableError, withOwnedFenceLockSync } from "../src/owned-fence-lock.mjs";

test("Windows missing PID avoids a native tool while permission uncertainty and live birth stay fail-closed", () => {
  const source = readFileSync(new URL("../src/owned-fence-lock.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function inspectProcessBirth(pid) {");
  const end = source.indexOf("\nexport function inspectGenericPosixProcessBirth", start);
  assert.ok(start >= 0 && end > start);
  for (const outcome of ["ESRCH", "EPERM", "live", "native_failure"] as const) {
    let queries = 0;
    const signals: Array<[number, number]> = [];
    const context = vm.createContext({
      process: {
        platform: "win32",
        kill: (pid: number, signal: number) => {
          signals.push([pid, signal]);
          if (outcome === "ESRCH" || outcome === "EPERM") throw Object.assign(new Error(outcome), { code: outcome });
        },
      },
      execFileSync: () => {
        queries++;
        if (outcome === "native_failure") throw new Error("native birth unavailable");
        return "PRESENT:exact-native-birth";
      },
      normalizeBirth: (birth: string) => birth,
    });
    vm.runInContext(source.slice(start, end), context);
    const result = JSON.parse(JSON.stringify(vm.runInContext("inspectProcessBirth(4242)", context)));
    assert.deepEqual(signals, [[4242, 0]], "only a non-destructive existence probe is allowed");
    assert.equal(queries, outcome === "ESRCH" || outcome === "EPERM" ? 0 : 1);
    assert.deepEqual(result, outcome === "ESRCH" ? { state: "absent" }
      : outcome === "live" ? { state: "same", fingerprint: "exact-native-birth" } : { state: "unknown" });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-inspection-"));
  const path = join(root, "effect.sqlite");
  withOwnedFenceLockSync(path, () => undefined, { holderBirth: "fixture-creator" });
  const holder = { id: randomUUID(), pid: process.pid, birth: "original-birth" };
  const database = new DatabaseSync(path);
  try {
    database.prepare("INSERT INTO owned_fence_acquisition VALUES (?, ?, ?)").run(holder.id, holder.pid, holder.birth);
    database.prepare("INSERT INTO owned_fence_holder VALUES ('owned', ?, ?, ?)").run(holder.id, holder.pid, holder.birth);
  } finally { database.close(); }
  return { root, path, holder };
}

function transaction(path: string, action: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path);
  try {
    // An inspecting contender must not prevent the existing holder from finishing.
    database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    action(database);
    database.exec("COMMIT");
  } finally { database.close(); }
}

function removeHolder(database: DatabaseSync, id: string) {
  database.prepare("DELETE FROM owned_fence_holder WHERE acquisition_id = ?").run(id);
  database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(id);
}

test("an exact holder can finalize while its contender performs host inspection", () => {
  const { root, path, holder } = fixture();
  let inspections = 0;
  let effects = 0;
  try {
    withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: (pid, birth) => {
        inspections++;
        assert.equal(pid, holder.pid);
        assert.equal(birth, holder.birth);
        transaction(path, (database) => removeHolder(database, holder.id));
        return "same";
      },
    });
    assert.equal(inspections, 1);
    assert.equal(effects, 1, "ordinary acquisition follows the completed holder, without stealing it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale absent proof cannot elect a contender over a replacement holder", () => {
  const { root, path, holder } = fixture();
  const replacement = { id: randomUUID(), pid: process.pid + 1, birth: "replacement-birth" };
  let inspections = 0;
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: (pid, birth) => {
        inspections++;
        if (inspections === 1) {
          assert.equal(pid, holder.pid);
          assert.equal(birth, holder.birth);
          transaction(path, (database) => {
            removeHolder(database, holder.id);
            database.prepare("INSERT INTO owned_fence_acquisition VALUES (?, ?, ?)").run(replacement.id, replacement.pid, replacement.birth);
            database.prepare("INSERT INTO owned_fence_holder VALUES ('owned', ?, ?, ?)").run(replacement.id, replacement.pid, replacement.birth);
          });
          return "absent";
        }
        assert.equal(pid, replacement.pid);
        assert.equal(birth, replacement.birth);
        return "unknown";
      },
    }), /inspection is unavailable or uncertain/);
    assert.equal(inspections, 2, "replacement needs its own inspection; old proof cannot be reused");
    assert.equal(effects, 0);
    const preserved = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(preserved.prepare("SELECT acquisition_id AS id FROM owned_fence_holder").get()!.id, replacement.id); }
    finally { preserved.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const outcome of ["absent", "birth_mismatch"] as const) {
  test(`fresh ${outcome} proof reclaims only the unchanged exact holder`, () => {
    const { root, path, holder } = fixture();
    let effects = 0;
    try {
      withOwnedFenceLockSync(path, () => { effects++; }, {
        holderBirth: "contender-birth",
        inspectHolder: (pid, birth) => {
          assert.equal(pid, holder.pid);
          assert.equal(birth, holder.birth);
          return outcome;
        },
      });
      assert.equal(effects, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("retirement during host inspection remains terminal and performs no effect", () => {
  const { root, path } = fixture();
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: () => {
        transaction(path, (database) => database.exec("UPDATE owned_fence_protocol SET retired = 1"));
        return "absent";
      },
    }), /retired|invalid|unavailable/);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coordination path replacement during inspection cannot authorize any effect", () => {
  const { root, path } = fixture();
  const lstat = fs.lstatSync;
  let identityChanged = false;
  let effects = 0;
  try {
    // Windows denies renaming an open SQLite file. Present the changed inode at
    // the real identity-read boundary to test the same race on every platform.
    fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
      const actual = lstat(...args);
      if (!actual || !identityChanged || String(args[0]) !== path) return actual;
      return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, {
        ino: typeof actual.ino === "bigint" ? actual.ino + 1n : actual.ino + 1,
      });
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: () => {
        identityChanged = true;
        return "absent";
      },
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError, "identity loss also preserves the proposal cleanup refusal");
      assert.equal(error.errors.length, 2);
      for (const original of error.errors) {
        assert.ok(original instanceof OwnedFenceLockUnavailableError);
        assert.equal(original.message, "Owned fence coordination path identity was replaced or disappeared.");
      }
      assert.equal(error.cause, error.errors[0]);
      return true;
    });
    assert.equal(effects, 0);
  } finally {
    fs.lstatSync = lstat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown holder inspection preserves the holder and refuses all effects", () => {
  const { root, path, holder } = fixture();
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth", inspectHolder: () => "unknown",
    }), /inspection is unavailable or uncertain/);
    assert.equal(effects, 0);
    const preserved = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(preserved.prepare("SELECT acquisition_id AS id FROM owned_fence_holder").get()!.id, holder.id); }
    finally { preserved.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a foreign schema installed during inspection cannot authorize stale-holder election", () => {
  const { root, path } = fixture();
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: () => {
        transaction(path, (database) => database.exec("CREATE TRIGGER foreign_holder_trigger BEFORE UPDATE ON owned_fence_holder BEGIN SELECT 1; END"));
        return "absent";
      },
    }), /schema|foreign|trigger/);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holder finalization during an absent inspection permits a fresh ordinary claim", () => {
  const { root, path, holder } = fixture();
  let effects = 0;
  try {
    withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: () => {
        transaction(path, (database) => removeHolder(database, holder.id));
        return "absent";
      },
    });
    assert.equal(effects, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh inspection rejects a malformed joined holder rather than electing over it", () => {
  const { root, path } = fixture();
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: () => {
        transaction(path, (database) => database.exec("UPDATE owned_fence_holder SET holder_birth = 'foreign-birth'"));
        return "absent";
      },
    }), /holder metadata is corrupt or incomplete/);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contender proposal removal during inspection cannot authorize an effect", () => {
  const { root, path, holder } = fixture();
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      inspectHolder: () => {
        transaction(path, (database) => database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id <> ?").run(holder.id));
        return "absent";
      },
    }), /contender acquisition identity changed/);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a slow host inspection cannot elect or perform an effect after the original deadline", () => {
  const { root, path, holder } = fixture();
  const clock = Date.now;
  const started = clock();
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(path, () => { effects++; }, {
      holderBirth: "contender-birth",
      deadlineMs: 100,
      inspectHolder: () => {
        Date.now = () => started + 10_000;
        return "absent";
      },
    }), OwnedFenceContentionError);
    assert.equal(effects, 0);
    const preserved = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(preserved.prepare("SELECT acquisition_id AS id FROM owned_fence_holder").get()!.id, holder.id); }
    finally { preserved.close(); }
  } finally {
    Date.now = clock;
    rmSync(root, { recursive: true, force: true });
  }
});
