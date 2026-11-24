// 宿主侧跨端边界对照检查：核对 1999→2000 上限与满额重放、调用身份、目标作用域与忙锁查询语义。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { emptyFixtureState } from "../prototypes/p1-store/legacy.mjs";
import { SyntheticStore } from "../prototypes/p1-store/sqlite.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../docs/internal/fixtures/p1-desktop-expense-create.json", import.meta.url), "utf8"),
);
const { command, receipt_query: query } = fixture;
const principal = {
  authenticated: true,
  can_query: true,
  can_write: true,
  dataset_id: "fixture-dataset",
  source_device_id: "fixture-device",
};
const encode = (value) => Buffer.from(JSON.stringify(value));

function seedExpenses(count) {
  const base = emptyFixtureState();
  base.expenses = Array.from({ length: count }, (_, idx) => ({
    id: `fixture-seed-${String(idx + 1).padStart(4, "0")}`,
    title: "seed",
    amount_cents: 100,
    currency: "CNY",
    paid_on: null,
    category: "other",
    day: null,
    activity_id: null,
    notes: "",
    receipt_ids: [],
    budget_item_id: null,
    settles_budget: false,
  }));
  return base;
}

// 1. 1999 -> 2000, 2001st rejected with expense_count, replay of 2000th succeeds at full cap.
{
  const store = SyntheticStore.create({
    dataset_id: "fixture-dataset",
    travel_id: "fixture-travel",
    branch_id: "fixture-branch",
    revision_id: "fixture-r1999",
    state: seedExpenses(1999),
  });
  const dir = store.directory;
  try {
    const cmd2000 = { ...command, expected_revision_id: "fixture-r1999" };
    const created = store.execute(encode(cmd2000), principal);
    assert.equal(created.accepted, true);
    assert.equal(created.replayed, false);
    const rev2000 = created.result_revision_id;
    const at2000 = store.inspectFixture();
    assert.equal(at2000.state.expenses.length, 2000);
    assert.equal(at2000.tables.fixture_receipts.length, 1);
    assert.equal(at2000.tables.fixture_outbox.length, 1);

    const changesAt2000 = store.totalChanges();
    const cmd2001 = {
      ...command,
      operation: { ...command.operation, operation_id: "fixture-op-2001" },
      target: { ...command.target, entity_id: "fixture-expense-2001" },
      expected_revision_id: rev2000,
    };
    assert.deepEqual(store.execute(encode(cmd2001), principal), { accepted: false, error: "expense_count" });
    assert.equal(store.totalChanges(), changesAt2000);
    assert.deepEqual(store.inspectFixture(), at2000);

    // Replay at full 2000 cap must still return original revision.
    assert.deepEqual(store.execute(encode(cmd2000), principal), {
      accepted: true,
      kind: "committed",
      replayed: true,
      effect: "changed",
      result_revision_id: rev2000,
    });
    assert.deepEqual(
      store.execute(encode({ ...cmd2000, payload: { ...cmd2000.payload, amount_cents: 8636 } }), principal),
      { accepted: false, error: "intent_conflict" },
    );
    assert.equal(store.totalChanges(), changesAt2000);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Pre-write caller identity, target travel/branch scope, and busy-lock vs settled-read query.
{
  const store = SyntheticStore.create({
    dataset_id: "fixture-dataset",
    travel_id: "fixture-travel",
    branch_id: "fixture-branch",
    revision_id: "fixture-r0",
    state: emptyFixtureState(),
  });
  const dir = store.directory;
  let contender;
  try {
    const baseline = store.inspectFixture();
    const beginsBefore = store.stats.begins;
    const changesBefore = store.totalChanges();

    for (const override of [
      { authenticated: false },
      { can_write: false },
      { dataset_id: "fixture-other-dataset" },
      { source_device_id: "fixture-other-device" },
    ]) {
      assert.deepEqual(store.execute(encode(command), { ...principal, ...override }), { accepted: false, error: "denied" });
    }
    for (const targetOverride of [{ travel_id: "fixture-other-travel" }, { branch_id: "fixture-other-branch" }]) {
      assert.deepEqual(
        store.execute(encode({ ...command, target: { ...command.target, ...targetOverride } }), principal),
        { accepted: false, error: "denied" },
      );
    }
    assert.equal(store.stats.begins, beginsBefore, "Unauthorized or out-of-scope writes must reject before BEGIN");
    assert.equal(store.totalChanges(), changesBefore);
    assert.deepEqual(store.inspectFixture(), baseline);

    // Settled read when absent.
    assert.deepEqual(store.query(encode(query), principal), {
      accepted: true,
      state: "not_found_at_settled_read",
    });

    // Write-lock busy during query must return unknown/storage_busy rather than not_found.
    contender = new DatabaseSync(path.join(dir, "synthetic.sqlite"));
    contender.exec("BEGIN IMMEDIATE");
    assert.deepEqual(store.query(encode(query), principal), {
      accepted: true,
      state: "unknown",
      reason: "storage_busy",
    });
    contender.exec("ROLLBACK");
    contender.close();
    contender = null;

    // Commit create + notes patch, then verify already-used keys targeting wrong travel/branch reject BEFORE receipt lookup.
    const created = store.execute(encode(command), principal);
    assert.equal(created.accepted, true);
    const notesPatch = {
      ...command,
      kind: "expense.patch",
      operation: { ...command.operation, operation_id: "fixture-op-notes" },
      expected_revision_id: created.result_revision_id,
      payload: { notes: "虚构更正" },
    };
    const patched = store.execute(encode(notesPatch), principal);
    assert.equal(patched.accepted, true);
    const beginsAfterCommit = store.stats.begins;
    const changesAfterCommit = store.totalChanges();
    for (const baseCmd of [command, notesPatch]) {
      for (const targetOverride of [{ travel_id: "fixture-other-travel" }, { branch_id: "fixture-other-branch" }]) {
        assert.deepEqual(
          store.execute(encode({ ...baseCmd, target: { ...baseCmd.target, ...targetOverride } }), principal),
          { accepted: false, error: "denied" },
        );
      }
    }
    assert.equal(store.stats.begins, beginsAfterCommit, "Reused keys with wrong target must reject before BEGIN");
    assert.equal(store.totalChanges(), changesAfterCommit);
  } finally {
    contender?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  passed: true,
  desktop_reference_commit: "73bb8f4",
  cross_end_differences: {
    unsupported_create_fields: {
      desktop_73bb8f4: "unsupported_capability (paid_on/day/activity_id/receipt_ids/budget_item_id/non-CNY), invalid_field (settles_budget=true/unknown category)",
      mobile_host: "accepts paid_on/day/activity_id/receipt_ids/budget_item_id when context links exist; rejects non-CNY with currency",
      android_candidate: "aligned with desktop_73bb8f4 exchangeable subset: unsupported_capability + invalid_field",
    },
    expense_cap_2000: {
      desktop_73bb8f4: "expense_limit_exceeded (replay at 2000 succeeds)",
      mobile_host: "expense_count (replay at 2000 succeeds)",
      android_candidate: "expense_count (replay at 2000 succeeds)",
    },
    caller_identity_rejection: {
      desktop_73bb8f4: "unauthorized (checked before SQLite open)",
      mobile_host: "denied (checked before BEGIN IMMEDIATE)",
      android_candidate: "denied (checked before SQLite open)",
    },
    target_travel_or_branch_mismatch: {
      desktop_73bb8f4: "unauthorized (checked against branches BEFORE receipt lookup for new and reused keys)",
      mobile_host: "denied (checked in #authorize BEFORE BEGIN IMMEDIATE and receipt lookup for new and reused keys)",
      android_candidate: "scope_mismatch (checked against branch_head BEFORE receipt lookup for new and reused create/patch keys)",
    },
    receipt_lookup_absent_and_busy: {
      desktop_73bb8f4: "BEGIN IMMEDIATE (timeout=0.0): state=not_found_at_settled_read / state=unknown + reason=storage_busy",
      mobile_host: "BEGIN IMMEDIATE (busy_timeout=0): state=not_found_at_settled_read / state=unknown + reason=storage_busy",
      android_candidate: "beginTransactionNonExclusive: state=not_found_at_settled_read / state=pending_busy + full intent_conflict check on recovery",
    },
  },
  shared_contract_version: null,
}, null, 2));
