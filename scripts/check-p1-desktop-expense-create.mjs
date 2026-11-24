// Desktop 5c457e6 fixture, evaluated by the mobile host implementation on disposable SQLite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";
import { emptyFixtureState } from "../prototypes/p1-store/legacy.mjs";
import { SyntheticStore } from "../prototypes/p1-store/sqlite.mjs";

const fixture = readFileSync(new URL("../docs/internal/fixtures/p1-desktop-expense-create.json", import.meta.url));
assert.equal(createHash("sha256").update(fixture).digest("hex"), "da9a97398ebb1e0e3b8e0e17097a8f8bc79da25602f6e7a119800572341a7b3f");
const { command, receipt_query: query } = JSON.parse(fixture);
const principal = { authenticated: true, can_query: true, can_write: true,
  dataset_id: "fixture-dataset", source_device_id: "fixture-device" };
const encode = value => Buffer.from(JSON.stringify(value));
const original = encode(command);
const queryBytes = encode(query);
const phases = ["before_commit", "after_commit"];

if (process.argv[2] === "--worker") {
  const [, , , dir, phase] = process.argv;
  assert.ok(phases.includes(phase));
  const store = new SyntheticStore(dir);
  store.execute(original, principal, { fault(at) {
    if (at === phase) process.kill(process.pid, "SIGKILL");
  } });
  throw new Error("Expected commit hook to terminate this worker");
}

function exercise(phase) {
  let store = SyntheticStore.create({ dataset_id: "fixture-dataset", travel_id: "fixture-travel",
    branch_id: "fixture-branch", revision_id: "fixture-r0", state: emptyFixtureState() });
  const dir = store.directory;
  try {
    const baseline = store.inspectFixture();
    store.close();
    store = null;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", dir, phase],
      { encoding: "utf8", timeout: 15000 });
    assert.ifError(child.error);
    assert.equal(child.signal, "SIGKILL", child.stderr);
    store = new SyntheticStore(dir);
    if (phase === "before_commit") {
      assert.deepEqual(store.inspectFixture(), baseline);
      assert.equal(store.query(queryBytes, principal).state, "not_found_at_settled_read");
      assert.equal(store.execute(original, principal).replayed, false);
    }
    const snapshot = store.inspectFixture();
    const revision = snapshot.head;
    assert.notEqual(revision, command.expected_revision_id);
    const receipt = store.query(queryBytes, principal);
    assert.deepEqual(receipt, { accepted: true, state: "committed",
      receipt: { effect: "changed", result_revision_id: revision } });
    assert.equal(snapshot.state.expenses.length, 1);
    const [lunch] = snapshot.state.expenses;
    assert.deepEqual([lunch.id, lunch.title, lunch.amount_cents, lunch.currency, lunch.paid_on, lunch.receipt_ids],
      ["fixture-lunch", "午餐", 8635, "CNY", null, []]);
    const { fixture_revisions: history, fixture_receipts: receipts, fixture_outbox: outbox } = snapshot.tables;
    assert.equal(history.length, 2);
    assert.equal(receipts.length, 1);
    assert.equal(outbox.length, 1);
    assert.deepEqual(JSON.parse(receipts[0].intent), command);
    for (const row of [receipts[0], outbox[0]]) {
      assert.deepEqual([row.dataset, row.source, row.operation, row.result_revision],
        ["fixture-dataset", "fixture-device", "fixture-op-lunch", revision]);
    }

    // Advance the head with a separate edit. Replaying the create must still return the older revision.
    const edit = { ...command, kind: "expense.patch", expected_revision_id: revision,
      operation: { ...command.operation, operation_id: "fixture-op-notes" }, payload: { notes: "虚构更正" } };
    assert.equal(store.execute(encode(edit), principal).effect, "changed");
    const advanced = store.inspectFixture();
    assert.notEqual(advanced.head, revision);
    const changes = store.totalChanges();
    const reordered = { ...Object.fromEntries(Object.entries(command).reverse()),
      payload: Object.fromEntries(Object.entries(command.payload).reverse()) };
    assert.deepEqual(fingerprintIntent(encode(reordered)), fingerprintIntent(original));
    for (const body of [command, reordered]) {
      assert.deepEqual(store.execute(encode(body), principal), { accepted: true, kind: "committed",
        replayed: true, effect: "changed", result_revision_id: revision });
    }
    function expectError(body, error) {
      assert.deepEqual(store.execute(encode(body), principal), { accepted: false, error });
    }
    for (const diff of [{ amount_cents: 8636 }, { allow_shared_receipts: true }]) {
      expectError({ ...command, payload: { ...command.payload, ...diff } }, "intent_conflict");
    }
    const fresh = { ...command, operation: { ...command.operation, operation_id: "fixture-op-second" } };
    expectError({ ...fresh, target: { ...command.target, entity_id: "fixture-second" } }, "baseline_conflict");
    expectError({ ...fresh, expected_revision_id: advanced.head }, "entity_exists");
    const invalid = [];
    for (const [amount, error] of [[0, "integer_range"], [true, "type"], [1.25, "integer_range"], [10000000000, "integer_range"]]) {
      const result = store.execute(encode({ ...fresh, expected_revision_id: advanced.head,
        target: { ...fresh.target, entity_id: "fixture-second" },
        payload: { ...fresh.payload, amount_cents: amount } }), principal);
      assert.deepEqual(result, { accepted: false, error });
      invalid.push([amount, result.error]);
    }
    for (const mismatch of [{ can_query: false }, { source_device_id: "fixture-other" }, { authenticated: false }]) {
      const reads = store.stats.receipt_reads;
      const denied = store.query(queryBytes, { ...principal, ...mismatch });
      assert.equal(denied.accepted, false);
      assert.equal(Object.hasOwn(denied, "receipt"), false);
      assert.equal(store.stats.receipt_reads, reads);
    }
    assert.equal(store.totalChanges(), changes);
    assert.deepEqual(store.inspectFixture(), advanced);
    return { phase, result_revision_id: revision, replay_after_head_advance: true, invalid };
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

assert.equal(process.argv.length, 2);
const commandDigest = fingerprintIntent(original).sha256;
const queryDigest = fingerprintIntent(queryBytes, "receipt-query").sha256;
// Independently produced by desktop p1_canonical_review.artifact at the pinned commit.
assert.equal(commandDigest, "e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd");
assert.equal(queryDigest, "6eae8c5e2bbda98cd3e7dab4858f6d573f8593698ce3c9ce97ffee3f45ea8315");
console.log(JSON.stringify({ command_sha256: commandDigest, query_sha256: queryDigest,
  scenarios: phases.map(exercise), scope: "mobile host SQLite; synthetic identity" }, null, 2));
