// Candidate raw-byte comparison only; no write-contract version or application IO.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../prototypes/p1-json/decode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv.length <= 3, "Usage: node scripts/check-p1-json.mjs [candidate.json]");
const inputPath = path.resolve(process.argv[2] ?? path.join(root, "docs/internal/fixtures/p1-json-cases.json"));
const corpus = JSON.parse(readFileSync(inputPath, "utf8"));
assert.equal(corpus.fixture_format_version, 1);
assert.equal(corpus.status, "candidate-raw-json");
assert.equal(corpus.shared_contract_version, null);
assert.deepEqual(corpus.acceptance, {
  desktop_joint_review: "pending", android_native_execution: "not-implemented",
  storage_execution: "not-implemented", canonical_bytes: "not-implemented",
});
assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
const before = JSON.stringify(corpus);
const ids = new Set();
const results = {};
for (const entry of corpus.cases) {
  assert.match(entry.id, /^RJ[0-9]{2}$/);
  assert.ok(!ids.has(entry.id), `Duplicate candidate ID: ${entry.id}`);
  ids.add(entry.id);
  assert.ok(["json", "cny-amount"].includes(entry.profile));
  assert.equal(Object.hasOwn(entry, "raw_json") + Object.hasOwn(entry, "raw_utf8_hex"), 1);
  if (Object.hasOwn(entry, "raw_json")) {
    assert.equal(typeof entry.raw_json, "string");
    // Raw invalid UTF-8 belongs in hex, not in a JS string that TextEncoder repairs.
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(entry.raw_json)), entry.raw_json);
  } else {
    assert.equal(typeof entry.raw_utf8_hex, "string");
    assert.match(entry.raw_utf8_hex, /^(?:[a-f0-9]{2})*$/);
  }
  Object.freeze(entry);
  results[entry.id] = evaluate(entry);
  assert.deepEqual(results[entry.id], entry.expected, `${entry.id}: candidate expectation`);
}
assert.equal(JSON.stringify(corpus), before, "Candidate evaluation mutated input");
const interpreter = process.env.P1_REVIEW_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const reference = spawnSync(interpreter, [path.join(root, "scripts/check-p1-json.py"), inputPath], {
  cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
});
assert.ifError(reference.error);
assert.equal(reference.status, 0, `Python3.9+ required; no skip: ${reference.stderr}`);
const python = JSON.parse(reference.stdout);
assert.equal(python.stdlib_only, true);
assert.deepEqual(python.results, results, "Node/Python raw-byte candidates disagree");
console.log(JSON.stringify({
  candidate_raw_json_cases: ids.size,
  accepted: Object.values(results).filter(result => result.accepted).length,
  rejected: Object.values(results).filter(result => !result.accepted).length,
  node: process.version, python: python.python, node_parser: "jsonc-parser@3.3.1",
  raw_json_decoder_scope: "host-only corpus prototype, not a production decoder",
  desktop_joint_contract: "pending", canonical_bytes_verified: false,
  android_native_executed: false, storage_executed: false,
}, null, 2));
