import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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

// Frozen desktop release d916697828ad3d2f0e87a3a231b996c7873d421b;
// the candidate was independently reviewed by mobile at 8ba3365.
function verifyExpenseSnapshot(directory, manifestDigest) {
  const read = name => readFileSync(path.join(root, "vendor/contracts", directory, name));
  const bytes = read("manifest.json");
  assert.equal(sha256(bytes), manifestDigest, directory);
  const manifest = JSON.parse(bytes);
  const entries = readdirSync(path.join(root, "vendor/contracts", directory), { withFileTypes: true });
  assert.ok(entries.every(entry => entry.isFile()), directory);
  assert.deepEqual(entries.map(entry => entry.name).sort(), ["manifest.json", ...Object.keys(manifest.files)].sort());
  for (const [name, digest] of Object.entries(manifest.files)) assert.equal(sha256(read(name)), digest, name);
  return { manifest, json: name => JSON.parse(read(name)) };
}

const candidate = verifyExpenseSnapshot("expense-create-candidate", "99722538b7c006cc7caaa31612f83d0d831b925bd21296dc5737a0448c1b8642");
const frozen = verifyExpenseSnapshot("expense-create-v0.1.0", "759145bea1b98f086af4c70938ae33932b6cc0ba0527e12dc62faaf90733b8b1");
assert.deepEqual(Object.keys(frozen.manifest.files).sort(), Object.keys(candidate.manifest.files).sort());
for (const name of Object.keys(frozen.manifest.files).filter(name => name.endsWith(".json"))) {
  const expected = candidate.json(name);
  expected.contract_id = "travelflow.expense-create";
  expected.contract_version = "0.1.0";
  expected.status = "frozen";
  if (Object.hasOwn(expected, "shared_contract_version")) expected.shared_contract_version = "0.1.0";
  if (name === "desktop-assertions.json") expected.desktop_baseline_commit = "d7cd845";
  if (name === "result-mapping.json") {
    expected.evidence_commits.source_candidate_commit = "94ec1fb";
    expected.evidence_commits.mobile_candidate_2_receipt = "8ba3365";
  }
  assert.deepEqual(frozen.json(name), expected, name);
}
console.log("Frozen expense-create 0.1.0 snapshot and candidate equivalence checks passed.");

// Reverse-delivery review package at desktop ebf1c2fcdd90a48ee2da90ed75d8af85fc3ad7eb.
verifyExpenseSnapshot("expense-patch-candidate", "26634e1ebe54b44803361af707eee6d68fca7420f8eb89f1bdba967cf6795cdc");
// Second candidate at desktop cfc7a1cfafc02119aaa15242da9dd48458d059aa.
verifyExpenseSnapshot("expense-patch-candidate.2", "99168dc8137e38e7c654b7571f833ad5df7627a1ef14312e46ee68f7a2c319e0");
