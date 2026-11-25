// Single-branch, single-writer host review fixture. No app or desktop imports.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fingerprintPatchCandidate } from "../prototypes/p1-canonical/intent.mjs";
import { BoundaryError } from "../prototypes/p1-boundary/input.mjs";
import "./check-contracts.mjs";

const bundle = new URL("../vendor/contracts/expense-patch-candidate.2/", import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, bundle)));
const { cases } = json("canonical-digests.json");
assert.equal(cases.length, 4);
for (const sample of cases) {
  const actual = fingerprintPatchCandidate(Buffer.from(sample.raw_json), sample.channel);
  for (const field of ["canonical_json", "canonical_utf8_hex", "sha256"]) {
    assert.equal(actual[field], sample[field], sample.id + "/" + field);
  }
  console.log(sample.id, actual.sha256);
}

const { defaults, scenarios } = json("normative-vectors.json");
const mapping = json("result-mapping.json").outcomes;
const dir = mkdtempSync(path.join(tmpdir(), "mobile-patch-review-"));
const stateFile = path.join(dir, "branch.json");
const load = () => JSON.parse(readFileSync(stateFile));
function save(state) {
  writeFileSync(stateFile + ".new", JSON.stringify(state));
  renameSync(stateFile + ".new", stateFile);
}

const outOfSlice = new Set(["title", "notes", "currency", "paid_on", "category", "day", "activity_id",
  "receipt_ids", "allow_shared_receipts", "budget_item_id", "settles_budget"]);
const reject = (error, details = {}) => ({ ok: false, error, ...details });
function receive(raw, channel, permissions) {
  const querying = channel === "receipt-query";
  if (permissions[querying ? "can_lookup_receipt" : "can_write"] === false) return reject("unauthorized");
  let proof;
  try {
    proof = fingerprintPatchCandidate(raw, channel);
  } catch (error) {
    if (error instanceof BoundaryError) return reject(error.code);
    throw error;
  }
  const { intent } = JSON.parse(proof.canonical_json);
  const { operation, target } = intent;
  if (operation.dataset_id !== defaults.dataset_id || operation.source_device_id !== defaults.desktop_device_id) {
    return reject("unauthorized");
  }
  const inScope = t => t.travel_id === defaults.travel_id && t.branch_id === defaults.branch_id;
  if (!querying && !inScope(target)) return reject("unauthorized");
  const state = load();
  const saved = state.receipts.find(row => Object.keys(operation).every(k => row.receipt.operation[k] === operation[k]));
  if (querying) {
    if (!saved) return { ok: true, state: "not_found_at_settled_read", receipt: null };
    if (!inScope(saved.receipt)) return reject("unauthorized");
    return { ok: true, state: "committed", receipt: saved.receipt };
  }
  if (saved) {
    if (saved.canonical !== proof.canonical_json || saved.receipt.intent_sha256 !== proof.sha256) return reject("intent_conflict");
    return { ok: true, state: "committed", replayed: true, receipt: saved.receipt };
  }
  for (const field of Object.keys(intent.patch)) {
    if (outOfSlice.has(field)) return reject("unsupported_capability");
    if (field !== "amount_cents") return reject("invalid_field");
  }
  const amount = intent.patch.amount_cents;
  if (amount !== undefined) {
    if (typeof amount !== "number") return reject("type");
    if (amount < 1 || amount > 9999999999) return reject("integer_range");
  }
  const blocking = state.pending.find(row => row.delivery_state !== "confirmed");
  if (blocking) return reject("local_pending_conflict", { pending_operation_id: blocking.operation_id });
  if (state.desktop !== intent.expected_revision_id) return reject("baseline_conflict", { current_synced_revision_id: state.desktop });
  if (target.entity_id !== state.expense.id) return reject("entity_not_found");
  if (state.expense.currency !== "CNY") return reject("unsupported_capability");
  const changed = amount !== undefined && amount !== state.expense.amount_cents;
  if (changed !== (intent.source_revision_id !== intent.expected_revision_id)) return reject("revision_mismatch");
  if (changed) {
    state.expense.amount_cents = amount;
    state.expense.updated_at = new Date().toISOString();
    state.local = randomUUID();
    state.desktop = intent.source_revision_id;
  }
  const receipt = { operation, ...target, kind: intent.kind, canonical_profile: proof.canonical_profile,
    intent_sha256: proof.sha256, effect: changed ? "changed" : "no_change", origin_direction: "received",
    result_revision_id: state.local, synced_desktop_revision_id: state.desktop };
  state.receipts.push({ canonical: proof.canonical_json, receipt });
  save(state);
  return { ok: true, state: "committed", replayed: false, receipt };
}

