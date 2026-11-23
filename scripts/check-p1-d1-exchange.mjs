// Read-only receipt for the single pinned D1 exchange fixture. No database adapter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

assert.equal(process.argv.length, 3, "Usage: node scripts/check-p1-d1-exchange.mjs BUNDLE_DIRECTORY");
const root = process.argv[2];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = readFileSync(path.join(root, "manifest.json"));
const manifestHash = sha256(manifestBytes);
assert.equal(manifestHash, "ec9937ce2a6cd0ef2c9fcf311158ffe536efa30915697ad26ba61dae6090065c");
const manifest = JSON.parse(manifestBytes);
const files = new Map();
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = readFileSync(path.join(root, name));
  assert.equal(bytes.length, expected.size, name);
  assert.equal(sha256(bytes), expected.sha256, name);
  files.set(name, bytes);
}
const exchange = JSON.parse(files.get(manifest.exchange_file));
const session = "92ba6a148a17";
const main = "f4f921d01f4e", fork = "80a581ac74f9";
const [first, second, third, alternative] = ["409854fb9585", "42ac255b7c33", "9639db1eb3b8", "ce99e5ec7352"];
const receipt = "66a8ba9d2eab4300b2f86943ea2c01fe", photo = "7827bcc19b524e83b8bfd560be0ea667";
assert.deepEqual(exchange.sessions.map(s => s.id), [session]);
assert.deepEqual(exchange.branches.map(b => [b.id, b.session_id, b.is_primary, b.parent_branch_id,
  b.fork_source_branch_id, b.fork_version_id, b.version_ids]), [
  [main, session, true, null, null, null, [first, second, third]],
  [fork, session, false, main, main, first, [alternative]],
]);
const snapshots = exchange.versions.map(v => {
  const bytes = files.get(v.plan.raw_itinerary_path);
  assert.equal(bytes.length, v.plan.raw_itinerary_size);
  assert.equal(sha256(bytes), v.plan.raw_itinerary_sha256);
  const plan = JSON.parse(bytes);
  assert.deepEqual(v.expenses, plan.expenses);
  const refs = {
    receipt_ids: plan.expenses.flatMap(e => e.receipt_ids),
    photo_ids: (plan.recap?.photos ?? []).map(p => p.id),
    cover_photo_id: plan.recap?.cover_photo_id ?? null,
  };
  assert.deepEqual(v.attachment_refs, refs);
  assert.equal(v.expenses_total_cents, plan.expenses.reduce((sum, e) => sum + e.amount_cents, 0));
  assert.equal(v.session_id, session);
  return [v.id, v.branch_id, v.seq, v.parent_relation.kind, v.parent_relation.parent_version_id,
    plan.expenses.map(e => [e.id, e.title, e.amount_cents, e.receipt_ids]), refs.photo_ids, refs.cover_photo_id];
});
const lunch = [["d1-fictional-lunch", "虚构午餐", 8635, [receipt]]];
assert.deepEqual(snapshots, [
  [first, main, 1, "branch_root", null, [], [], null],
  [second, main, 2, "branch_seq_predecessor", first, lunch, [], null],
  [third, main, 3, "branch_seq_predecessor", second, lunch, [photo], photo],
  [alternative, fork, 1, "fork_version_id", first, [], [], null],
]);
const attachments = exchange.attachments.map(a => {
  const bytes = files.get(a.relative_path);
  assert.equal(bytes.length, a.size);
  const digest = sha256(bytes);
  assert.equal(digest, a.sha256);
  assert.equal(a.session_id, session);
  return [a.kind, a.asset_id, bytes.length, digest];
});
assert.deepEqual(attachments, [
  ["receipt_preview", receipt, 3027, "a9e451b30c9bf1068c75598b8d140e09c23066b976ca4ce95040e4773b8591bb"],
  ["receipt_original", receipt, 1262, "bd796aa2879a95e06c873b9939a002f2383de5eb9cbca306bb9494aaad52f348"],
  ["travel_photo", photo, 1618, "8a2e01028b2592c6c1e0931ac062d003ffc1caa278a6a496e3244a76302be837"],
]);
console.log(JSON.stringify({ manifest_sha256: manifestHash, snapshots, attachments }, null, 2));
