import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SyntheticStore, CommitResultUnknown } from "../prototypes/p1-store/sqlite.mjs";
import { HOST_RESOLUTION } from "../prototypes/p1-boundary/families.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 22 || (major === 22 && minor >= 16), "Synthetic SQLite check requires Node22.16+");
assert.notEqual(process.platform, "win32", "SIGKILL evidence requires Linux/WSL or another POSIX host; no skip");
const baseline = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-patch-cases.json", import.meta.url))).baseline;
const families = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-family-cases.json", import.meta.url)));
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const principal = { authenticated: true, can_write: true, can_query: true, dataset_id: "fixture-dataset", source_device_id: "fixture-device" };
function seed() { return { dataset_id: "fixture-dataset", travel_id: "fixture-travel", branch_id: "fixture-branch", revision_id: "fixture-revision-0",
  state: { expenses: [structuredClone(baseline.base)], adjustments: [], activities: [structuredClone(families.activity)],
    calendar: { day: 1, revision_id: "calendar-1", day_date: "2026-11-01" }, links: structuredClone(baseline.context) } }; }
function command(store, operation, payload = {}, kind = "expense.patch", entity = "fictional-expense", revision = store.inspectFixture().head) {
  return { profile: "p1-host-control-1", kind, operation: { dataset_id: "fixture-dataset", source_device_id: "fixture-device", operation_id: operation },
    target: { travel_id: "fixture-travel", branch_id: "fixture-branch", entity_id: entity }, expected_revision_id: revision, payload };
}
function query(operation) { return encode({ profile: "p1-host-query-1", kind: "receipt.lookup", operation: { dataset_id: "fixture-dataset", source_device_id: "fixture-device", operation_id: operation } }); }
function newExpense() {
  const payload = { ...structuredClone(baseline.base), receipt_ids: [], allow_shared_receipts: false };
  for (const key of ["id", "created_at", "updated_at"]) delete payload[key];
  return payload;
}

