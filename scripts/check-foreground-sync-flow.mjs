// Normal-page acceptance inside the isolated paired Windows / Android round-trip harness.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { adb, forceStopAndReopen, launchAndAttach, PACKAGE, setAirplaneMode, setInputValue,
  waitForCondition } from "./check-p1-offline-entry-android.mjs";

export async function checkForegroundSync({ serial, port, getSession, setSession, ctx, initial, initialFork, inspect,
  handoff, control, deviceId, bind, route, conflict, requests, armFault, two, wireTrace }) {
  const cdp = () => getSession().cdp;
  const phone = () => cdp().evaluate("window.__travelflowOfflineEntry.inspect()");
  const ui = () => cdp().evaluate("window.__travelflowOfflineEntry.getUiState()");
  const sql = query => adb(serial, ["shell", `run-as ${PACKAGE} sqlite3 -readonly files/p1-offline-trip-ledger/store.db '${query}'`]).stdout.trim();
  const edit = (revision, expenseId, amount) => handoff("edit-expense", "--database", ctx.database, "--version-id", revision,
    "--expense-id", expenseId, "--amount", amount).version_id;
  const status = () => handoff("outbound-status", "--database", ctx.database);
  const branchFork = () => inspect(ctx.fork_branch_id);
  const statusIncludes = text => waitForCondition(cdp(),
    `document.querySelector('#trip-sync-status').textContent.includes(${JSON.stringify(text)})`, text, 60000);
  const paths = () => requests().map(p => p.slice("/exchange/".length));
  async function airplane(enabled) {
    setAirplaneMode(serial, enabled);
    for (let i = 0; i < 100; i++) {
      const r = adb(serial, ["shell", "ip", "route", "get", bind], { allowFailure: true });
      if (enabled ? r.status !== 0 && /unreachable/i.test(r.stdout + r.stderr)
        : r.status === 0 && r.stdout.includes(" dev " + route.match(/ dev (\S+)/)[1] + " ")) return;
      await sleep(250);
    }
    throw Error("Connectivity did not settle");
  }
  async function save(title, yuan) {
    const seq = (await ui()).saveAttemptSeq;
    await cdp().tap("trip-open-entry-btn");
    await setInputValue(cdp(), "trip-entry-title", title);
    await setInputValue(cdp(), "trip-entry-amount-yuan", yuan);
    await setInputValue(cdp(), "trip-entry-category", "transport");
    await cdp().tap("trip-entry-save-btn");
    await waitForCondition(cdp(), `(() => { const s = window.__travelflowOfflineEntry.getUiState();
      return s.saveAttemptSeq > ${seq} && s.lastAttempt.outcome === 'saved' && s.ledgerViewVisible; })()`, "saved in ledger");
  }
  async function repeatWakes() {
    await cdp().evaluate("for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('online'))");
    await sleep(6500); // Cross the normal foreground poll interval as well.
  }
  assert.ok(control("bind-exchange", "--device-id", deviceId, "--dataset-id", ctx.dataset_id,
    "--source-device-id", ctx.authorized_devices[0], "--travel-id", ctx.travel_id, "--branch-id", ctx.branch_id).ok);
  if (two) {
    await checkTwoCreates({ mode: two, cdp, phone, ui, sql, edit, status, paths, airplane, save, repeatWakes, statusIncludes,
      ctx, initial, initialFork, inspect, branchFork, getSession, setSession, serial, port, wireTrace });
    return;
  }
  await airplane(true);
  await save("机场地铁票", "17.23");
  const offline = await phone();
  const pendingUI = (await ui()).syncStatusText;
  assert.match(pendingUI, /已保存在本机.*待同步/);
  assert.deepEqual([offline.totalCents, offline.expenseCount, offline.outboxCount], [1723, 1, 1]);
  const raw = sql("SELECT hex(raw_command_json) FROM outbox");
  const op = offline.expenses[0].operation_id;
  const entity = offline.expenses[0].id;
  const start = paths().length;
  armFault();
  if (conflict) {
    const old = getSession().pid;
    cdp().close();
    adb(serial, ["shell", "am", "force-stop", PACKAGE]);
    await airplane(false);
    setSession(await launchAndAttach(serial, port));
    assert.notEqual(getSession().pid, old);
  } else await airplane(false);
  await statusIncludes("对端已确认");
  const recovered = await phone();
  const createPaths = paths().slice(start).filter(p => p === "expense-create" || p === "receipt-lookup");
  assert.deepEqual(createPaths, ["receipt-lookup", "expense-create", "receipt-lookup"]);
  assert.deepEqual([recovered.totalCents, recovered.expenseCount, recovered.outboxCount, recovered.revisionCount],
    [1723, 1, 0, offline.revisionCount]);
  assert.equal(sql("SELECT hex(raw_command_json) FROM outbox"), raw);
  const desktopCreate = inspect();
  const receipt = desktopCreate.receipts.find(r => r.operation_id === op);
  assert.equal(receipt.intent_sha256, offline.expenses[0].intent_sha256);
  assert.equal(desktopCreate.head_paid_cents, initial.head_paid_cents + 1723);
  assert.equal(desktopCreate.head_revision_id, receipt.result_version_id);
  assert.equal(recovered.syncedDesktopRevisionId, receipt.result_version_id);
  assert.equal(recovered.expenses[0].desktop_revision_id, receipt.result_version_id);

  const desktopEdit = edit(receipt.result_version_id, entity, "21.50");
  await waitForCondition(cdp(), "document.querySelector('#trip-summary').textContent.includes('21.50')", "foreground correction", 60000);
  const corrected = await phone();
  const patchReceipt = JSON.parse(sql("SELECT receipt_json FROM received_patches"));
  assert.deepEqual([corrected.expenseCount, corrected.totalCents, corrected.revisionCount, corrected.outboxCount],
    [1, 2150, offline.revisionCount + 1, 0]);
  assert.equal(corrected.expenses[0].id, entity);
  assert.equal(corrected.headRevisionId, patchReceipt.result_revision_id);
  assert.equal(corrected.syncedDesktopRevisionId, desktopEdit);
  assert.equal(patchReceipt.synced_desktop_revision_id, desktopEdit);
  const confirmed = status();
  assert.deepEqual([confirmed.pending_count, confirmed.confirmed_count, confirmed.all.length], [0, 1, 1]);
  assert.equal(confirmed.confirmed[0].confirmed_mobile_revision_id, corrected.headRevisionId);
  assert.deepEqual(JSON.parse(confirmed.confirmed[0].last_raw_response_json).receipt, patchReceipt);
  const desktopFinal = inspect();
  assert.deepEqual(desktopFinal.version_ids, [...initial.version_ids, receipt.result_version_id, desktopEdit]);
  assert.equal(desktopFinal.head_paid_cents, initial.head_paid_cents + 2150);
  assert.deepEqual(desktopFinal.head_expenses, [...initial.head_expenses,
    { id: entity, title: "机场地铁票", amount_cents: 2150, category: "transport" }]);
  assert.deepEqual(desktopFinal.receipts, [...initial.receipts, receipt]);
  assert.deepEqual(desktopFinal.fork, initial.fork);
  assert.deepEqual(branchFork().head_expenses, initialFork.head_expenses);

  const beforeWakes = sql(".dump");
  await repeatWakes();
  assert.equal(sql(".dump"), beforeWakes);
  assert.deepEqual(inspect(), desktopFinal);
  assert.deepEqual(status(), confirmed);
  assert.equal(paths().filter(p => p === "expense-create").length, 1);
  assert.equal(paths().filter(p => p === "expense-patch/confirm").length, 1);
  console.log(JSON.stringify({ trigger: conflict ? "cold reopen" : "network restored", pendingUI, confirmedUI: (await ui()).syncStatusText,
    createPaths, mobileCents: corrected.totalCents, mobileVersions: corrected.revisionCount, deskCents: desktopFinal.head_paid_cents,
    deskVersions: desktopFinal.version_ids.length, desktopEdit, mobileHead: corrected.headRevisionId, pending: 0, confirmed: 1 }));

  // A second, separately saved row makes local preservation visible even after an explicit cold restart.
  await airplane(true);
  await save("站内车票", "3.00");
  const protectedRows = sql(".dump");
  const protectedState = await phone();
  assert.deepEqual([protectedState.expenseCount, protectedState.totalCents, protectedState.outboxCount], [2, 2450, 1]);
  if (conflict) edit(desktopEdit, entity, "24.00");
  else assert.ok(control("revoke", "--device-id", deviceId).revoked);
  const beforeBlock = inspect();
  const queueBeforeBlock = status();
  await airplane(false);
  const reason = conflict ? "baseline_conflict" : "device_revoked";
  await statusIncludes(reason);
  const blockedUI = (await ui()).syncStatusText;
  assert.match(blockedUI, /待同步.*已暂停自动同步/);
  const stopped = paths();
  await repeatWakes();
  cdp().close();
  setSession(await forceStopAndReopen(serial, port, getSession().pid));
  await statusIncludes(reason);
  await repeatWakes();
  assert.deepEqual(paths(), stopped, "no outbound requests after halt, including after reboot");
  assert.equal(sql(".dump"), protectedRows);
  const reopened = await phone();
  assert.notEqual(reopened.callerPid, protectedState.callerPid);
  assert.deepEqual(reopened, { ...protectedState, callerPid: reopened.callerPid });
  assert.deepEqual(inspect(), beforeBlock);
  assert.deepEqual(status(), queueBeforeBlock);
  console.log(JSON.stringify({ blockedUI, protectedCents: protectedState.totalCents,
    pendingAfterStop: protectedState.outboxCount, requestsAfterStop: paths().length - stopped.length }));
}

