// Isolated verification of TravelFlow-AI 801156fcbe8dcc96d99b0fb122e0fa97097f8af8.
// Takes the pinned expected.json and fictional-trip.sqlite.gz, never a live database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { desktopFixtureManifest } from "../prototypes/p1-store/desktop-source.mjs";
import { emptyFixtureState } from "../prototypes/p1-store/legacy.mjs";
import { SyntheticStore } from "../prototypes/p1-store/sqlite.mjs";

assert.equal(process.argv.length, 3, "Usage: node scripts/check-p1-desktop-d1.mjs FIXTURE_DIRECTORY");
const input = process.argv[2];
const expected = JSON.parse(readFileSync(path.join(input, "expected.json"), "utf8"));
const digest = data => createHash("sha256").update(data).digest("hex");
const bytes = gunzipSync(readFileSync(path.join(input, "fictional-trip.sqlite.gz")), { maxOutputLength: 4 * 1024 * 1024 });
assert.equal(expected.database_sha256, "85efb0ae4663d7416d9495d9beb6b0d145a7559085799c5a37791a39c8911cc3");
assert.equal(digest(bytes), expected.database_sha256, "uncompressed database differs from expected.json");

const dir = mkdtempSync(path.join(tmpdir(), "travelflow-d1-source-"));
const source = path.join(dir, "fictional-trip.sqlite");
let db, target, targetDir;
try {
  writeFileSync(source, bytes, { flag: "wx", mode: 0o400 });
  // Read the pinned, closed file without SQLite creating WAL/SHM sidecars.
  const uri = pathToFileURL(source);
  uri.search = "mode=ro&immutable=1";
  db = new DatabaseSync(uri.href, { readOnly: true });
  assert.deepEqual(db.prepare("SELECT id,title FROM sessions").all().map(r => [r.id, r.title]), [[expected.session, expected.title]]);
  const branches = db.prepare("SELECT id,is_primary,parent_branch_id,fork_version_id FROM branches WHERE session_id=? ORDER BY is_primary DESC")
    .all(expected.session);
  assert.deepEqual(branches.map(r => [r.id, r.is_primary, r.parent_branch_id, r.fork_version_id]), [
    [expected.main_branch, 1, null, null],
    [expected.fork_branch, 0, expected.main_branch, expected.fork_from],
  ]);
  const scopes = [[expected.main_branch, expected.main_versions], [expected.fork_branch, expected.fork_versions]];
  const snapshots = [];
  for (const [branch, ids] of scopes) {
    const versions = db.prepare("SELECT v.id,v.seq,p.itinerary FROM versions v LEFT JOIN plans p ON p.version_id=v.id WHERE v.branch_id=? ORDER BY v.seq")
      .all(branch);
    assert.deepEqual(versions.map(row => row.id), ids);
    for (const [index, row] of versions.entries()) {
      assert.equal(row.seq, index + 1);
      const plan = JSON.parse(row.itinerary);
      const expenses = plan.expenses.map(e => [e.id, e.title, e.amount_cents, e.receipt_ids]);
      const paid = branch === expected.main_branch && index >= 1;
      assert.deepEqual(expenses, paid ? [["d1-fictional-lunch", "虚构午餐", expected.amount_cents, [expected.receipt]]] : []);
      const photos = plan.recap?.photos ?? [];
      const hasPhoto = branch === expected.main_branch && index === 2;
      assert.deepEqual(photos.map(p => [p.id, p.included, p.caption]), hasPhoto ? [[expected.photo, true, "蓝色样图"]] : []);
      assert.equal(plan.recap?.cover_photo_id ?? null, hasPhoto ? expected.photo : null);
      snapshots.push({ branch, version: row.id, seq: row.seq, expenses, photos: photos.map(p => p.id) });
    }
  }
  const receipts = db.prepare("SELECT id,session_id,original_data,preview_data FROM receipt_assets").all();
  const photos = db.prepare("SELECT id,session_id,image_data FROM photo_assets").all();
  assert.deepEqual(receipts.map(r => [r.id, r.session_id]), [[expected.receipt, expected.session]]);
  assert.deepEqual(photos.map(r => [r.id, r.session_id]), [[expected.photo, expected.session]]);
  const hashes = {
    [`receipts/${expected.receipt}`]: digest(receipts[0].preview_data),
    [`receipts/${expected.receipt}?original=true`]: digest(receipts[0].original_data),
    [`travel-photos/${expected.photo}`]: digest(photos[0].image_data),
  };
  assert.deepEqual(hashes, expected.attachments_sha256);
  const applicationId = db.prepare("PRAGMA application_id").get().application_id;
  assert.equal(applicationId, 0);

  // A seeded disposable target witnesses any writes. Manifest extraction precedes import.
  const dataset = "fixture-d1-target";
  target = SyntheticStore.create({ dataset_id: dataset, travel_id: "fixture-trip", branch_id: "fixture-branch",
    revision_id: "fixture-root", state: emptyFixtureState() });
  targetDir = target.directory;
  const before = target.inspectFixture(), initialChanges = target.totalChanges();
  const principal = { authenticated: true, can_write: true, dataset_id: dataset, source_device_id: "fixture-device" };
  let imports = 0;
  for (const [branch, ids] of scopes) {
    assert.throws(() => {
      const manifest = desktopFixtureManifest(db, { dataset: "fixture-d1", travel: expected.session, branch, head: ids.at(-1) });
      imports++;
      target.importFixtureHistory(manifest, principal);
    }, error => error.code === "source_fixture_only");
    assert.equal(imports, 0);
    assert.equal(db.isTransaction, false);
    assert.equal(target.totalChanges(), initialChanges);
    assert.deepEqual(target.inspectFixture(), before);
  }
  target.close();
  target = new SyntheticStore(targetDir);
  assert.deepEqual(target.inspectFixture(), before);
  db.close(); db = undefined;
  assert.deepEqual(readdirSync(dir), ["fictional-trip.sqlite"]);
  assert.equal(digest(readFileSync(source)), expected.database_sha256);
  console.log(JSON.stringify({ database_sha256: expected.database_sha256, snapshots, attachments_sha256: hashes,
    application_id: applicationId, reader_result_each_branch: "source_fixture_only", import_calls: imports,
    target_row_changes: 0, target_unchanged_after_reopen: true, source_sha256_unchanged: true }, null, 2));
} finally {
  db?.close();
  target?.close();
  if (targetDir) rmSync(targetDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
