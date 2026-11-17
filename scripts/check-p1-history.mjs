import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { SyntheticStore, CommitResultUnknown } from "../prototypes/p1-store/sqlite.mjs";
import { legacyKey, emptyFixtureState, LEGACY_LIMITS } from "../prototypes/p1-store/legacy.mjs";
import { CandidateBoundary, controlIntent, capabilities } from "../prototypes/p1-boundary/commands.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 22 || (major === 22 && minor >= 16), "History check requires Node22.16+");
const baseline = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-patch-cases.json", import.meta.url))).baseline;
const activity = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-family-cases.json", import.meta.url))).activity;
const clone = structuredClone, encode = value => new TextEncoder().encode(JSON.stringify(value));
const scope = { dataset_id: "fixture-dataset", travel_id: "fixture-travel", branch_id: "fixture-branch" };
const principal = { authenticated: true, can_write: true, can_query: true, dataset_id: scope.dataset_id, source_device_id: "fixture-device" };
const receipt = baseline.base.receipt_ids[0];
const directories = [], stores = new Set(), cases = [];
function state() { return { expenses: [clone(baseline.base)], adjustments: [], activities: [clone(activity)],
  calendar: { day: 1, revision_id: "calendar-1", day_date: "2026-11-01" }, links: { ...clone(baseline.context), available_receipt_ids: [receipt] } }; }
function create(data = state()) {
  const store = SyntheticStore.create({ ...scope, revision_id: "fixture-root", state: data });
  directories.push(store.directory); stores.add(store); return store;
}
const empty = emptyFixtureState;
function reopen(store) { const directory = store.directory; store.close(); stores.delete(store); const next = new SyntheticStore(directory); stores.add(next); return next; }
function command(store, operation_id, kind, payload = {}, entity_id = baseline.base.id, revision = store.inspectFixture().head) {
  return { profile: "p1-host-control-1", kind, operation: { dataset_id: scope.dataset_id, source_device_id: principal.source_device_id, operation_id },
    target: { travel_id: scope.travel_id, branch_id: scope.branch_id, entity_id }, expected_revision_id: revision, payload };
}
const execute = (store, body, options) => store.execute(encode(body), principal, options);
function deleted(store, type = "expense", entity = baseline.base.id) {
  const source = store.inspectFixture().head;
  assert.equal(execute(store, command(store, `delete-${source}-${entity}`, `${type}.delete`, {}, entity)).accepted, true);
  return { source: { ...scope, revision_id: source }, ...(type === "expense" ? { allow_shared_receipts: false } : {}) };
}
function newExpense() {
  const payload = { ...clone(baseline.base), allow_shared_receipts: false };
  for (const key of ["id", "created_at", "updated_at"]) delete payload[key];
  return payload;
}
function manifest() {
  const old = state(); delete old.expenses[0].currency; delete old.expenses[0].paid_on;
  old.expenses[0].id = "Legacy/票据-ID_A";
  old.activities[0].booking.legacy_extra = { original_clock: "23:40", zone: null };
  return { fixture_format_version: 1, source_system: "TravelFlow-AI-fixture", source_dataset_id: 1,
    source_travel_id: "trip/A", source_branch_id: "Main ", head_source_version_id: "1",
    provenance: { label: "synthetic", original_time: "2020-01-02 03:04:05", timezone: null },
    fork_reference: { branch_id: "old branch", version_id: 1 },
    // Deliberately reverse explicit parent order; number 1 differs from "1".
    versions: [{ source_version_id: "1", parent_source_version_id: 1, state: clone(old), audit: { note: "verbatim" } },
      { source_version_id: 1, parent_source_version_id: null, state: clone(old) },
      { source_version_id: "unlinked", state: clone(old) },
      { source_version_id: "orphan", parent_source_version_id: "missing", state: clone(old) }] };
}
const test = (name, work) => cases.push({ name, work });
function rejectedWithoutWrites(store, body, error) {
  const before = store.inspectFixture(); assert.deepEqual(execute(store, body), { accepted: false, error });
  assert.deepEqual(store.inspectFixture(), before);
}
function importRejected(store, input, error) {
  const before = store.inspectFixture(); assert.deepEqual(store.importFixtureHistory(input, principal), { accepted: false, error });
  assert.deepEqual(store.inspectFixture(), before);
}

