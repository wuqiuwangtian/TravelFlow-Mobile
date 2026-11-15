// 仅运行值片段候选双语言对照；不是正式写入／同步契约验收。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../prototypes/p1-values/values.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv.length <= 3, "Usage: node scripts/check-p1-values.mjs [candidate.json]");
const inputPaths = process.argv[2] ? [path.resolve(process.argv[2])] : [
  path.join(root, "docs/internal/fixtures/p1-value-cases.json"),
  path.join(root, "docs/internal/fixtures/p1-value-boundaries.json"),
];
const corpora = inputPaths.map(inputPath => JSON.parse(readFileSync(inputPath, "utf8")));
for (const corpus of corpora) {
  assert.equal(corpus.fixture_format_version, 1);
  assert.equal(corpus.status, "candidate-values");
  assert.equal(corpus.shared_contract_version, null, "No shared write-contract version is assigned");
  assert.deepEqual(corpus.acceptance, {
    desktop_candidate_execution: "pending", android_native_execution: "not-implemented", storage_execution: "not-implemented",
  });
  for (const key of ["mobile_design_commit", "desktop_review_commit"]) assert.match(corpus[key], /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
}
const registryPath = path.join(root, "prototypes/p1-values/time-zone-ids.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
assert.equal(registry.registry_format_version, 1);
assert.equal(registry.status, "candidate-name-registry");
assert.ok(Array.isArray(registry.time_zone_ids) && registry.time_zone_ids.length > 0);
assert.ok(registry.time_zone_ids.every(id => typeof id === "string" && id.length > 0));
assert.equal(new Set(registry.time_zone_ids).size, registry.time_zone_ids.length);
const before = JSON.stringify(corpora);
const ids = new Set();
const counts = {};
const results = {};
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
for (const entry of corpora.flatMap(corpus => corpus.cases)) {
  assert.match(entry.id, /^(MT|MV|PD|BK|RV|E)[0-9]{2}$/);
  assert.ok(!ids.has(entry.id), `Duplicate candidate ID: ${entry.id}`);
  ids.add(entry.id);
  freeze(entry.input);
  results[entry.id] = evaluate(entry);
  assert.deepEqual(results[entry.id], entry.expected, `${entry.id}: candidate expectation`);
  counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
}
assert.equal(JSON.stringify(corpora), before, "Candidate evaluation mutated input");

const interpreter = process.env.P1_REVIEW_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
let python;
for (const [index, inputPath] of inputPaths.entries()) {
  const reference = spawnSync(interpreter, [path.join(root, "scripts/check-p1-values.py"), inputPath, registryPath], {
    cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(reference.error);
  assert.equal(reference.status, 0, `Python3.9+ and IANA zone data required; no skip: ${reference.stderr}`);
  python = JSON.parse(reference.stdout);
  assert.equal(python.stdlib_only, true);
  assert.deepEqual(python.booking_zone_ids, [...registry.time_zone_ids].sort(), "Both adapters must use the same exact registry");
  const fileIds = corpora[index].cases.map(entry => entry.id);
  assert.deepEqual(Object.keys(python.results).sort(), fileIds.sort());
  for (const id of fileIds) assert.deepEqual(python.results[id], results[id], `${id}: Node/Python disagree`);
}

console.log(JSON.stringify({
  candidate_value_cases: ids.size, by_kind: counts,
  source_corpora: inputPaths.map((inputPath, index) => ({ file: path.basename(inputPath), cases: corpora[index].cases.length })),
  booking_zone_name_policy: "exact-registered-spelling", candidate_registered_zone_ids: registry.time_zone_ids.length,
  accepted_values: Object.values(results).filter(result => result.accepted).length,
  rejected_values: Object.values(results).filter(result => !result.accepted).length,
  node: process.version, icu: process.versions.icu, node_tz: process.versions.tz,
  python: python.python, python_system_tz: python.system_tz_version,
  python_scope: "independent standard-library value adapter, not the desktop backend",
  desktop_joint_contract: "pending", android_native_executed: false, storage_executed: false,
  raw_json_decoder_verified: false, note: "Parsed value fragments only; no command execution, durable receipt, migration or canonical byte encoding.",
}, null, 2));
