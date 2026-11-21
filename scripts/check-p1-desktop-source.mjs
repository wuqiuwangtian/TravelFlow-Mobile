// Only self-created, closed desktop-format fixture files may be opened here.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopFixtureManifest, FIXTURE_APPLICATION_ID } from "../prototypes/p1-store/desktop-source.mjs";
import { SyntheticStore } from "../prototypes/p1-store/sqlite.mjs";
import { emptyFixtureState, legacyKey } from "../prototypes/p1-store/legacy.mjs";

assert.equal(process.argv.length, 2, "Usage: node scripts/check-p1-desktop-source.mjs");
const selection = { dataset: "fixture-desktop", travel: "旧旅行", branch: "分支 A", head: "01" };
const stamp = "2020-01-02T03:04:05";
const ids = ["1", "01"], ledgerID = " É/旧账 ";
const receipt = "a".repeat(32);
const data = {
  days: [{ day: 2, activities: [{ id: "活动", title: "酒店", progress: "not_started", is_context_anchor: false,
    booking: { start_time: "23:40", start_day_offset: 1, duration_minutes: 120, notes: "" }, place: { latitude: 12.125 } }] }],
  expenses: [{ id: ledgerID, amount_cents: 120, title: "票", notes: "", category: "ticket", day: 2, activity_id: "活动",
    budget_item_id: "预算", settles_budget: true, receipt_ids: [receipt], currency: null, paid_on: null,
    created_at: stamp, updated_at: stamp, extra: "source only" }],
  adjustments: [{ id: "退款", expense_id: ledgerID, kind: "refund", status: "pending", amount_cents: 30, notes: "" }],
  budget_items: [{ id: "预算", category: "ticket", planned_cents: 200, source: "custom" }],
  recap: { title: "旧回顾" }, extra_decimal: 1.5,
};
const rawHead = JSON.stringify(data, null, 2).replace('"extra_decimal": 1.5', '"extra_decimal": 1.00000000000000001') + "\n";
const older = structuredClone(data); delete older.expenses[0].currency; delete older.expenses[0].paid_on;
const targetScope = { dataset_id: "fixture-target", branch_id: "fixture-branch", travel_id: "fixture-travel" };
const principal = { authenticated: true, can_write: true, dataset_id: targetScope.dataset_id, source_device_id: "fixture-device" };
const directory = mkdtempSync(path.join(tmpdir(), "travelflow-desktop-source-"));
const source = path.join(directory, "synthetic.sqlite");
let target, targetDir;
function write(work) {
  const db = new DatabaseSync(source);
  try { work(db); } finally { db.close(); }
}
function read(scope = selection) {
  const db = new DatabaseSync(source, { readOnly: true });
  try { return desktopFixtureManifest(db, scope); } finally { db.close(); }
}
function setHead(text) {
  write(db => db.prepare("UPDATE plans SET itinerary=? WHERE version_id=?").run(text, selection.head));
}
function rejected(work, reason) {
  assert.throws(work, error => error.code === reason, reason);
}

