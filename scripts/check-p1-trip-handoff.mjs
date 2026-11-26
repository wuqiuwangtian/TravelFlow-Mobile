// Explicit, isolated integration test. The mobile build uses only the generated public trip context.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fingerprintIntent, fingerprintPatchCandidate } from "../prototypes/p1-canonical/intent.mjs";
import { adb, assertIsolatedAvd, buildApk, forceStopAndReopen, getAirplaneMode, launchAndAttach,
  PACKAGE, setAirplaneMode, setInputValue, waitForCondition } from "./check-p1-offline-entry-android.mjs";


const { values } = parseArgs({ options: {
  "confirm-outbound": { type: "boolean" }, "patch": { type: "boolean" }, "roundtrip": { type: "boolean" }, "desktop-repo": { type: "string" }, "desktop-python": { type: "string" },
  serial: { type: "string" }, "cdp-port": { type: "string", default: "19241" },
} });
assert.ok(!(values.patch && values.roundtrip), "Select one handoff mode");
const confirmOutbound = values["confirm-outbound"];
assert.ok(!confirmOutbound || values.roundtrip, "--confirm-outbound requires --roundtrip");
const ref = confirmOutbound ? "f5f8a982c350b60794439b563f5d8f3af5cd048a" : values.roundtrip ? "5ef28acbbbee10d0bd9527b7c2deb043e1930230" : values.patch ? "cfc7a1cfafc02119aaa15242da9dd48458d059aa" : "aeb4a3e540f62a3d1b2d9e706995c4db05e4fe7a";
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
let built, upgraded, session;

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
  const inspectFork = () => cli(["inspect-trip", "--database", ctx.database, "--branch-id", ctx.fork_branch_id]);
  const originalFork = values.roundtrip ? inspectFork() : null;
  if (values.patch || values.roundtrip) {
    const previous = path.join(work, "mobile-before-upgrade");
    mkdirSync(previous);
    execFileSync("git", ["archive", "-o", archive, confirmOutbound ? "641fd852c54a9dee545bbdeeb86ad6651464e0c7" : values.roundtrip ? "f944d014362ededc2624f6d49f4ad5c7835a2649" : "5d34b2ddd5e90de3261f81b6392b7928ee106ff7"]);
    execFileSync("tar", ["-xf", archive, "-C", previous]);
    symlinkSync(path.resolve("node_modules"), path.join(previous, "node_modules"));
    built = buildApk(contextPath, previous);
    if (values.patch) upgraded = buildApk(contextPath);
  } else {
    built = buildApk(contextPath);
  }
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
  if (!values.patch) assert.equal(local.syncedDesktopRevisionId, revision);
  assert.match((await phone("getUiState()")).syncStatusText, /对端已确认/);
  assert.deepEqual(readBytes(), raw);
  console.log(JSON.stringify({ desktopCommit: ref, operation: cmd.operation, entity: cmd.target.entity_id,
    travel: ctx.travel_id, branch: ctx.branch_id, baseline: ctx.current_revision_id,
    bytes: raw.length, rawSha256: createHash("sha256").update(raw).digest("hex"), intentSha256: digest,
    faultExit: 86, replayed: replay.replayed, mobileLocalRevision: local.headRevisionId,
    mobileConfirmedRevision: local.expenses[0].desktop_revision_id, desktopReceiptRevision: receipt.result_version_id,
    desktopHead: after.head_revision_id, phonePaidCents: local.totalCents, desktopPaidBefore: before.head_paid_cents,
    desktopPaidAfter: after.head_paid_cents, expensesBefore: before.head_expenses.length, expensesAfter: after.head_expenses.length,
    pendingAfter: local.outboxCount, forkUnchanged: true }, null, 2));
  if (values.roundtrip) {
    const helper = path.resolve("scripts/p1-roundtrip-desktop.py");
    const desktopCall = (action, ...args) => JSON.parse(execFileSync(python, [helper, action, ctx.database, ...args],
      { cwd: desktop, timeout: 120000 }));
    const editedRevision = desktopCall("edit", revision, cmd.target.entity_id, ctx.branch_id);
    assert.notEqual(editedRevision, revision);
    const queue = desktopCall("queue");
    assert.deepEqual([queue.expected_revision_id, queue.source_revision_id, queue.delivery_state, queue.entity_id, queue.branch_id],
      [revision, editedRevision, "unsent", cmd.target.entity_id, ctx.branch_id]);
    const databaseArgs = ["--database", ctx.database];
    const status = () => cli(["outbound-status", ...databaseArgs]);
    let patchBytes = Buffer.from(queue.bytes_base64, "base64");
    let lookupText;
    if (confirmOutbound) {
      const commandFile = path.join(work, "outbound-command.json");
      const queryFile = path.join(work, "outbound-query.json");
      const prepared = cli(["prepare-outbound", ...databaseArgs, "--operation-id", queue.operation_id,
        "--command-out", commandFile, "--query-out", queryFile]);
      assert.equal(prepared.record.delivery_state, "verification_pending");
      const emitted = readFileSync(commandFile);
      assert.deepEqual(emitted, patchBytes);
      patchBytes = emitted;
      lookupText = readFileSync(queryFile, "utf8");
    }
    const patchText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(patchBytes);
    assert.deepEqual(Buffer.from(patchText), patchBytes);
    const canonical = fingerprintPatchCandidate(patchBytes, "control");
    assert.equal(canonical.sha256, queue.intent_sha256);
    const patch = JSON.parse(patchText);
    assert.deepEqual(patch.target, cmd.target);
    assert.deepEqual(patch.patch, { amount_cents: 2150 });
    assert.equal(patch.operation.operation_id, queue.operation_id);
    // Pass the persisted string verbatim through the bridge. Drop the first receipt inside the WebView.
    const delivery = `receiveDesktopCommand(${JSON.stringify(patchText)})`;
    assert.equal(await phone(delivery + ".then(r => r.ok && !r.replayed && r.state === 'committed')"), true);
    await restart();
    const savedReceipt = JSON.parse(sql("SELECT receipt_json FROM received_patches"));
    const savedDump = sql(".dump");
    const query = { profile: "p1-host-query-1", kind: "receipt.lookup", operation: patch.operation };
    if (confirmOutbound) {
      const pending = status();
      assert.deepEqual([pending.pending_count, pending.confirmed_count], [1, 0]);
      const row = pending.pending[0];
      assert.deepEqual([row.delivery_state, row.operation_id, row.confirmed_mobile_revision_id, row.raw_command_json],
        ["verification_pending", queue.operation_id, null, patchText]);
      assert.deepEqual(JSON.parse(lookupText), query);
    } else {
      assert.deepEqual(desktopCall("queue"), queue);
      assert.deepEqual(await phone(delivery), { ok: true, state: "committed", replayed: true, receipt: savedReceipt });
    }
    const lookupResponse = await phone(`receiveDesktopCommand(${JSON.stringify(lookupText ?? JSON.stringify(query))})`);
    assert.deepEqual(lookupResponse, { ok: true, state: "committed", receipt: savedReceipt });
    const end = await phone("inspect()");
    assert.deepEqual(end.expenses, [{ ...local.expenses[0], amount_cents: 2150 }]);
    assert.equal(end.totalCents, 2150);
    assert.equal(end.outboxCount, 0);
    assert.equal(sql("SELECT count(*) FROM received_patches"), "1");
    assert.equal(end.revisionCount, local.revisionCount + 1);
    assert.deepEqual(end.revisions.slice(0, -1), local.revisions);
    assert.equal(sql(".dump"), savedDump);
    assert.deepEqual(savedReceipt.operation, patch.operation);
    assert.deepEqual([savedReceipt.effect, savedReceipt.intent_sha256, savedReceipt.entity_id,
      savedReceipt.result_revision_id, savedReceipt.synced_desktop_revision_id, end.syncedDesktopRevisionId],
      ["changed", canonical.sha256, queue.entity_id, end.headRevisionId, editedRevision, editedRevision]);
    const finalTrip = inspect();
    assert.deepEqual(finalTrip.version_ids, [...after.version_ids, editedRevision]);
    assert.equal(finalTrip.head_revision_id, editedRevision);
    assert.deepEqual(finalTrip.head_expenses, [...before.head_expenses, { ...after.head_expenses.at(-1), amount_cents: 2150 }]);
    assert.equal(finalTrip.head_paid_cents, before.head_paid_cents + 2150);
    assert.deepEqual(finalTrip.fork, before.fork);
    const finalFork = inspectFork();
    assert.deepEqual(finalFork.head_expenses, originalFork.head_expenses);
    assert.equal(finalFork.head_paid_cents, originalFork.head_paid_cents);
    let deliveryState = queue.delivery_state;
    if (confirmOutbound) {
      const confirm = () => cli(["confirm-outbound", ...databaseArgs, "--operation-id", queue.operation_id,
        "--input", "-"], Buffer.from(JSON.stringify(lookupResponse)));
      const first = confirm();
      assert.deepEqual([first.ok, first.confirmed, first.already_confirmed], [true, true, false]);
      const confirmed = status(); // cli starts a new desktop process for every read.
      assert.deepEqual([confirmed.pending_count, confirmed.confirmed_count, confirmed.all.length], [0, 1, 1]);
      const row = confirmed.confirmed[0];
      const mobileHead = sql("SELECT head_revision_id FROM branch_head");
      assert.equal(mobileHead, savedReceipt.result_revision_id);
      assert.deepEqual([row.operation_id, row.delivery_state, row.confirmed_mobile_revision_id, row.confirmed_effect],
        [queue.operation_id, "confirmed", mobileHead, "changed"]);
      assert.deepEqual(JSON.parse(row.last_raw_response_json), lookupResponse);
      const afterFirst = inspect();
      assert.deepEqual(afterFirst.version_ids, finalTrip.version_ids);
      assert.deepEqual(afterFirst.receipts, finalTrip.receipts);
      assert.deepEqual(afterFirst.head_expenses, finalTrip.head_expenses);
      assert.equal(afterFirst.head_paid_cents, finalTrip.head_paid_cents);
      const again = confirm();
      assert.deepEqual([again.ok, again.confirmed, again.already_confirmed], [true, true, true]);
      assert.deepEqual(status(), confirmed);
      assert.deepEqual(inspect(), afterFirst);
      assert.equal(sql(".dump"), savedDump);
      deliveryState = row.delivery_state;
      console.log(JSON.stringify({ pending: confirmed.pending_count, confirmed: confirmed.confirmed_count,
        mobileHead, alreadyConfirmed: again.already_confirmed, desktopVersions: finalTrip.version_ids.length,
        desktopReceipts: finalTrip.receipts.length, mobileVersions: end.revisionCount, mobileLocalReceipts: end.receiptCount }));
    } else {
      assert.deepEqual(desktopCall("queue"), queue);
    }
    console.log(JSON.stringify({ originalDesktopRevision: revision, editedRevision, entity: queue.entity_id,
      rawLength: patchBytes.length, rawSha256: createHash("sha256").update(patchBytes).digest("hex"),
      savedReceipt, mobilePaidCents: end.totalCents, desktopPaidCents: finalTrip.head_paid_cents,
      fork: finalTrip.fork, forkPaidCents: finalFork.head_paid_cents, queueCount: 1, deliveryState,
      receivedPatchCount: 1 }, null, 2));
  }
  if (values.patch) {
    session.cdp.close();
    adb(serial, ["install", "-r", "-t", upgraded.apk]);
    session = await launchAndAttach(serial, port);
    assert.equal((await phone("inspect()")).syncedDesktopRevisionId, revision);
    const vectors = JSON.parse(readFileSync(new URL("../vendor/contracts/expense-patch-candidate.2/normative-vectors.json", import.meta.url)));
    const patch = structuredClone(vectors.scenarios[0].steps[0].command);
    patch.operation.dataset_id = cmd.operation.dataset_id;
    patch.target = cmd.target;
    patch.expected_revision_id = revision;
    const receive = command => phone(`receiveDesktopCommand(${JSON.stringify(JSON.stringify(command))})`);
    const query = command => receive({ profile: "p1-host-query-1", kind: "receipt.lookup", operation: command.operation });
    const dump = () => sql(".dump");
    // stdin keeps fixture SQL out of shell argument parsing; only this run's fresh app database is writable.
    const fixtureSql = input => adb(serial, ["shell", "-T", "run-as", PACKAGE, "sqlite3", "-bail",
      "files/p1-offline-trip-ledger/store.db"], { input });
    const baseDump = dump();
    const stale = { ...patch, expected_revision_id: local.headRevisionId };
    assert.deepEqual(await receive(stale), { ok: false, error: "baseline_conflict", current_synced_revision_id: revision });
    assert.equal(dump(), baseDump);
    fixtureSql("CREATE TRIGGER fail_fixture_receipt BEFORE INSERT ON received_patches BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END;");
    try {
      await assert.rejects(receive(patch), /fixture_receipt_failure/);
    } finally {
      fixtureSql("DROP TRIGGER fail_fixture_receipt;");
    }
    assert.equal(dump(), baseDump);
    const applied = await receive(patch);
    assert.deepEqual([applied.ok, applied.replayed, applied.receipt.effect], [true, false, "changed"]);
    assert.equal(applied.receipt.intent_sha256, fingerprintPatchCandidate(Buffer.from(JSON.stringify(patch)), "control").sha256);
    await restart();
    const recovered = await phone("inspect()");
    assert.deepEqual([recovered.totalCents, recovered.expenseCount, recovered.revisionCount, recovered.outboxCount],
      [2150, 1, local.revisionCount + 1, 0]);
    assert.deepEqual(recovered.expenses[0], { ...local.expenses[0], amount_cents: 2150 });
    assert.deepEqual([recovered.syncedDesktopRevisionId, recovered.headRevisionId],
      [patch.source_revision_id, applied.receipt.result_revision_id]);
    assert.notEqual(recovered.headRevisionId, local.headRevisionId);
    assert.deepEqual(JSON.parse(sql("SELECT receipt_json FROM received_patches")), applied.receipt);
    assert.equal(sql("SELECT amount_cents FROM expenses"), "2150");
    assert.deepEqual(recovered.revisions.slice(0, -1), local.revisions);
    const committedDump = dump();
    assert.deepEqual((await query(patch)).receipt, applied.receipt);
    assert.deepEqual(await receive(patch), { ...applied, replayed: true });
    assert.deepEqual(await receive({ ...patch, patch: { amount_cents: 2151 } }), { ok: false, error: "intent_conflict" });
    assert.equal((await confirm(replay)).accepted, true);
    assert.equal(dump(), committedDump);

    const next = structuredClone(cmd);
    next.operation.operation_id += "-next";
    next.target.entity_id += "-next";
    next.expected_revision_id = recovered.headRevisionId;
    next.payload.amount_cents = 2800;
    assert.equal((await phone(`submitRawCommand(${JSON.stringify(next)})`)).accepted, true);
    const pendingDump = dump();
    for (const target of [patch.target, next.target]) {
      const blocked = { ...patch, target, operation: { ...patch.operation, operation_id: "blocked-" + target.entity_id },
        expected_revision_id: patch.source_revision_id, source_revision_id: "desk-rev-3" };
      assert.deepEqual(await receive(blocked), { ok: false, error: "local_pending_conflict",
        pending_operation_id: next.operation.operation_id });
      assert.deepEqual(await query(blocked), { ok: true, state: "not_found_at_settled_read", receipt: null });
    }
    assert.deepEqual(await receive(patch), { ...applied, replayed: true });
    await restart();
    assert.equal(dump(), pendingDump);
    assert.equal((await phone("exportOutboxCommands()")).items[0].raw_command_json, JSON.stringify(next));
    const totalBeforeEditFixture = (await phone("inspect()")).totalCents;
    // There is no local patch editor in this slice. Seed EP04 as a pending edit in this disposable DB.
    const edit = structuredClone(patch);
    edit.operation = { ...cmd.operation, operation_id: "op-mobile-local-edit-1" };
    edit.expected_revision_id = patch.source_revision_id;
    edit.source_revision_id = "fixture-local-edit-revision";
    edit.patch.amount_cents = 1999;
    const editRaw = JSON.stringify(edit);
    const editProof = fingerprintPatchCandidate(Buffer.from(editRaw), "control");
    const snapshot = JSON.parse(sql("SELECT snapshot_json FROM revisions ORDER BY seq DESC LIMIT 1"));
    snapshot.expenses.find(row => row.id === edit.target.entity_id).amount_cents = 1999;
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const keyValues = [edit.operation.dataset_id, edit.operation.source_device_id, edit.operation.operation_id].map(literal).join(",");
    fixtureSql(`PRAGMA foreign_keys=ON;
      BEGIN IMMEDIATE;
      UPDATE expenses SET amount_cents=1999 WHERE entity_id=${literal(edit.target.entity_id)};
      INSERT INTO revisions(revision_id,parent_revision_id,snapshot_json)
        SELECT ${literal(edit.source_revision_id)},head_revision_id,${literal(JSON.stringify(snapshot))} FROM branch_head;
      UPDATE branch_head SET head_revision_id=${literal(edit.source_revision_id)};
      INSERT INTO receipts VALUES(${keyValues},${literal(editProof.canonical_json)},'changed',${literal(edit.source_revision_id)});
      INSERT INTO outbox(dataset_id,source_device_id,operation_id,entity_id,expected_revision_id,result_revision_id,
        raw_command_json,canonical_intent_json,intent_sha256,delivery_state)
        VALUES(${keyValues},${literal(edit.target.entity_id)},${literal(edit.expected_revision_id)},${literal(edit.source_revision_id)},
        ${literal(editRaw)},${literal(editProof.canonical_json)},${literal(editProof.sha256)},'verification_pending');
      COMMIT;`);
    const editDump = dump();
    const againstEdit = { ...patch, expected_revision_id: patch.source_revision_id, source_revision_id: "desk-rev-3",
      operation: { ...patch.operation, operation_id: "desktop-versus-local-edit" } };
    assert.deepEqual(await receive(againstEdit), { ok: false, error: "local_pending_conflict", pending_operation_id: edit.operation.operation_id });
    await restart();
    assert.deepEqual(await query(againstEdit), { ok: true, state: "not_found_at_settled_read", receipt: null });
    assert.equal(dump(), editDump);
    const preserved = await phone("inspect()");
    assert.equal(preserved.expenses.find(row => row.id === edit.target.entity_id).amount_cents, 1999);
    assert.equal(preserved.headRevisionId, edit.source_revision_id);
    assert.equal(preserved.syncedDesktopRevisionId, patch.source_revision_id);
    assert.equal(sql("SELECT hex(raw_command_json) FROM outbox ORDER BY seq DESC LIMIT 1"), Buffer.from(editRaw).toString("hex").toUpperCase());
    console.log(JSON.stringify({ upgradedFrom: "5d34b2d", coldPaidCents: recovered.totalCents, receipt: applied.receipt,
      mappedFrom: revision, pendingOperation: next.operation.operation_id, pendingTotalCents: totalBeforeEditFixture,
      localEditCents: 1999, localEditOperation: edit.operation.operation_id, localEditRawSha256: createHash("sha256").update(editRaw).digest("hex"),
      injectedReceiptFailureRolledBack: true,
      replaySameReceipt: true, conflictDumpIdentical: true }, null, 2));
  }

} finally {
  session?.cdp.close();
  if (installed) {
    setAirplaneMode(serial, airplane === "1");
    adb(serial, ["forward", "--remove", `tcp:${port}`], {allowFailure: true});
    adb(serial, ["uninstall", PACKAGE]);
  }
  if (upgraded) rmSync(upgraded.tempRoot, { recursive: true, force: true });
  if (built) rmSync(built.tempRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
