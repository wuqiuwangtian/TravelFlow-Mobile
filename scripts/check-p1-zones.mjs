// Offline checks against a pinned name list, actual host rules and a temporary store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bookingZone, zoneCapability, ZONE_CATALOGUE_ID } from "../prototypes/p1-zones/catalogue.mjs";
import { capabilities } from "../prototypes/p1-boundary/commands.mjs";
import { SyntheticStore } from "../prototypes/p1-store/sqlite.mjs";
import { emptyFixtureState } from "../prototypes/p1-store/legacy.mjs";

const encode = value => Buffer.from(JSON.stringify(value));
const principal = { authenticated: true, can_write: true, can_query: true, dataset_id: "fixture-zone", source_device_id: "fixture-device" };
const calendar = { day: 1, revision_id: "fixture-calendar", day_date: "2026-11-01" };
function booking(version) {
  return { profile: "p1-host-control-1", kind: "booking.set", expected_revision_id: "fixture-root",
    operation: { dataset_id: principal.dataset_id, source_device_id: principal.source_device_id, operation_id: "initial" },
    target: { travel_id: "fixture-trip", branch_id: "fixture-branch", entity_id: "activity" },
    payload: { time_zone: "US/Eastern", start_time: "01:30", start_day_offset: 0, duration_minutes: 120,
      duration_semantics: "elapsed", local_start: "2026-11-01T01:30", utc_offset: "-04:00", start_instant: "2026-11-01T05:30:00.000Z",
      notes: "", resolution_basis: { calendar_revision_id: calendar.revision_id, zone_catalogue_id: ZONE_CATALOGUE_ID, tzdata_version: version } } };
}

