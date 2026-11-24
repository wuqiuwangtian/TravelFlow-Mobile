import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";

const bundle = new URL("../vendor/contracts/expense-create-candidate/", import.meta.url);
const read = name => readFileSync(new URL(name, bundle));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = read("manifest.json");
assert.equal(hash(manifestBytes), "99722538b7c006cc7caaa31612f83d0d831b925bd21296dc5737a0448c1b8642");
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.contract_version, "0.1.0-candidate.2");
assert.equal(manifest.shared_contract_version, null);
const entries = readdirSync(bundle, { withFileTypes: true });
assert.ok(entries.every(entry => entry.isFile()));
assert.deepEqual(entries.map(entry => entry.name).sort(), ["manifest.json", ...Object.keys(manifest.files)].sort());
for (const [name, expected] of Object.entries(manifest.files)) assert.equal(hash(read(name)), expected, name);

const { cases, relations } = JSON.parse(read("canonical-digests.json"));
const digests = new Map();
for (const item of cases) {
  const actual = fingerprintIntent(Buffer.from(item.raw_json), item.channel);
  for (const field of ["canonical_json", "canonical_utf8_hex", "sha256"]) assert.equal(actual[field], item[field], item.id);
  digests.set(item.id, actual.sha256);
  console.log(item.id, actual.sha256);
}
for (const { relation, ids } of relations) {
  const values = ids.map(id => digests.get(id));
  assert.ok(values.every(Boolean));
  assert.equal(new Set(values).size, relation === "same" ? 1 : ids.length);
}
