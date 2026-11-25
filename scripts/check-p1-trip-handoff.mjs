// Explicit, isolated integration test. The mobile build uses only the generated public trip context.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";
import { adb, assertIsolatedAvd, buildApk, forceStopAndReopen, getAirplaneMode, launchAndAttach,
  PACKAGE, setAirplaneMode, setInputValue, waitForCondition } from "./check-p1-offline-entry-android.mjs";

const ref = "aeb4a3e540f62a3d1b2d9e706995c4db05e4fe7a";
const { values } = parseArgs({ options: {
  "desktop-repo": { type: "string" }, "desktop-python": { type: "string" },
  serial: { type: "string" }, "cdp-port": { type: "string", default: "19241" },
} });
const serial = values.serial;
assert.equal(serial, "emulator-5580");
const port = Number(values["cdp-port"]);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const repo = path.resolve(values["desktop-repo"]);
const python = path.resolve(values["desktop-python"]);
assertIsolatedAvd(serial);
assert.ok(!adb(serial, ["forward", "--list"]).stdout.split(/\s+/).includes(`tcp:${port}`), "CDP port already forwarded");
const airplane = getAirplaneMode(serial);
const work = mkdtempSync(path.join(tmpdir(), "travelflow-joint-"));
const desktop = path.join(work, "desktop");
const trip = path.join(work, "trip");
const archive = path.join(work, "source.tar");
const script = path.join(desktop, "backend/scripts/exchange_trip_handoff.py");
let installed = false;
let built, session;

function cli(args, input, expected = 0) {
  const proc = spawnSync(python, [script, ...args], { cwd: desktop, input, timeout: 120000 });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, expected, proc.stderr.toString() + proc.stdout.toString());
  if (expected === 86) {
    assert.equal(proc.stdout.length, 0, "Fault must drop the reply");
    return;
  }
  return JSON.parse(proc.stdout);
}
const sql = query => adb(serial, ["shell",
  `run-as ${PACKAGE} sqlite3 -readonly files/p1-offline-trip-ledger/store.db '${query}'`]).stdout.trim();