test("restore preserves source facts and appends durable lifecycle/receipt/outbox", () => {
  const store = create(), old = clone(store.inspectFixture().state.expenses[0]), payload = deleted(store);
  const body = command(store, "restore", "expense.restore", payload), stamp = "2026-11-17T05:00:00.000Z";
  const result = execute(store, body, { stamp }); assert.equal(result.accepted, true); assert.equal(result.effect, "changed");
  assert.deepEqual(store.inspectFixture().state.expenses[0], { ...old, updated_at: stamp });
  const tables = store.inspectFixture().tables;
  assert.deepEqual(tables.fixture_lifecycle.map(row => row.action), ["delete", "restore"]);
  assert.equal(tables.fixture_lifecycle[1].source_revision, payload.source.revision_id);
  assert.equal(tables.fixture_tombstones[0].active, 0); assert.equal(tables.fixture_tombstones[0].restored_revision, result.result_revision_id);
  assert.equal(tables.fixture_receipts.length, 2); assert.equal(tables.fixture_outbox.length, 2);
  assert.equal(JSON.parse(tables.fixture_revisions[0].snapshot).expenses[0].updated_at, old.updated_at);
});
test("reopen and original restore replay after a second delete never resurrects", () => {
  let store = create(); const payload = deleted(store), body = command(store, "restore", "expense.restore", payload);
  const original = execute(store, body); deleted(store); store = reopen(store);
  const before = store.inspectFixture(), changes = store.totalChanges();
  assert.deepEqual(execute(store, body), { ...original, replayed: true });
  assert.deepEqual(store.inspectFixture(), before); assert.equal(store.totalChanges(), changes); assert.equal(before.state.expenses.length, 0);
  assert.equal(before.tables.fixture_lifecycle.length, 3);
  assert.equal(execute(store, command(store, "restore-again", "expense.restore", payload)).accepted, true);
  assert.equal(store.inspectFixture().tables.fixture_lifecycle.length, 4);
});
test("new operation cannot restore over a live entity; old key cannot change source", () => {
  const store = create(), payload = deleted(store), body = command(store, "restore", "expense.restore", payload);
  assert.equal(execute(store, body).accepted, true);
  rejectedWithoutWrites(store, command(store, "new-restore", "expense.restore", payload), "entity_exists");
  const different = clone(body); different.payload.source.revision_id = "another";
  rejectedWithoutWrites(store, different, "intent_conflict");
});
for (const mode of ["absent", "null"]) test(`unknown currency/paid_on ${mode} remains exact after reopen`, () => {
  const data = state(); for (const key of ["currency", "paid_on"]) { if (mode === "absent") delete data.expenses[0][key]; else data.expenses[0][key] = null; }
  let store = create(data); const payload = deleted(store);
  assert.equal(execute(store, command(store, "restore", "expense.restore", payload)).accepted, true); store = reopen(store);
  const restored = store.inspectFixture().state.expenses[0];
  for (const key of ["currency", "paid_on"]) { assert.equal(Object.hasOwn(restored, key), mode === "null"); if (mode === "null") assert.equal(restored[key], null); }
});
test("untouched old text is preserved without trimming or new-text revalidation", () => {
  const data = state(); data.expenses[0].title = " \uFEFF旧标题 "; data.expenses[0].notes = "old\u0001note";
  const store = create(data), payload = deleted(store);
  assert.equal(execute(store, command(store, "restore", "expense.restore", payload)).accepted, true);
  assert.equal(store.inspectFixture().state.expenses[0].title, data.expenses[0].title);
  assert.equal(store.inspectFixture().state.expenses[0].notes, data.expenses[0].notes);
});
for (const field of ["dataset_id", "travel_id", "branch_id"]) test(`source ${field} cannot cross scope`, () => {
  const store = create(), payload = deleted(store); payload.source[field] = "fixture-other";
  rejectedWithoutWrites(store, command(store, "restore", "expense.restore", payload), "restore_source_scope");
});
test("stale restore checks baseline before resolving missing source", () => {
  const store = create(), payload = deleted(store); payload.source.revision_id = "missing";
  rejectedWithoutWrites(store, command(store, "restore", "expense.restore", payload, baseline.base.id, "stale"), "baseline_conflict");
});
test("deleted revision or unknown revision cannot supply entity facts", () => {
  const store = create(), payload = deleted(store);
  for (const revision of [store.inspectFixture().head, "missing"]) {
    payload.source.revision_id = revision;
    rejectedWithoutWrites(store, command(store, `restore-${revision}`, "expense.restore", payload), "restore_source_missing");
  }
});
test("history presence without an active deletion does not authorize resurrection", () => {
  const store = create(empty());
  rejectedWithoutWrites(store, command(store, "restore", "expense.restore", { source: { ...scope, revision_id: "fixture-root" }, allow_shared_receipts: false }), "restore_not_deleted");
});
test("restore raw shape rejects fact rewrites and missing receipt control before BEGIN", () => {
  const store = create(), payload = deleted(store), begins = store.stats.begins;
  const bad = [{ ...payload, amount_cents: 123 }, { ...payload, link_overrides: { paid_on: null } }, { source: payload.source }];
  for (const input of bad) assert.equal(execute(store, command(store, "bad", "expense.restore", input)).accepted, false);
  assert.equal(store.stats.begins, begins);
});
test("unavailable historical receipt blocks restore; explicit unlink preserves history", () => {
  const data = state(); data.links.available_receipt_ids = [];
  const store = create(data), payload = deleted(store);
  rejectedWithoutWrites(store, command(store, "restore", "expense.restore", payload), "receipt_unavailable");
  payload.link_overrides = { receipt_ids: [] };
  assert.equal(execute(store, command(store, "restore-cleared", "expense.restore", payload)).accepted, true);
  assert.deepEqual(store.inspectFixture().state.expenses[0].receipt_ids, []);
  assert.deepEqual(JSON.parse(store.inspectFixture().tables.fixture_revisions[0].snapshot).expenses[0].receipt_ids, [receipt]);
});
test("receipt sharing derives from current expenses, including newly created ones", () => {
  const store = create(), payload = deleted(store);
  assert.equal(execute(store, command(store, "other", "expense.create", newExpense(), "other-expense")).accepted, true);
  rejectedWithoutWrites(store, command(store, "restore", "expense.restore", payload), "receipt_shared");
  payload.allow_shared_receipts = true;
  assert.equal(execute(store, command(store, "restore-shared", "expense.restore", payload)).accepted, true);
});
for (const [link, error, repair] of [["days", "day_link", { day: null }], ["activity", "activity_link", { activity_id: null }],
  ["budget_rows", "budget_link", { budget_item_id: null, settles_budget: false }]]) test(`restore rechecks current ${link} and requires explicit repair`, () => {
  const data = state(); if (link === "activity") data.activities = []; else data.links[link] = [];
  const store = create(data), payload = deleted(store);
  rejectedWithoutWrites(store, command(store, "restore", "expense.restore", payload), error);
  payload.link_overrides = repair;
  assert.equal(execute(store, command(store, "restore-relinked", "expense.restore", payload)).accepted, true);
  assert.equal(store.inspectFixture().state.expenses[0].paid_on, baseline.base.paid_on);
});
for (const [key, value, error] of [["amount_cents", 10000000000, "history_amount_unsupported"], ["currency", "USD", "history_currency_unsupported"]])
  test(`unsupported historical ${key} is preserved and refused without conversion`, () => {
    const data = state(); data.expenses[0][key] = value; const store = create(data), payload = deleted(store);
    rejectedWithoutWrites(store, command(store, "restore", "expense.restore", payload), error);
    assert.equal(JSON.parse(store.inspectFixture().tables.fixture_revisions[0].snapshot).expenses[0][key], value);
  });
