import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CandidateBoundary, capabilities, controlIntent } from "../prototypes/p1-boundary/commands.mjs";
import { HOST_RESOLUTION } from "../prototypes/p1-boundary/families.mjs";

const fixture = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-family-cases.json", import.meta.url)));
const expenseBaseline = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-patch-cases.json", import.meta.url))).baseline;
assert.equal(fixture.status, "host-family-candidate"); assert.equal(fixture.shared_contract_version, null);
const before = JSON.stringify(fixture), ids = new Set(); let accepted = 0;
const encode = value => new TextEncoder().encode(JSON.stringify(value));
for (const entry of fixture.cases) {
  assert.match(entry.id, /^FC[0-9]{2}$/); assert.ok(!ids.has(entry.id)); ids.add(entry.id);
  const snapshot = { revision_id: "revision-1", expense_count: 1, adjustment_count: 1,
    expense: structuredClone(expenseBaseline.base), adjustment: structuredClone(fixture.adjustment), activity: structuredClone(fixture.activity),
    calendar: { revision_id: "calendar-1", day_date: "2026-11-01" },
    links: { ...structuredClone(expenseBaseline.context), expenses: [structuredClone(expenseBaseline.base)], adjustments: [structuredClone(fixture.adjustment)] },
    ...structuredClone(entry.snapshot ?? {}) };
  if (entry.links) Object.assign(snapshot.links, structuredClone(entry.links));
  const kind = entry.kind;
  const type = kind.startsWith("expense.") ? "expense" : kind.startsWith("adjustment.") ? "adjustment" : "activity";
  const payload = structuredClone(entry.payload);
  if (payload.resolution_basis?.tzdata_version === "$HOST_TZ") payload.resolution_basis.tzdata_version = HOST_RESOLUTION.tzdata_version;
  const targetId = entry.entity_id ?? (type === "expense" ? expenseBaseline.base.id : fixture[type].id);
  const request = { profile: "p1-host-control-1", kind, operation: { dataset_id: "dataset-1", source_device_id: "device-1", operation_id: entry.id },
    target: { travel_id: "travel-1", branch_id: "branch-1", entity_id: targetId }, expected_revision_id: "revision-1", payload };
  let reads = 0, inspections = 0;
  const ctx = { principal: { authenticated: true, source_device_id: "device-1" }, authorize: async () => true,
    lookupReceipt: async () => { reads++; return { state: "missing", settled: true }; }, inspect: async () => { inspections++; return snapshot; } };
  const inputBefore = JSON.stringify(snapshot);
  const result = await new CandidateBoundary().control(encode(request), ctx);
  assert.equal(JSON.stringify(snapshot), inputBefore, `${entry.id}: mutated snapshot`);
  assert.equal(result.accepted, entry.expected.accepted, entry.id);
  if (!result.accepted) { assert.equal(result.error, entry.expected.error, entry.id); continue; }
  accepted++;
  assert.equal(result.kind, "uncommitted-plan"); assert.equal(reads, 1); assert.equal(inspections, 1);
  assert.equal(result.value.planned_business_revision, entry.expected.revision ?? "new");
  assert.equal(result.value.planned_operation_receipt, "required-not-persisted");
  for (const [path, value] of Object.entries(entry.expected.values ?? {})) {
    const actual = path.split(".").reduce((object, key) => object?.[key], result.value);
    assert.deepEqual(actual, value, `${entry.id}: ${path}`);
  }
  if (entry.expected.unchanged) assert.deepEqual(result.value.candidate, snapshot[type], `${entry.id}: no-change identity`);
  // Every valid command family must also replay an already committed result
  // before touching a later/deleted entity, calendar or resolution provider.
  const effect = result.value.planned_business_revision === "unchanged" ? "no_change" : "changed";
  ctx.lookupReceipt = async () => ({ state: "committed", intent: controlIntent(encode(request)), effect, result_revision_id: "original" });
  ctx.inspect = async () => { throw new Error("Replay inspected current state"); };
  const replay = await new CandidateBoundary().control(encode(request), ctx);
  assert.equal(replay.kind, "replay-view", `${entry.id}: replay`);
  assert.deepEqual(replay.receipt, { effect, result_revision_id: "original" });
}
assert.equal(JSON.stringify(fixture), before);
const caps = capabilities(encode({ profile: "p1-host-query-1", kind: "capabilities.query" }));
for (const kind of new Set(fixture.cases.map(entry => entry.kind))) assert.ok(caps.control_commands.includes(kind));
console.log(JSON.stringify({ family_cases: ids.size, accepted, rejected: ids.size - accepted,
  committed_view_replay_models: accepted, node: process.version, host_tz: HOST_RESOLUTION.tzdata_version,
  shared_contract_version: null, durable_storage: false, real_authentication: false, android_native_executed: false }, null, 2));