const readBytes = () => Buffer.from(sql("SELECT hex(CAST(raw_command_json AS BLOB)) FROM outbox"), "hex");
const phone = expression => session.cdp.evaluate(`window.__travelflowOfflineEntry.${expression}`);
const restart = async () => {
  const oldPid = session.pid;
  session.cdp.close();
  session = await forceStopAndReopen(serial, port, oldPid);
};
try {
  mkdirSync(desktop);
  execFileSync("git", ["-C", repo, "archive", "-o", archive, ref, "backend", "desktop"]);
  execFileSync("tar", ["-xf", archive, "-C", desktop]);
  const contextPath = path.join(trip, "context.json");
  const ctx = cli(["init-trip", "--work-dir", trip, "--context-out", contextPath]);
  const args = ["--database", ctx.database, "--scope", ctx.scope_config, "--input", "-"];
  const inspect = () => cli(["inspect-trip", "--database", ctx.database, "--branch-id", ctx.branch_id,
    "--fork-branch-id", ctx.fork_branch_id]);
  const before = inspect();
  assert.equal(before.head_revision_id, ctx.current_revision_id);
  built = buildApk(contextPath);
  adb(serial, ["install", "-t", built.apk]);
  installed = true;
  setAirplaneMode(serial, true);
  assert.equal(getAirplaneMode(serial), "1");
  session = await launchAndAttach(serial, port);
  const initial = await phone("inspect()");
  assert.deepEqual([initial.datasetId, initial.travelId, initial.branchId, initial.headRevisionId, initial.expenseCount],
    [ctx.dataset_id, ctx.travel_id, ctx.branch_id, ctx.current_revision_id, 0]);

  await session.cdp.tap("#trip-open-entry-btn");
  await waitForCondition(session.cdp, "window.__travelflowOfflineEntry.getUiState().entryViewVisible", "entry form");
  const title = "机场地铁票";
  await setInputValue(session.cdp, "trip-entry-title", title);
  await setInputValue(session.cdp, "trip-entry-amount-yuan", "17.23");
  await setInputValue(session.cdp, "trip-entry-category", "transport");
  await session.cdp.tap("#trip-entry-save-btn");
  await waitForCondition(session.cdp, "window.__travelflowOfflineEntry.getUiState().lastAttempt.outcome === 'saved'", "offline save");
  await restart();
  const raw = readBytes();
  const cmd = JSON.parse(raw);
  assert.deepEqual([cmd.operation.dataset_id, cmd.operation.source_device_id, cmd.target.travel_id,
    cmd.target.branch_id, cmd.expected_revision_id, cmd.payload.amount_cents, cmd.payload.title],
    [ctx.dataset_id, ctx.authorized_devices[0], ctx.travel_id, ctx.branch_id, ctx.current_revision_id, 1723, title]);
  const exported = await phone("exportOutboxCommands()");
  assert.equal(exported.count, 1);
  const item = exported.items[0];
  assert.deepEqual(Buffer.from(item.raw_command_json), raw);
  const digest = fingerprintIntent(raw).sha256;
  assert.equal(item.intent_sha256, digest);
  cli(["receive", ...args, "--fault", "after_commit_before_reply"], raw, 86);
  await restart();
  const pending = await phone("inspect()");
  assert.equal(pending.outboxCount, 1);
  assert.equal(pending.expenses[0].desktop_revision_id, null);
  const retryBytes = readBytes();
  assert.deepEqual(retryBytes, raw);
  const replay = cli(["receive", ...args], retryBytes);
  assert.deepEqual([replay.ok, replay.state, replay.replayed], [true, "committed", true]);
  assert.equal(replay.receipt.intent_sha256, digest);
  const confirm = response => phone(`confirmDelivery(${JSON.stringify(cmd.operation.operation_id)},${JSON.stringify(response)})`);
  const mismatch = structuredClone(replay);
  mismatch.receipt.intent_sha256 = "0".repeat(64);
  assert.equal((await confirm(mismatch)).accepted, false);
  assert.equal((await phone("inspect()")).outboxCount, 1);
  assert.equal((await confirm(replay)).accepted, true);
  await restart();

  assert.equal(sql("SELECT desktop_revision_id FROM outbox"), replay.receipt.result_revision_id);
  const lookup = cli(["lookup", ...args], Buffer.from(JSON.stringify(item.receipt_query)));
  assert.deepEqual(lookup.receipt, replay.receipt);
  assert.equal((await confirm(lookup)).accepted, true);
  const conflicting = structuredClone(replay);
  conflicting.receipt.result_revision_id += "-different";
  assert.equal((await confirm(conflicting)).accepted, false);
  const localReplay = await phone(`submitRawStrings(${JSON.stringify(item.raw_command_json)},${JSON.stringify(item.canonical_intent_json)})`);
  assert.deepEqual([localReplay.replayed, localReplay.delivery_state], [true, "confirmed"]);
  const after = inspect();
  const local = await phone("inspect()");
  const revision = lookup.receipt.result_revision_id;
  assert.ok(revision && revision !== ctx.current_revision_id);
  assert.deepEqual(after.version_ids, [...before.version_ids, revision]);
  assert.equal(after.head_revision_id, revision);
  assert.deepEqual(after.fork, before.fork);
  assert.deepEqual(after.head_expenses, [...before.head_expenses,
    { id: cmd.target.entity_id, title, amount_cents: 1723, category: "transport" }]);
  assert.equal(after.head_paid_cents, before.head_paid_cents + 1723);
  assert.equal(after.receipts.length, before.receipts.length + 1);
  const receipt = after.receipts.find(r => r.operation_id === cmd.operation.operation_id);
  assert.equal(receipt.result_version_id, revision);
  assert.equal(receipt.intent_sha256, digest);
  assert.equal((await phone("exportOutboxCommands()")).count, 0);
  assert.deepEqual([local.expenseCount, local.totalCents, local.expenses[0].delivery_state, local.expenses[0].desktop_revision_id],
    [1, 1723, "confirmed", revision]);
  assert.equal(sql("SELECT desktop_revision_id FROM outbox"), revision);
  assert.match((await phone("getUiState()")).syncStatusText, /桌面已确认/);
  assert.deepEqual(readBytes(), raw);
  console.log(JSON.stringify({ desktopCommit: ref, operation: cmd.operation, entity: cmd.target.entity_id,
    travel: ctx.travel_id, branch: ctx.branch_id, baseline: ctx.current_revision_id,
    bytes: raw.length, rawSha256: createHash("sha256").update(raw).digest("hex"), intentSha256: digest,
    faultExit: 86, replayed: replay.replayed, mobileLocalRevision: local.headRevisionId,
    mobileConfirmedRevision: local.expenses[0].desktop_revision_id, desktopReceiptRevision: receipt.result_version_id,
    desktopHead: after.head_revision_id, phonePaidCents: local.totalCents, desktopPaidBefore: before.head_paid_cents,
    desktopPaidAfter: after.head_paid_cents, expensesBefore: before.head_expenses.length, expensesAfter: after.head_expenses.length,
    pendingAfter: local.outboxCount, forkUnchanged: true }, null, 2));
} finally {
  session?.cdp.close();
  if (installed) {
    setAirplaneMode(serial, airplane === "1");
    adb(serial, ["forward", "--remove", `tcp:${port}`], {allowFailure: true});
    adb(serial, ["uninstall", PACKAGE]);
  }
  if (built) rmSync(built.tempRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
