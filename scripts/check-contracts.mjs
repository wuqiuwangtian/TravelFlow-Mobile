import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "vendor/contracts/ledger-v1");
const manifest = JSON.parse(readFileSync(path.join(bundle, "manifest.json"), "utf8"));
assert.equal(manifest.contract_id, "travelflow.ledger-projection");
assert.equal(manifest.contract_version, "0.1.0");
assert.equal(manifest.status, "experimental");
assert.deepEqual(Object.keys(manifest.files).sort(), ["SPEC.md", "ledger-vectors.json"]);
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = createHash("sha256").update(readFileSync(path.join(bundle, name))).digest("hex");
  assert.equal(actual, expected, `Contract drift: ${name}; publish a new version instead of overwriting`);
}
const corpus = JSON.parse(readFileSync(path.join(bundle, "ledger-vectors.json"), "utf8"));
assert.equal(corpus.schema_version, manifest.fixture_schema_version);
assert.equal(corpus.cases.length, 14);
console.log("Ledger contract 0.1.0 manifest and fixture checks passed.");

const sha256 = data => createHash("sha256").update(data).digest("hex");
const origin = JSON.parse(readFileSync(path.join(root, "vendor/contracts/ORIGIN.json"), "utf8"));
assert.equal(origin.repository, "https://github.com/wuqiuwangtian/TravelFlow-AI");
assert.match(origin.commit, /^[a-f0-9]{40}$/);
assert.equal(origin.path, "contracts/ledger-v1");
assert.equal(sha256(readFileSync(path.join(bundle, "manifest.json"))), origin.manifest_sha256);
const design = JSON.parse(readFileSync(path.join(root, "vendor/design/ORIGIN.json"), "utf8"));
assert.match(design.commit, /^[a-f0-9]{40}$/);
assert.deepEqual(Object.keys(design.files).sort(), ["components.css", "tokens.css"]);
for (const [name, expected] of Object.entries(design.files)) {
  assert.equal(sha256(readFileSync(path.join(root, "vendor/design", name))), expected, `Design snapshot drift: ${name}`);
}
console.log("Pinned contract provenance and shared design snapshot checks passed.");
