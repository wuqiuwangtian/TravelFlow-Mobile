// Cross-language byte vectors only; no auth, app database or Android execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CANONICAL_PROFILE, evaluate, fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";
import { controlIntent, queryIntent } from "../prototypes/p1-boundary/commands.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv.length <= 3, "Usage: node scripts/check-p1-canonical.mjs [candidate.json]");
const input = path.resolve(process.argv[2] ?? path.join(root, "docs/internal/fixtures/p1-canonical-cases.json"));
const corpus = JSON.parse(readFileSync(input, "utf8")), before = JSON.stringify(corpus);
assert.equal(corpus.fixture_format_version, 1); assert.equal(corpus.status, "host-canonical-candidate");
assert.equal(corpus.shared_contract_version, null); assert.equal(corpus.canonical_profile, CANONICAL_PROFILE.id);
assert.deepEqual(corpus.acceptance, { desktop_joint_review: "pending", android_native_execution: "not-implemented", storage_fingerprint_adoption: "not-implemented" });
assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
assert.ok(Array.isArray(corpus.relations) && corpus.relations.length > 0);
const results = {}, ids = new Set(), kinds = new Set();
let accepted = 0;
for (const entry of corpus.cases) {
  assert.match(entry.id, /^CN[0-9]{3}$/); assert.ok(!ids.has(entry.id), `Duplicate ID ${entry.id}`); ids.add(entry.id);
  assert.ok(["integer-json-fixture", "intent"].includes(entry.scope));
  assert.equal(Object.hasOwn(entry, "raw_json") + Object.hasOwn(entry, "raw_utf8_hex"), 1);
  let bytes;
  if (Object.hasOwn(entry, "raw_json")) {
    assert.equal(typeof entry.raw_json, "string"); bytes = Buffer.from(entry.raw_json, "utf8");
    assert.equal(bytes.toString("utf8"), entry.raw_json, "Use hex for invalid UTF-8/surrogates");
  } else {
    assert.equal(typeof entry.raw_utf8_hex, "string"); assert.match(entry.raw_utf8_hex, /^(?:[a-f0-9]{2})*$/);
    bytes = Buffer.from(entry.raw_utf8_hex, "hex");
  }
  if (entry.scope === "intent") {
    assert.ok(["control", "receipt-query"].includes(entry.channel));
    const validated = entry.channel === "control" ? controlIntent(bytes) : queryIntent(bytes);
    assert.deepEqual(validated, entry.validated_intent, `${entry.id}: explicit validated projection`);
    kinds.add(validated.kind);
  } else assert.equal(Object.hasOwn(entry, "validated_intent"), false);
  const bytesBefore = Buffer.from(bytes);
  const result = results[entry.id] = evaluate(entry);
  assert.deepEqual(result, entry.expected, `${entry.id}: frozen byte/digest expectation`);
  assert.deepEqual(bytes, bytesBefore);
  if (!result.accepted) continue;
  accepted++;
  const encoded = Buffer.from(result.canonical_json, "utf8");
  assert.equal(encoded.toString("hex"), result.canonical_utf8_hex, `${entry.id}: UTF-8 projection`);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash("sha256").update(encoded).digest("hex"), result.sha256);
  const document = JSON.parse(result.canonical_json);
  assert.equal(document.canonical_profile, CANONICAL_PROFILE.id);
  assert.equal(document.channel, result.channel);
  assert.ok(!encoded.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.ok(!result.canonical_json.endsWith("\n"));
}
for (const relation of corpus.relations) {
  assert.ok(["same", "different"].includes(relation.relation));
  assert.ok(relation.ids.length >= 2 && new Set(relation.ids).size === relation.ids.length);
  const values = relation.ids.map(id => { assert.ok(ids.has(id) && results[id].accepted, id); return results[id]; });
  const size = relation.relation === "same" ? 1 : values.length;
  assert.equal(new Set(values.map(value => value.canonical_utf8_hex)).size, size, relation.description);
  assert.equal(new Set(values.map(value => value.sha256)).size, size, relation.description);
}
assert.deepEqual([...kinds].sort(), ["expense.create", "expense.patch", "expense.delete", "expense.restore", "adjustment.create", "adjustment.patch", "adjustment.delete", "adjustment.restore",
  "booking.set", "booking.clear", "booking.notes.patch", "booking.legacy.patch", "progress.set", "receipt.lookup"].sort());
assert.equal(JSON.stringify(corpus), before, "Vector input mutated");

const interpreter = process.env.P1_REVIEW_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const reference = spawnSync(interpreter, [path.join(root, "scripts/check-p1-canonical.py"), input], {
  cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
});
assert.ifError(reference.error);
assert.equal(reference.status, 0, `Python3.9+ required; no skip: ${reference.stderr}`);
const python = JSON.parse(reference.stdout);
assert.equal(python.stdlib_only, true); assert.equal(python.full_command_validation_reimplemented, false);
assert.deepEqual(python.results, results, "Independent canonical encoders disagree");

// Format failures must not become normalizable intents. These checks are Node
// integration evidence, not a claim that Python reimplements command validation.
const base = corpus.cases.find(entry => entry.scope === "intent" && entry.validated_intent.kind === "expense.patch").validated_intent;
let integration = 0;
for (const [name, mutate, expected] of [
  ["near-integer is not rounded", text => text.replace('"amount_cents":100', '"amount_cents":100.00000000000000001'), "integer_range"],
  ["amount type is retained", text => text.replace('"amount_cents":100', '"amount_cents":true'), "type"],
  ["unknown observed head is not silently stripped", text => text.replace('{', '{"observed_head":"later",'), "shape"],
  ["decoded duplicate is rejected before encoding", text => text.replace('"amount_cents":100', '"amount_cents":100,"amount_cents":100'), "duplicate_key"],
  ["money numeric budget stays in force", text => text.replace('"amount_cents":100', '"amount_cents":' + "1".repeat(65)), "resource_number"],
]) {
  assert.throws(() => fingerprintIntent(Buffer.from(mutate(JSON.stringify(base)))), error => error.code === expected, name); integration++;
}
assert.throws(() => fingerprintIntent(Buffer.from(JSON.stringify(base)), "history"), error => error.code === "canonical_channel"); integration++;
// Independently transcribed anchors prevent a regenerated corpus from hiding
// numeric-property reordering, Python scalar sorting or zero-spelling mistakes.
for (const [description, literal] of [
  ["numeric property keys sort lexically", '{"1":1,"10":10,"2":2}'],
  ["UTF16 ordering differs from scalar order", '{"\\r":4,"1":3,"€":5,"😀":2,"\ue000":1}'],
  ["negative zero", "0"],
]) {
  const entry = corpus.cases.find(item => item.description === description); assert.ok(entry, description);
  assert.equal(results[entry.id].canonical_json, `{"canonical_profile":"p1-host-intent-c14n-1","channel":"integer-json-fixture","value":${literal}}`, description);
}
console.log(JSON.stringify({ canonical_cases: ids.size, accepted, rejected: ids.size - accepted, semantic_relations: corpus.relations.length,
  node_integration_cases: integration, control_command_kinds: kinds.size - 1, node: process.version, python: python.python,
  scope: "host byte/digest candidate; Python independently encodes explicit validated projections and primitive raw vectors",
  canonical_profile: CANONICAL_PROFILE.id, shared_contract_version: null, full_jcs_or_ijson: false,
  python_full_command_validation: false, storage_fingerprint_adopted: false, real_authentication: false,
  android_native_executed: false, synchronization_executed: false }, null, 2));