function adjustmentStore() {
  const data = state(); data.adjustments = [{ id: "refund-old", expense_id: baseline.base.id, kind: "refund", amount_cents: 6000, currency: "CNY", status: "pending", notes: "old" }];
  const store = create(data); return { store, payload: deleted(store, "adjustment", "refund-old") };
}
test("adjustment restore counts pending claims of same kind", () => {
  const { store, payload } = adjustmentStore();
  assert.equal(execute(store, command(store, "other", "adjustment.create", { expense_id: baseline.base.id, kind: "refund", amount_cents: 6000, currency: "CNY", status: "pending", notes: "" }, "refund-new")).accepted, true);
  rejectedWithoutWrites(store, command(store, "restore", "adjustment.restore", payload, "refund-old"), "recovery_limit");
});
test("adjustment restore keeps refund/reimbursement limits separate", () => {
  const { store, payload } = adjustmentStore();
  assert.equal(execute(store, command(store, "other", "adjustment.create", { expense_id: baseline.base.id, kind: "reimbursement", amount_cents: 6000, currency: "CNY", status: "pending", notes: "" }, "reimburse-new")).accepted, true);
  assert.equal(execute(store, command(store, "restore", "adjustment.restore", payload, "refund-old")).accepted, true);
  assert.equal(store.inspectFixture().state.adjustments.find(row => row.id === "refund-old").status, "pending");
});
test("adjustment restore uses current expense amount and requires a live expense", () => {
  const { store, payload } = adjustmentStore();
  assert.equal(execute(store, command(store, "lower", "expense.patch", { amount_cents: 4000 })).accepted, true);
  rejectedWithoutWrites(store, command(store, "restore", "adjustment.restore", payload, "refund-old"), "recovery_limit");
  deleted(store); rejectedWithoutWrites(store, command(store, "restore2", "adjustment.restore", payload, "refund-old"), "currency_link");
});
for (const phase of ["after_business", "after_receipt", "after_outbox", "before_commit"]) test(`restore ${phase} fault rolls lifecycle and every row back`, () => {
  const store = create(), payload = deleted(store), before = store.inspectFixture(), body = command(store, "restore", "expense.restore", payload);
  assert.throws(() => execute(store, body, { fault: at => { if (at === phase) throw new Error("injected"); } }), /injected/);
  assert.deepEqual(store.inspectFixture(), before);
  assert.equal(execute(store, body).accepted, true);
});
test("restore committed response loss resolves to original receipt after reopen", () => {
  let store = create(); const payload = deleted(store), body = command(store, "restore", "expense.restore", payload);
  assert.throws(() => execute(store, body, { fault: at => { if (at === "after_commit") throw new Error("lost"); } }), CommitResultUnknown);
  const committed = store.inspectFixture(); store = reopen(store);
  assert.equal(execute(store, body).replayed, true); assert.deepEqual(store.inspectFixture(), committed);
});
test("boundary restore replay precedes source read and current state inspection", async () => {
  const store = create(), body = command(store, "restore", "expense.restore", deleted(store));
  const intent = controlIntent(encode(body));
  const result = await new CandidateBoundary().control(encode(body), { principal, authorize: async () => true,
    lookupReceipt: async () => ({ state: "committed", intent, effect: "changed", result_revision_id: "original" }),
    inspect: async () => { throw new Error("must not inspect"); } });
  assert.equal(result.kind, "replay-view"); assert.equal(result.receipt.result_revision_id, "original");
  const caps = capabilities(encode({ profile: "p1-host-query-1", kind: "capabilities.query" }));
  assert.ok(caps.control_commands.includes("expense.restore") && caps.control_commands.includes("adjustment.restore"));
});
test("import maps typed exact IDs, explicit ancestry and unknown provenance without inventing receipts", () => {
  const store = create(empty()), input = manifest(), before = clone(input), result = store.importFixtureHistory(input, principal);
  assert.equal(result.accepted, true); assert.equal(result.mappings.length, 4); assert.deepEqual(input, before);
  const tables = store.inspectFixture().tables, mapping = new Map(tables.fixture_legacy_map.map(row => [row.source_version_key, row]));
  assert.notEqual(mapping.get(legacyKey(1)).local_revision, mapping.get(legacyKey("1")).local_revision);
  const revisions = new Map(tables.fixture_revisions.map(row => [row.id, row]));
  assert.equal(revisions.get(mapping.get(legacyKey("1")).local_revision).parent_id, mapping.get(legacyKey(1)).local_revision);
  for (const [id, lineage] of [[1, "root"], ["unlinked", "unknown"], ["orphan", "unresolved"]]) {
    assert.equal(mapping.get(legacyKey(id)).lineage, lineage); assert.equal(revisions.get(mapping.get(legacyKey(id)).local_revision).parent_id, null);
  }
  assert.deepEqual(store.inspectFixture().state, input.versions[0].state);
  assert.equal(tables.fixture_receipts.length, 0); assert.equal(tables.fixture_outbox.length, 0); assert.equal(tables.fixture_lifecycle.length, 0);
  assert.deepEqual(JSON.parse(tables.fixture_import_batches[0].header).provenance, input.provenance);
  assert.deepEqual(JSON.parse(mapping.get(legacyKey("1")).source_record), input.versions[0]);
});
test("import mappings survive reopen; repetition after local edit never resets head", () => {
  let store = create(empty()); const input = manifest(), imported = store.importFixtureHistory(input, principal);
  const oldID = input.versions[0].state.expenses[0].id;
  assert.equal(execute(store, command(store, "local-edit", "expense.patch", { notes: "local correction" }, oldID)).accepted, true);
  store = reopen(store); const before = store.inspectFixture(), changes = store.totalChanges();
  const result = store.importFixtureHistory(input, principal);
  assert.equal(result.replayed, true); assert.deepEqual(result.mappings, imported.mappings);
  assert.equal(store.totalChanges(), changes); assert.deepEqual(store.inspectFixture(), before);
});
test("mapped history is an explicit restore source after a local delete", () => {
  const store = create(empty()), input = manifest(), imported = store.importFixtureHistory(input, principal), id = input.versions[0].state.expenses[0].id;
  const mapped = imported.mappings.find(row => row.source_version_key === legacyKey("1")).local_revision;
  deleted(store, "expense", id);
  const body = command(store, "restore-legacy", "expense.restore", { source: { ...scope, revision_id: mapped }, allow_shared_receipts: false }, id);
  assert.equal(execute(store, body).accepted, true);
  const restored = store.inspectFixture().state.expenses[0]; assert.equal(restored.id, id);
  assert.equal(Object.hasOwn(restored, "paid_on"), false); assert.equal(Object.hasOwn(restored, "currency"), false);
});
for (const change of ["facts", "head", "extension", "source", "provenance"]) test(`reimport changed ${change} conflicts without overwriting local facts`, () => {
  const store = create(empty()), input = manifest(); assert.equal(store.importFixtureHistory(input, principal).accepted, true);
  if (change === "facts") input.versions[0].state.expenses[0].amount_cents = 12000;
  if (change === "head") input.head_source_version_id = 1;
  if (change === "extension") input.versions.push({ source_version_id: "new", state: state() });
  if (change === "source") input.source_dataset_id = "1";
  if (change === "provenance") input.provenance.label = "changed";
  importRejected(store, input, "legacy_import_conflict");
});
test("different source scopes never alias equal old version IDs", () => {
  const first = create(empty()), second = create(empty()), one = manifest(), two = manifest(); two.source_branch_id = "Other";
  const a = first.importFixtureHistory(one, principal), b = second.importFixtureHistory(two, principal);
  assert.notEqual(a.mappings[0].local_revision, b.mappings[0].local_revision);
  assert.notEqual(first.inspectFixture().tables.fixture_legacy_map[0].source_identity, second.inspectFixture().tables.fixture_legacy_map[0].source_identity);
});
test("case, spaces, NFC/NFD and entity types remain distinct without ID rewriting", () => {
  const store = create(empty()), input = manifest(), ids = ["ID", "id", " ID ", "\u00C9", "E\u0301"];
  for (const version of input.versions) {
    version.state.expenses = ids.map(id => ({ ...clone(baseline.base), id }));
    version.state.adjustments = [{ id: "ID", expense_id: "ID", kind: "refund", amount_cents: 1, status: "pending" }];
  }
  assert.equal(store.importFixtureHistory(input, principal).accepted, true);
  assert.deepEqual(store.inspectFixture().state.expenses.map(row => row.id), ids);
  assert.equal(store.inspectFixture().state.adjustments[0].id, "ID");
});
test("history order does not imply ancestry or affect reimport identity", () => {
  const store = create(empty()), input = manifest(); assert.equal(store.importFixtureHistory(input, principal).accepted, true);
  input.versions.reverse(); const before = store.inspectFixture();
  assert.equal(store.importFixtureHistory(input, principal).replayed, true); assert.deepEqual(store.inspectFixture(), before);
});
for (const [name, mutate, error] of [
  ["cycle", m => { m.versions[1].parent_source_version_id = "1"; }, "legacy_cycle"],
  ["duplicate version", m => { m.versions.push(clone(m.versions[0])); }, "legacy_duplicate_version"],
  ["duplicate entity", m => { m.versions[0].state.expenses.push(clone(m.versions[0].state.expenses[0])); }, "legacy_duplicate_entity"],
  ["numeric entity ID", m => { m.versions[0].state.expenses[0].id = 1; }, "legacy_id"],
  ["unsafe number", m => { m.versions[0].state.expenses[0].amount_cents = Number.MAX_SAFE_INTEGER + 1; }, "legacy_number"],
  ["fractional money", m => { m.versions[0].state.expenses[0].amount_cents = 1.5; }, "legacy_money"],
  ["nonfinite", m => { m.versions[0].audit = { amount: Infinity }; }, "legacy_number"],
  ["undefined", m => { m.provenance.missing = undefined; }, "legacy_json"],
  ["array serialization hook", m => { Object.defineProperty(m.versions, "toJSON", { value: () => [] }); }, "legacy_json"],
  ["lone surrogate", m => { m.source_dataset_id = "\uD800"; }, "unicode"],
  ["overlarge string", m => { m.provenance.label = "x".repeat(LEGACY_LIMITS.bytes + 1); }, "legacy_budget"],
  ["too deep", m => { let node = m.provenance; for (let i = 0; i < 40; i++) node = node.next = {}; }, "legacy_budget"],
  ["too many versions", m => { m.versions = Array.from({ length: LEGACY_LIMITS.versions + 1 }, (_, i) => ({ source_version_id: i, state: empty() })); }, "legacy_versions"],
]) test(`import refuses ${name} without partial rows`, () => {
  const store = create(empty()), input = manifest(); mutate(input); importRejected(store, input, error);
});
test("initial import cannot replace a nonempty fixture", () => { const store = create(); importRejected(store, manifest(), "legacy_initial_only"); });
test("empty entity arrays do not authorize discarding budgets or other seed facts", () => {
  const data = empty(); data.links.budget_rows.push({ id: "existing-budget", amount_cents: 100 });
  const store = create(data); importRejected(store, manifest(), "legacy_initial_only");
});
test("import authorization denial precedes input inspection and writes", () => {
  const store = create(empty()), before = store.inspectFixture();
  assert.deepEqual(store.importFixtureHistory(null, { ...principal, authenticated: false }), { accepted: false, error: "denied" });
  const unbound = { ...principal }; delete unbound.source_device_id;
  assert.deepEqual(store.importFixtureHistory(null, unbound), { accepted: false, error: "denied" });
  assert.deepEqual(store.inspectFixture(), before);
});
test("competing SQLite connection cannot partially import a locked history", () => {
  const store = create(empty()), second = new SyntheticStore(store.directory); stores.add(second);
  const input = manifest(), before = store.inspectFixture();
  store.holdFixtureLock(() => assert.deepEqual(second.importFixtureHistory(input, principal), { accepted: false, error: "storage_busy" }));
  assert.deepEqual(store.inspectFixture(), before);
  assert.equal(second.importFixtureHistory(input, principal).accepted, true);
  assert.equal(store.importFixtureHistory(input, principal).replayed, true);
});
for (const phase of ["after_mapping", "before_commit"]) test(`import ${phase} failure leaves no partial mapping or history`, () => {
  const store = create(empty()), input = manifest(), before = store.inspectFixture();
  assert.throws(() => store.importFixtureHistory(input, principal, { fault: at => { if (at === phase) throw new Error("injected"); } }), /injected/);
  assert.deepEqual(store.inspectFixture(), before); assert.equal(store.importFixtureHistory(input, principal).accepted, true);
});
test("import lost response after commit recovers by identical manifest without reapplying", () => {
  let store = create(empty()); const input = manifest();
  assert.throws(() => store.importFixtureHistory(input, principal, { fault: at => { if (at === "after_commit") throw new Error("lost"); } }), CommitResultUnknown);
  store = reopen(store); const before = store.inspectFixture();
  assert.equal(store.importFixtureHistory(input, principal).replayed, true); assert.deepEqual(store.inspectFixture(), before);
});

try {
  for (const item of cases) { try { await item.work(); } catch (error) { throw new Error(item.name, { cause: error }); } }
  console.log(JSON.stringify({ history_cases: cases.length, node: process.version, sqlite: [...stores][0].sqliteVersion(),
    scope: "marked temporary fixture SQLite; explicit expense/adjustment restore; one bounded initial decoded history batch",
    real_legacy_file_adapter: false, migration_or_incremental_sync: false, inferred_legacy_deletions: false,
    real_authentication: false, android_native_executed: false, shared_contract_version: null }, null, 2));
} finally {
  for (const store of stores) store.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
}