try {
  write(db => {
    db.exec(`PRAGMA application_id=${FIXTURE_APPLICATION_ID};
      CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, archived INTEGER, initial_preferences TEXT);
      CREATE TABLE branches(id TEXT PRIMARY KEY, session_id TEXT, title TEXT, parent_branch_id TEXT, fork_version_id TEXT, is_primary INTEGER, created_at TEXT);
      CREATE TABLE versions(id TEXT PRIMARY KEY, branch_id TEXT, seq INTEGER, summary TEXT, detail_level TEXT, trigger TEXT, checkpoint_id TEXT, created_at TEXT);
      CREATE TABLE plans(version_id TEXT PRIMARY KEY, markdown TEXT, citations TEXT, todos TEXT, searched_at TEXT, itinerary TEXT, requirements TEXT);`);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(selection.travel, "旅行", stamp, stamp, 0, '["旧偏好"]');
    const branch = db.prepare("INSERT INTO branches VALUES(?,?,?,?,?,?,?)");
    branch.run("parent", selection.travel, "主方案", null, null, 1, stamp);
    branch.run(selection.branch, selection.travel, "备选", "parent", "base", 0, stamp);
    const version = db.prepare("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)");
    version.run("base", "parent", 1, "", "L2_standard", "manual", null, stamp);
    const plan = db.prepare("INSERT INTO plans VALUES(?,?,?,?,?,?,?)");
    for (const [index, id] of ids.entries()) {
      // The explicitly selected head has a smaller seq than its sibling.
      version.run(id, selection.branch, 8 - index, index ? "" : "旧摘要", "L2_standard", "manual", "check-" + id, stamp);
      plan.run(id, "行前\0原文", "[ ]", "[]", null, id === selection.head ? rawHead : JSON.stringify(older), '{ "legacy": true }');
    }
  });
  const original = readFileSync(source), manifest = read();
  assert.deepEqual(readFileSync(source), original);
  assert.deepEqual(manifest.versions.map(v => v.source_version_id), ["01", "1"]);
  assert.equal(manifest.provenance.branch.fork_version_id, "base");
  assert.equal(manifest.provenance.branch.parent_branch_id, "parent");
  const selected = manifest.versions.find(v => v.source_version_id === selection.head);
  assert.equal(selected.desktop_plan.itinerary, rawHead);
  assert.equal(selected.desktop_version.summary, "");
  assert.equal(selected.desktop_plan.searched_at, null);
  assert.equal(selected.desktop_plan.markdown, "行前\0原文");
  assert.equal(selected.desktop_plan.requirements, '{ "legacy": true }');
  assert.deepEqual(selected.state.activities[0].booking, data.days[0].activities[0].booking);
  assert.equal(selected.state.activities[0].day, 2);
  assert.deepEqual(selected.state.expenses[0].receipt_ids, [receipt]);
  assert.deepEqual(selected.state.links.available_receipt_ids, []);
  assert.equal(selected.state.links.budget_rows[0].planned_cents, 200);
  assert.equal(selected.state.links.budget_rows[0].source, "custom");
  assert.equal(selected.state.adjustments[0].expense_id, ledgerID);

  target = SyntheticStore.create({ ...targetScope, revision_id: "fixture-root", state: emptyFixtureState() });
  targetDir = target.directory;
  const imported = target.importFixtureHistory(manifest, principal);
  assert.equal(imported.accepted, true);
  const inspect = target.inspectFixture();
  assert.equal(inspect.head, imported.mappings.find(row => row.source_version_key === legacyKey("01")).local_revision);
  assert.equal(inspect.state.expenses[0].currency, null);
  assert.equal(inspect.state.expenses[0].paid_on, null);
  for (const row of inspect.tables.fixture_legacy_map) {
    assert.equal(row.lineage, "unknown");
    const saved = JSON.parse(row.source_record);
    assert.equal(saved.desktop_version.checkpoint_id, "check-" + saved.source_version_id);
    if (saved.source_version_id === "1") {
      assert.equal(Object.hasOwn(saved.state.expenses[0], "paid_on"), false);
      assert.equal(Object.hasOwn(saved.state.expenses[0], "currency"), false);
    } else {
      assert.deepEqual(Buffer.from(saved.desktop_plan.itinerary), Buffer.from(rawHead));
      assert.equal(saved.desktop_version.created_at, stamp);
    }
  }
  for (const table of ["fixture_tombstones", "fixture_lifecycle", "fixture_receipts", "fixture_outbox"]) assert.equal(inspect.tables[table].length, 0);
  const edit = { profile: "p1-host-control-1", kind: "expense.patch", operation: { dataset_id: targetScope.dataset_id,
    source_device_id: principal.source_device_id, operation_id: "local-edit" }, target: { branch_id: targetScope.branch_id,
    travel_id: targetScope.travel_id, entity_id: ledgerID }, expected_revision_id: inspect.head, payload: { notes: "本地更正" } };
  assert.equal(target.execute(Buffer.from(JSON.stringify(edit)), principal).accepted, true);
  target.close(); target = undefined;
  target = new SyntheticStore(targetDir);
  const edited = target.inspectFixture();
  assert.equal(edited.state.expenses[0].notes, "本地更正");
  assert.deepEqual(target.importFixtureHistory(read(), principal), { ...imported, replayed: true });
  assert.deepEqual(target.inspectFixture(), edited);
  assert.deepEqual(readFileSync(source), original);

  setHead(rawHead.replace("source only", "changed only in an extension"));
  assert.deepEqual(target.importFixtureHistory(read(), principal), { accepted: false, error: "legacy_import_conflict" });
  rejected(() => read({ ...selection, head: "base" }), "source_head");
  rejected(() => read({ ...selection, travel: "wrong" }), "source_scope");
  for (const [invalid, error] of [
    [null, "source_itinerary_missing"], ["{}", "source_collection"],
    [rawHead.replace('"amount_cents": 120', '"amount_cents": 120.00000000000000001'), "source_integer"],
    [rawHead.replace('"amount_cents": 120', '"amount_cents": 9007199254740992'), "source_integer"],
    [rawHead.replace('"paid_on": null', '"paid_on": null,"paid_on":null'), "duplicate_key"],
    [rawHead.replace('"start_time": "23:40"', '"mode":"resolved_elapsed","start_time":"23:40"'), "source_booking_format"],
    [" ".repeat((1 << 20) + 1), "source_budget"],
    ["[".repeat(33) + "]".repeat(33), "source_budget"],
  ]) {
    setHead(invalid); rejected(() => read(), error);
  }
  write(db => db.prepare("DELETE FROM plans WHERE version_id=?").run(selection.head));
  rejected(() => read(), "source_plan_missing");
  write(db => db.exec("PRAGMA application_id=0"));
  rejected(() => read(), "source_fixture_only");
  assert.deepEqual(target.inspectFixture(), edited);
  console.log("Desktop SQLite fixture: scoped read, exact source text, two durable mappings, local edit/replay, conflict and refusal checks passed.");
} finally {
  target?.close();
  if (targetDir) rmSync(targetDir, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