if (process.argv[2] === "--replay-worker") {
  // Only the reported resolver version changes in this throwaway child.
  const original = booking(process.versions.tz);
  Object.defineProperty(process.versions, "tz", { value: "1900a" });
  const store = new SyntheticStore(process.argv[3]);
  try {
    const before = store.inspectFixture();
    const replay = store.execute(encode(original), principal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.result_revision_id, before.head);
    const lookup = store.query(encode({ profile: "p1-host-query-1", kind: "receipt.lookup", operation: original.operation }), principal);
    assert.equal(lookup.receipt.result_revision_id, before.head);
    original.expected_revision_id = before.head;
    original.operation.operation_id = "new-after-change";
    assert.deepEqual(store.execute(encode(original), principal), { accepted: false, error: "resolution_basis" });
    assert.deepEqual(store.inspectFixture(), before);
    original.operation.operation_id = "notes-after-change";
    original.kind = "booking.notes.patch";
    original.payload = { notes: "已联系酒店" };
    assert.equal(store.execute(encode(original), principal).accepted, true);
    assert.deepEqual(store.inspectFixture().state.activities[0].booking, { ...before.state.activities[0].booking, notes: "已联系酒店" });
  } finally { store.close(); }
} else {
  assert.equal(process.argv.length, 2);
  const bytes = readFileSync(new URL("../prototypes/p1-zones/catalogue.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7665f2e2f63e6b0e36c32a95191316aa772df9de2bbd02fc754d0de21548e1db");
  const { zones, links } = JSON.parse(bytes);
  const cap = capabilities(encode({ profile: "p1-host-query-1", kind: "capabilities.query" })).iana_booking;
  assert.deepEqual(cap, zoneCapability());
  const all = [...zones, ...Object.keys(links)];
  assert.equal(new Set(all).size, 598);
  const peer = spawnSync(process.env.P1_REVIEW_PYTHON ?? "python3", [fileURLToPath(new URL("check-p1-zones.py", import.meta.url))], { encoding: "utf8" });
  assert.ifError(peer.error);
  assert.equal(peer.status, 0, peer.stderr);
  const python = JSON.parse(peer.stdout);
  assert.deepEqual(Object.keys(python.offsets).sort(), [...all].sort());
  const instant = new Date("2026-11-02T12:00:00Z"), offsets = new Map(), diffs = [];
  const fails = (call, code) => assert.throws(call, error => error.code === code);
  for (const name of all) {
    const target = links[name] ?? name;
    assert.ok(zones.includes(target));
    if (cap.unavailable_targets.includes(target)) {
      fails(() => bookingZone(name, cap), "zone_unavailable");
      continue;
    }
    assert.equal(bookingZone(name, cap), target);
    if (!offsets.has(target)) {
      const parts = new Intl.DateTimeFormat("en", { timeZone: target, timeZoneName: "longOffset" }).formatToParts(instant);
      const offset = parts.find(part => part.type === "timeZoneName").value;
      const match = /^GMT(?:([+-])(\d\d):(\d\d))?$/.exec(offset);
      assert.ok(match, offset);
      offsets.set(target, match[1] ? (match[1] === "-" ? -1 : 1) * (+match[2] * 3600 + +match[3] * 60) : 0);
    }
    if (python.offsets[name] !== null && python.offsets[name] !== offsets.get(target)) diffs.push(name);
  }
  assert.equal(offsets.get("Asia/Shanghai"), 28800);
  assert.equal(python.offsets["Asia/Shanghai"], 28800);
  assert.equal(python.offsets["US/Eastern"], -18000);
  for (const id of ["us/Eastern", "US/Eastern ", "Etc/Unknown", "+05:30", "toString"]) fails(() => bookingZone(id, cap), "zone");
  fails(() => bookingZone("Factory", cap), "zone_unavailable");
  for (const change of [{ tzdata_version: null }, { tzdata_version: "1900a" }, { zone_catalogue_id: "other" }])
    fails(() => bookingZone("Cuba", cap, { ...cap, ...change }), "resolution_basis");
  fails(() => bookingZone("Cuba", cap, { ...cap, unavailable_targets: ["America/Havana"] }), "zone_unavailable");
  const havana = offsets.get("America/Havana");
  if (cap.tzdata_version === "2026b") assert.equal(havana, -18000);
  if (python.tzdata_version === "2026f") assert.equal(python.offsets.Cuba, -14400);
  if (cap.tzdata_version !== python.tzdata_version)
    fails(() => bookingZone("Cuba", cap, { ...cap, tzdata_version: python.tzdata_version }), "resolution_basis");

  const state = emptyFixtureState();
  state.calendar = calendar;
  state.activities.push({ id: "activity", day: 1, progress: "not_started", booking: null });
  const store = SyntheticStore.create({ dataset_id: principal.dataset_id, travel_id: "fixture-trip", branch_id: "fixture-branch", revision_id: "fixture-root", state });
  try {
    const body = booking(cap.tzdata_version);
    const before = store.inspectFixture();
    for (const [zone, code] of [["America/Puerto_Rico", "resolution"], ["US/eastern", "zone"], ["Factory", "zone_unavailable"]]) {
      const invalid = structuredClone(body);
      invalid.payload.time_zone = zone;
      if (code === "resolution") {
        invalid.payload.utc_offset = "-05:00";
        invalid.payload.start_instant = "2026-11-01T06:30:00.000Z";
      }
      assert.deepEqual(store.execute(encode(invalid), principal), { accepted: false, error: code });
      assert.deepEqual(store.inspectFixture(), before);
    }
    const legacyProfile = structuredClone(body);
    legacyProfile.payload.resolution_basis.zone_catalogue_id = "p1-test-zones-1";
    assert.deepEqual(store.execute(encode(legacyProfile), principal), { accepted: false, error: "zone" });
    const result = store.execute(encode(body), principal);
    assert.equal(result.effect, "changed");
    const saved = store.inspectFixture().state.activities[0].booking;
    assert.equal(saved.time_zone, "US/Eastern");
    assert.deepEqual(saved.resolution_basis, body.payload.resolution_basis);
    assert.equal(saved.end_local, "2026-11-01T02:30");
    assert.equal(saved.end_utc_offset, "-05:00");
    assert.equal(saved.end_instant, "2026-11-01T07:30:00.000Z");
    body.payload.time_zone = "America/New_York";
    assert.deepEqual(store.execute(encode(body), principal), { accepted: false, error: "intent_conflict" });
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--replay-worker", store.directory], { encoding: "utf8" });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const nepal = booking(cap.tzdata_version);
    nepal.operation.operation_id = "kathmandu";
    nepal.expected_revision_id = store.inspectFixture().head;
    Object.assign(nepal.payload, { time_zone: "Asia/Kathmandu", utc_offset: "+05:45", start_instant: "2026-10-31T19:45:00.000Z" });
    assert.equal(store.execute(encode(nepal), principal).effect, "changed");
    const next = store.inspectFixture().state.activities[0].booking;
    assert.equal(next.time_zone, "Asia/Kathmandu");
    assert.equal(next.end_local, "2026-11-01T03:30");
    assert.equal(next.end_utc_offset, "+05:45");
  } finally { store.close(); rmSync(store.directory, { recursive: true, force: true }); }
  console.log(JSON.stringify({ catalogue: ZONE_CATALOGUE_ID, zones: zones.length, links: Object.keys(links).length,
    node_tz: cap.tzdata_version, unavailable_targets: cap.unavailable_targets, python_system_tz: python.tzdata_version,
    python_missing_names: all.filter(name => python.offsets[name] === null), at_utc: instant.toISOString(), offset_differences: diffs,
    havana_offset_seconds: { node: havana, python: python.offsets.Cuba }, sqlite_booking_and_replay_checked: true }, null, 2));
}
