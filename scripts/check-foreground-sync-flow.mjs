// Normal-page acceptance inside the isolated paired Windows / Android round-trip harness.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { adb, forceStopAndReopen, launchAndAttach, PACKAGE, setAirplaneMode, setInputValue,
  waitForCondition } from "./check-p1-offline-entry-android.mjs";

export async function checkForegroundSync({ serial, port, getSession, setSession, ctx, initial, initialFork, inspect,
  handoff, control, deviceId, bind, route, conflict, requests, armFault }) {
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