let count = 0;
try {
  for (const scenario of scenarios) {
    save({ expense: { ...defaults.initial_expense, ...scenario.initial_expense_override },
      local: defaults.initial_local_revision_id, desktop: defaults.initial_synced_desktop_revision_id,
      pending: scenario.initial_pending, receipts: [] });
    const bindings = new Map();
    for (const step of scenario.steps) {
      const { business_outcome: outcome, response, ...expected } = step.expected;
      const before = load();
      const diskBefore = readFileSync(stateFile);
      const query = step.action === "lookup";
      const raw = Buffer.from(JSON.stringify(query ? step.query : step.command));
      const channel = query ? "receipt-query" : "control";
      const result = receive(raw, channel, step.scope_override ?? {});
      const after = load();
      const spec = mapping[outcome].desktop_reference;
      if (response !== undefined) assert.deepEqual(result, response, step.name + "/response");
      assert.equal(result.ok, spec.ok, step.name);
      for (const key of ["error", "state", "replayed", "receipt"]) {
        if (Object.hasOwn(spec, key)) assert.deepEqual(result[key], spec[key], step.name);
      }
      if (spec.errors) assert.ok(spec.errors.includes(result.error), step.name);
      if (spec.effect) assert.equal(result.receipt.effect, spec.effect);
      if (step.bind_local_revision) bindings.set(step.bind_local_revision, result.receipt.result_revision_id);
      const snapshot = { amount_cents: after.expense.amount_cents, updated_at: after.expense.updated_at,
        synced_desktop_revision_id: after.desktop, local_revision_id: after.local,
        receipt_count: after.receipts.length, pending_count: after.pending.length, preserved_pending: after.pending };
      for (const [key, value] of Object.entries(expected)) {
        if (key === "preserved_fields") {
          for (const [field, expectedValue] of Object.entries(value)) assert.deepEqual(after.expense[field], expectedValue);
        } else if (key === "result_revision_var") {
          assert.ok(bindings.has(value));
          assert.equal(result.receipt.result_revision_id, bindings.get(value));
        } else assert.deepEqual(snapshot[key], value, step.name + "/" + key);
      }
      assert.deepEqual(after.pending, before.pending);
      if (query || !result.ok || result.replayed) assert.deepEqual(readFileSync(stateFile), diskBefore);
      if (result.error === "local_pending_conflict") assert.equal(result.pending_operation_id, before.pending[0].operation_id);
      if (result.error === "baseline_conflict") assert.equal(result.current_synced_revision_id, before.desktop);
      if (result.receipt) {
        const receipt = result.receipt;
        assert.deepEqual(receipt.operation, (step.command ?? step.query).operation);
        if (query || result.replayed) {
          const original = before.receipts.find(row => row.receipt.operation.operation_id === receipt.operation.operation_id);
          assert.deepEqual(receipt, original.receipt);
        } else {
          assert.equal(receipt.origin_direction, "received");
          assert.equal(receipt.intent_sha256, fingerprintPatchCandidate(raw, channel).sha256);
          assert.equal(receipt.result_revision_id, after.local);
          assert.equal(receipt.synced_desktop_revision_id, after.desktop);
          assert.equal(after.local !== before.local, spec.advances_local_revision);
          assert.equal(after.desktop !== before.desktop, spec.advances_synced_desktop_revision);
          assert.deepEqual(after.expense, spec.effect === "changed"
            ? { ...before.expense, amount_cents: step.command.patch.amount_cents, updated_at: after.expense.updated_at }
            : before.expense);
          assert.equal(after.receipts.length, before.receipts.length + 1);
        }
      }
      console.log(scenario.id.slice(0, 4), step.name, result.error ?? outcome);
      count++;
    }
  }
  assert.equal(scenarios.length, 10);
  assert.equal(count, 21);

  // Repeat the first delivery after a later desktop update and a new local edit.
  const first = scenarios[0].steps[0].command;
  save({ expense: defaults.initial_expense, local: defaults.initial_local_revision_id,
    desktop: defaults.initial_synced_desktop_revision_id, pending: [], receipts: [] });
  const submit = cmd => receive(Buffer.from(JSON.stringify(cmd)), "control", {});
  const original = submit(first);
  assert.equal(original.receipt.effect, "changed");
  const later = structuredClone(first);
  later.operation.operation_id += "-later";
  later.expected_revision_id = first.source_revision_id;
  later.source_revision_id += "-later";
  later.patch.amount_cents++;
  assert.equal(submit(later).receipt.effect, "changed");
  const edited = load();
  edited.pending = scenarios.find(s => s.id.startsWith("EP04")).initial_pending;
  edited.local = randomUUID();
  edited.expense.amount_cents = 1999;
  save(edited);
  const savedBytes = readFileSync(stateFile);
  assert.deepEqual(submit(first), { ...original, replayed: true });
  assert.deepEqual(readFileSync(stateFile), savedBytes);
  console.log("10 groups / 21 steps passed; later revision + pending replay passed (host).");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