// Only the spawned worker deliberately kills itself, using a marked temporary
// fixture directory. The parent never signals another application or process.
if (process.argv[2] === "--crash-worker") {
  assert.equal(process.argv.length, 5);
  const phase = process.argv[4]; assert.ok(["before_commit", "after_commit"].includes(phase));
  const store = new SyntheticStore(process.argv[3]);
  const body = command(store, `crash-${phase}`, { notes: phase });
  store.execute(encode(body), principal, { fault: at => { if (at === phase) process.kill(process.pid, "SIGKILL"); } });
  throw new Error("Crash hook did not execute");
} else {
  assert.equal(process.argv.length, 2, "Usage: node scripts/check-p1-store.mjs");
  const directories = [], stores = new Set(); let cases = 0, sqlite;
  const create = value => { const store = SyntheticStore.create(value ?? seed()); directories.push(store.directory); stores.add(store); sqlite = store.sqliteVersion(); return store; };
  const close = store => { store.close(); stores.delete(store); };
  const reopen = directory => { const store = new SyntheticStore(directory); stores.add(store); return store; };
  const count = (store, table) => store.inspectFixture().tables[`fixture_${table}`].length;
  const test = (name, work) => { work(); cases++; };
  try {
    test("business/history/receipt/outbox commit together", () => {
      const store = create(), old = store.inspectFixture(), body = command(store, "first", { notes: "changed" });
      const response = store.execute(encode(body), principal, { stamp: "2026-11-17T01:00:00.000Z" });
      assert.equal(response.effect, "changed"); assert.equal(response.replayed, false);
      assert.equal(store.inspectFixture().state.expenses[0].notes, "changed");
      assert.equal(store.inspectFixture().state.expenses[0].updated_at, "2026-11-17T01:00:00.000Z");
      assert.equal(count(store, "revisions"), 2); assert.equal(count(store, "receipts"), 1); assert.equal(count(store, "outbox"), 1);
      assert.equal(store.inspectFixture().tables.fixture_revisions[0].snapshot, old.tables.fixture_revisions[0].snapshot);
      const changed = store.totalChanges(); assert.equal(store.execute(encode(body), principal).replayed, true); assert.equal(store.totalChanges(), changed);
      assert.equal(store.query(query("first"), principal).receipt.result_revision_id, response.result_revision_id);
    });
    test("no change creates only receipt and operation outbox", () => {
      const store = create(), head = store.inspectFixture().head, old = structuredClone(store.inspectFixture().state);
      const body = command(store, "noop", {}), response = store.execute(encode(body), principal);
      assert.equal(response.effect, "no_change"); assert.equal(response.result_revision_id, head);
      assert.equal(count(store, "revisions"), 1); assert.equal(count(store, "receipts"), 1); assert.equal(count(store, "outbox"), 1);
      assert.deepEqual(store.inspectFixture().state, old);
      const changes = store.totalChanges(); store.execute(encode(body), principal); assert.equal(store.totalChanges(), changes);
      assert.equal(store.query(query("noop"), principal).receipt.effect, "no_change");
    });
    test("explicit CNY creation preserves old expense and assigns audit time", () => {
      const store = create(), oldExpense = structuredClone(store.inspectFixture().state.expenses[0]);
      const body = command(store, "create-expense", newExpense(), "expense.create", "created-expense");
      assert.equal(store.execute(encode(body), principal, { stamp: "2026-11-17T00:00:00.000Z" }).accepted, true);
      const rows = store.inspectFixture().state.expenses; assert.equal(rows.length, 2); assert.deepEqual(rows[0], oldExpense);
      assert.equal(rows[1].created_at, "2026-11-17T00:00:00.000Z"); assert.equal(rows[1].currency, "CNY");
      assert.equal(store.execute(encode(body), principal).replayed, true); assert.equal(store.inspectFixture().state.expenses.length, 2);
    });
    test("same operation different intent leaves all rows unchanged", () => {
      const store = create(), body = command(store, "conflict", { notes: "a" }); store.execute(encode(body), principal);
      const old = JSON.stringify(store.inspectFixture()), changes = store.totalChanges();
      assert.equal(store.execute(encode({ ...body, payload: { notes: "b" } }), principal).error, "intent_conflict");
      assert.equal(JSON.stringify(store.inspectFixture()), old); assert.equal(store.totalChanges(), changes);
    });
    test("stale new operation is rejected inside the transaction", () => {
      const store = create(), first = command(store, "advance", { notes: "new" }), stale = command(store, "stale", {});
      store.execute(encode(first), principal); const old = JSON.stringify(store.inspectFixture());
      assert.equal(store.execute(encode(stale), principal).error, "baseline_conflict"); assert.equal(JSON.stringify(store.inspectFixture()), old);
    });
    for (const phase of ["after_business", "after_receipt", "after_outbox", "before_commit"]) test(`fault rollback at ${phase}`, () => {
      const store = create(), body = command(store, phase, { notes: phase }), old = JSON.stringify(store.inspectFixture());
      assert.throws(() => store.execute(encode(body), principal, { fault: at => { if (at === phase) throw new Error("fixture-fault"); } }), /fixture-fault/);
      assert.equal(JSON.stringify(store.inspectFixture()), old);
      assert.equal(store.query(query(phase), principal).state, "not_found_at_settled_read");
      assert.equal(store.execute(encode(body), principal).effect, "changed");
    });
    test("response lost after commit is recovered by original key after reopen", () => {
      let store = create(); const body = command(store, "lost-response", { notes: "saved" }), directory = store.directory;
      assert.throws(() => store.execute(encode(body), principal, { fault: at => { if (at === "after_commit") throw new Error("lost"); } }), CommitResultUnknown);
      close(store); store = reopen(directory);
      assert.equal(store.query(query("lost-response"), principal).state, "committed");
      assert.equal(store.execute(encode(body), principal).replayed, true);
      assert.equal(count(store, "revisions"), 2); assert.equal(count(store, "receipts"), 1); assert.equal(count(store, "outbox"), 1);
    });
    test("deleted entity cannot be revived by replay or new create", () => {
      const store = create(), original = command(store, "original", newExpense(), "expense.create", "created-expense"); store.execute(encode(original), principal);
      store.execute(encode(command(store, "delete", {}, "expense.delete", "created-expense")), principal);
      assert.equal(store.inspectFixture().state.expenses.some(row => row.id === "created-expense"), false); assert.equal(count(store, "tombstones"), 1);
      const changes = store.totalChanges(); assert.equal(store.execute(encode(original), principal).replayed, true); assert.equal(store.totalChanges(), changes);
      assert.equal(store.execute(encode(command(store, "new-create", newExpense(), "expense.create", "created-expense")), principal).error, "entity_deleted");
      assert.equal(store.inspectFixture().state.expenses.some(row => row.id === "created-expense"), false);
    });
    test("pending to received edits one adjustment and protects expense deletion", () => {
      const store = create(), payload = { expense_id: "fictional-expense", kind: "refund", amount_cents: 3000, currency: "CNY", status: "pending", notes: "" };
      assert.equal(store.execute(encode(command(store, "refund", payload, "adjustment.create", "refund-1")), principal).accepted, true);
      assert.equal(store.execute(encode(command(store, "received", { status: "received" }, "adjustment.patch", "refund-1")), principal).accepted, true);
      assert.equal(store.inspectFixture().state.adjustments.length, 1); assert.equal(store.inspectFixture().state.adjustments[0].status, "received");
      assert.equal(store.execute(encode(command(store, "bad-delete", {}, "expense.delete")), principal).error, "recovery_exists");
      assert.equal(store.execute(encode(command(store, "remove-refund", {}, "adjustment.delete", "refund-1")), principal).accepted, true);
      assert.equal(store.execute(encode(command(store, "remove-expense", {}, "expense.delete")), principal).accepted, true);
    });
    test("progress time is assigned once and no-op does not refresh it", () => {
      const store = create(), body = command(store, "progress", { progress: "completed" }, "progress.set", "activity-1");
      store.execute(encode(body), principal, { stamp: "2026-11-17T02:00:00.000Z" });
      const head = store.inspectFixture().head;
      store.execute(encode(command(store, "same-progress", { progress: "completed" }, "progress.set", "activity-1")), principal, { stamp: "later" });
      assert.equal(store.inspectFixture().head, head); assert.equal(store.inspectFixture().state.activities[0].progress_updated_at, "2026-11-17T02:00:00.000Z");
      assert.equal(store.execute(encode(command(store, "clear-completed", {}, "booking.clear", "activity-1")), principal).error, "booking_protected");
    });
    test("booking clear preserves clock and historical booking", () => {
      const store = create(), old = store.inspectFixture().tables.fixture_revisions[0].snapshot;
      store.execute(encode(command(store, "clear", {}, "booking.clear", "activity-1")), principal);
      const activity = store.inspectFixture().state.activities[0]; assert.equal(activity.booking, null); assert.equal(activity.start_time, "23:40");
      assert.equal(activity.start_day_offset, 1); assert.equal(activity.duration_minutes, 120);
      assert.equal(store.inspectFixture().tables.fixture_revisions[0].snapshot, old);
    });
    test("resolved booking persists basis and replays after progress protection changes", () => {
      const store = create(), payload = { start_time: "01:30", start_day_offset: 0, duration_minutes: 120, notes: "fixed",
        local_start: "2026-11-01T01:30", time_zone: "America/New_York", utc_offset: "-04:00", start_instant: "2026-11-01T05:30:00.000Z", duration_semantics: "elapsed",
        resolution_basis: { calendar_revision_id: "calendar-1", zone_catalogue_id: HOST_RESOLUTION.zone_catalogue_id, tzdata_version: HOST_RESOLUTION.tzdata_version } };
      const original = command(store, "resolved-booking", payload, "booking.set", "activity-1");
      assert.equal(store.execute(encode(original), principal).accepted, true);
      assert.equal(store.inspectFixture().state.activities[0].booking.end_local, "2026-11-01T02:30");
      store.execute(encode(command(store, "start-activity", { progress: "in_progress" }, "progress.set", "activity-1")), principal);
      const changes = store.totalChanges(); assert.equal(store.execute(encode(original), principal).replayed, true); assert.equal(store.totalChanges(), changes);
    });
    test("legacy unknown correction stays unknown after reopen", () => {
      const data = seed(); delete data.state.expenses[0].currency;
      let store = create(data), directory = store.directory;
      store.execute(encode(command(store, "legacy-correction", { amount_cents: 12000 })), principal); close(store); store = reopen(directory);
      assert.equal(Object.hasOwn(store.inspectFixture().state.expenses[0], "currency"), false);
      assert.equal(store.inspectFixture().state.expenses[0].amount_cents, 12000);
    });
    test("booking resolves against the target activity day, not the first trip day", () => {
      const data = seed(); data.state.activities.push({ ...structuredClone(families.activity), id: "activity-2", day: 2 });
      data.state.calendars = [data.state.calendar, { day: 2, revision_id: "calendar-2", day_date: "2026-11-02" }];
      const store = create(data), payload = { start_time: "01:30", start_day_offset: 0, duration_minutes: 120, notes: "day two",
        local_start: "2026-11-02T01:30", time_zone: "America/New_York", utc_offset: "-05:00", start_instant: "2026-11-02T06:30:00.000Z", duration_semantics: "elapsed",
        resolution_basis: { calendar_revision_id: "calendar-2", zone_catalogue_id: HOST_RESOLUTION.zone_catalogue_id, tzdata_version: HOST_RESOLUTION.tzdata_version } };
      assert.equal(store.execute(encode(command(store, "day-two-booking", payload, "booking.set", "activity-2")), principal).accepted, true);
      assert.equal(store.inspectFixture().state.activities[1].booking.local_start, "2026-11-02T01:30");
    });
    test("raw resource/schema and authority failures never begin SQL transaction", () => {
      const store = create(), old = JSON.stringify(store.inspectFixture()), changes = store.totalChanges();
      assert.equal(store.execute(new Uint8Array(32769), principal).error, "resource_bytes");
      const huge = JSON.stringify(command(store, "huge", { amount_cents: "TOKEN" })).replace('"TOKEN"', "1e1000000000");
      assert.equal(store.execute(new TextEncoder().encode(huge), principal).error, "integer_range");
      assert.equal(store.execute(encode(command(store, "denied", {})), { ...principal, can_write: false }).error, "denied");
      assert.equal(store.stats.begins, 0); assert.equal(store.totalChanges(), changes); assert.equal(JSON.stringify(store.inspectFixture()), old);
    });
    test("query denies before existence read", () => {
      const store = create();
      assert.equal(store.query(query("anything"), { ...principal, can_query: false }).error, "denied");
      assert.equal(store.stats.begins, 0); assert.equal(store.stats.receipt_reads, 0);
      assert.equal(store.query(new Uint8Array(8193), principal).error, "resource_bytes"); assert.equal(store.stats.begins, 0);
    });
    test("separate connections serialize writes and expose unknown while locked", () => {
      const one = create(), two = reopen(one.directory), body = command(one, "same-key", { notes: "once" });
      one.holdFixtureLock(() => {
        assert.equal(two.execute(encode(body), principal).error, "storage_busy");
        assert.equal(two.query(query("same-key"), principal).state, "unknown");
      });
      assert.equal(one.execute(encode(body), principal).replayed, false); assert.equal(two.execute(encode(body), principal).replayed, true);
      assert.equal(count(two, "receipts"), 1); assert.equal(count(two, "revisions"), 2);
    });
    for (const phase of ["before_commit", "after_commit"]) test(`own subprocess SIGKILL at ${phase}`, () => {
      let store = create(), directory = store.directory; close(store);
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash-worker", directory, phase], { encoding: "utf8", timeout: 15000 });
      assert.ifError(child.error); assert.equal(child.signal, "SIGKILL", child.stderr); store = reopen(directory);
      const expected = phase === "before_commit" ? 0 : 1;
      assert.equal(count(store, "receipts"), expected); assert.equal(count(store, "outbox"), expected); assert.equal(count(store, "revisions"), 1 + expected);
      assert.equal(store.query(query(`crash-${phase}`), principal).state, expected ? "committed" : "not_found_at_settled_read");
    });
    test("unmarked or missing databases are never initialized on open", () => {
      const directory = mkdtempSync(path.join(tmpdir(), "travelflow-unmarked-")); directories.push(directory);
      assert.throws(() => new SyntheticStore(directory), error => error.code === "synthetic_path");
      const store = create(), owned = store.directory; close(store); rmSync(path.join(owned, "synthetic.sqlite"));
      assert.throws(() => new SyntheticStore(owned), error => error.code === "storage_missing");
    });
  } finally {
    for (const store of stores) store.close();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ synthetic_sqlite_cases: cases, sqlite, node: process.version,
    atomic_business_receipt_outbox_checked: true, no_change_receipt_checked: true, process_exit_recovery_checked: true,
    scope: "marked temporary host SQLite only; synthetic authority; one branch per fixture DB",
    real_authentication_verified: false, android_native_executed: false, power_loss_or_disk_full_verified: false,
    shared_contract_version: null, formally_adopted_storage: false }, null, 2));
}