async function checkTwoCreates({ mode, cdp, phone, ui, sql, edit, status, paths, airplane, save, repeatWakes,
  statusIncludes, ctx, initial, initialFork, inspect, branchFork, getSession, setSession, serial, port, wireTrace }) {
  const wire = () => sql("SELECT hex(raw_command_json) FROM outbox_wire ORDER BY outbox_seq")
    .split("\n").filter(Boolean).map(hex => Buffer.from(hex, "hex"));
  const localRows = () => sql("SELECT seq,hex(raw_command_json),intent_sha256,result_revision_id FROM outbox ORDER BY seq");
  const stop = () => {
    const oldPid = getSession().pid;
    cdp().close();
    adb(serial, ["shell", "am", "force-stop", PACKAGE]);
    return oldPid;
  };
  const reopen = async oldPid => {
    setSession(await launchAndAttach(serial, port));
    assert.notEqual(getSession().pid, oldPid);
  };

  if (mode === "batch") await airplane(true);
  await save("机场地铁票", "17.23");
  if (mode === "sequential") {
    await statusIncludes("对端已确认");
    const first = await phone();
    assert.equal(first.expenses[0].desktop_revision_id, inspect().head_revision_id);
    assert.deepEqual([first.expenseCount, first.outboxCount], [1, 0]);
    await airplane(true);
  }
  await save("市内公交票", "6.50");
  const local = await phone();
  const immutable = localRows();
  const ops = local.expenses.map(e => e.operation_id);
  const ids = local.expenses.map(e => e.id);
  assert.deepEqual([local.totalCents, local.expenseCount, local.receiptCount, local.revisionCount], [2373, 2, 2, 3]);
  assert.deepEqual(local.expenses.map(e => e.amount_cents), [1723, 650]);
  assert.equal(local.outboxCount, mode === "batch" ? 2 : 1);
  assert.equal(local.expenses[1].expected_revision_id, local.revisions[1].revision_id);
  assert.equal(wire().length, mode === "batch" ? 1 : 2);
  await airplane(false);
  const deadline = Date.now() + 60000;
  while (!wireTrace().some(e => e.path === "dropped" && e.operation === ops[1])) {
    if (Date.now() > deadline) throw Error("Missing post-commit drop for second create: " + JSON.stringify({ trace: wireTrace(), ui: await ui() }));
    await sleep(80);
  }
  const oldPid = stop();
  const committed = inspect();
  const receipts = ops.map(op => committed.receipts.find(row => row.operation_id === op));
  assert.ok(receipts.every(Boolean));
  const deskVersions = receipts.map(row => row.result_version_id);
  assert.deepEqual(committed.version_ids, [...initial.version_ids, ...deskVersions]);
  assert.deepEqual(receipts.map(row => row.entity_id), ids);
  assert.equal(committed.receipts.length, initial.receipts.length + 2);
  assert.deepEqual(committed.head_expenses, [...initial.head_expenses,
    { id: ids[0], title: "机场地铁票", amount_cents: 1723, category: "transport" },
    { id: ids[1], title: "市内公交票", amount_cents: 650, category: "transport" }]);
  assert.equal(committed.head_paid_cents, initial.head_paid_cents + 2373);
  assert.equal(sql("SELECT delivery_state FROM outbox ORDER BY seq"), "confirmed\npending_send");
  const frozen = wire();
  assert.equal(frozen.length, 2);
  const trace = wireTrace();
  const createRecords = trace.filter(record => record.path === "create");
  assert.deepEqual(createRecords.map(r => r.operation), ops);
  for (const [i, bytes] of frozen.entries()) {
    const localCommand = JSON.parse(Buffer.from(immutable.split("\n")[i].split("|")[1], "hex"));
    const command = JSON.parse(bytes);
    assert.deepEqual(command, { ...localCommand, expected_revision_id: i === 0 ? ctx.current_revision_id : deskVersions[0] });
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createRecords[i].sha256);
    assert.equal(fingerprintIntent(bytes).sha256, receipts[i].intent_sha256);
  }
  assert.notEqual(receipts[1].intent_sha256, local.expenses[1].intent_sha256);
  assert.equal(sql("SELECT intent_sha256 FROM outbox_wire ORDER BY outbox_seq"), receipts.map(r => r.intent_sha256).join("\n"));
  await reopen(oldPid);
  await statusIncludes("对端已确认");
  const recovered = await phone();
  assert.deepEqual(recovered.expenses.map(e => e.desktop_revision_id), deskVersions);
  assert.equal(recovered.syncedDesktopRevisionId, deskVersions[1]);
  assert.equal(sql("SELECT desktop_revision_id FROM revisions ORDER BY seq"), [ctx.current_revision_id, ...deskVersions].join("\n"));
  assert.deepEqual([recovered.outboxCount, recovered.receiptCount, recovered.revisionCount], [0, 2, 3]);
  assert.deepEqual(recovered.revisions.map(r => r.snapshot_sha256), local.revisions.map(r => r.snapshot_sha256));
  assert.equal(localRows(), immutable);
  assert.deepEqual(wire(), frozen);
  const recoveredTrace = wireTrace();
  assert.deepEqual(recoveredTrace.slice(trace.length).map(e => [e.path, e.operation]), [["lookup", ops[1]]]);
  assert.deepEqual(inspect(), committed);
  assert.deepEqual(committed.fork, initial.fork);
  const fork = branchFork();
  for (const key of ["version_ids", "head_revision_id", "head_expenses", "head_paid_cents"]) {
    assert.deepEqual(fork[key], initialFork[key]);
  }
  const snapshot = sql(".dump");
  await repeatWakes();
  assert.equal(sql(".dump"), snapshot);
  assert.deepEqual(wireTrace(), recoveredTrace);
  assert.deepEqual(inspect(), committed);
  console.log(JSON.stringify({ mode, amounts: [1723, 650], mobileTotal: recovered.totalCents, deskTotal: committed.head_paid_cents,
    desktopHeads: deskVersions, localHeads: local.revisions.map(r => r.revision_id), desktopVersions: committed.version_ids.length,
    mobileReceipts: recovered.receiptCount, deskCreateReceipts: receipts.length, pendingAfterRecovery: recovered.outboxCount,
    sha256: createRecords.map(r => r.sha256), wireIntentDigests: receipts.map(r => r.intent_sha256), operations: ops,
    afterSecondDrop: recoveredTrace.slice(trace.length), pidBeforeDrop: oldPid, pidAfterRecovery: getSession().pid }));
  if (mode !== "batch") return;

  await airplane(true);
  await save("轮渡票", "3.00");
  const third = (await phone()).expenses[2];
  const thirdWire = wire()[2];
  assert.equal(JSON.parse(thirdWire).expected_revision_id, deskVersions[1]);
  const beforeConflict = sql(".dump");
  const protectedState = await phone();
  const concurrentVersion = edit(deskVersions[1], ids[0], "21.50");
  const concurrent = inspect();
  assert.equal(concurrent.head_revision_id, concurrentVersion);
  assert.equal(concurrent.head_paid_cents, committed.head_paid_cents - 1723 + 2150);
  assert.deepEqual(concurrent.version_ids, [...committed.version_ids, concurrentVersion]);
  const concurrentQueue = status();
  await airplane(false);
  await statusIncludes("baseline_conflict");
  const halted = paths();
  const conflictWire = wireTrace().filter(row => row.path === "create" && row.operation === third.operation_id);
  assert.deepEqual(conflictWire.map(r => r.sha256), [createHash("sha256").update(thirdWire).digest("hex")]);
  await repeatWakes();
  await reopen(stop());
  await statusIncludes("baseline_conflict");
  await repeatWakes();
  assert.deepEqual(paths(), halted);
  assert.equal(sql(".dump"), beforeConflict);
  const afterStop = await phone();
  assert.deepEqual(afterStop, { ...protectedState, callerPid: afterStop.callerPid });
  assert.equal(afterStop.outboxCount, 1);
  assert.deepEqual(inspect(), concurrent);
  assert.deepEqual(status(), concurrentQueue);
  console.log(JSON.stringify({ mode, conflictBase: deskVersions[1], concurrentVersion, blockedOperation: third.operation_id,
    protectedTotal: afterStop.totalCents, pending: afterStop.outboxCount, requestsAfterStop: paths().length - halted.length }));
}
