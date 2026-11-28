// Only called with a fresh isolated debug install and Windows manager; never return a credential to the runner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { adb, PACKAGE, setInputValue, waitForCondition } from "./check-p1-offline-entry-android.mjs";

export async function checkManagerRepair({ serial, command, cdp, ledger, text, waitText, cold, airplane,
  save, source, deviceId, armDrop }) {
  function db(statement) {
    const quoted = "'" + statement.replaceAll("'", "'\"'\"'") + "'";
    return adb(serial, ["shell", `run-as ${PACKAGE} sqlite3 files/p1-offline-trip-ledger/store.db ${quoted}`]).stdout.trim();
  }
  const snapshot = () => createHash("sha256").update(db(
    "SELECT operation_id,hex(raw_command_json),intent_sha256,result_revision_id FROM outbox ORDER BY seq;" +
    "SELECT outbox_seq,hex(raw_command_json),intent_sha256 FROM outbox_wire ORDER BY outbox_seq;" +
    "SELECT revision_id,hex(snapshot_json) FROM revisions ORDER BY seq;"
  )).digest("hex");
  const attach = "ATTACH DATABASE 'files/repair-credentials-fixture.db' AS fixture;";
  // Copy only opaque Keystore-encrypted blobs within this installation's sandbox. No SELECT of blob leaves SQLite.
  db(attach + "CREATE TABLE fixture.copies(name TEXT PRIMARY KEY, cipher BLOB NOT NULL);" +
    "INSERT INTO fixture.copies SELECT 'before',credential FROM manager_binding;");
  const access = method => cdp().evaluate(`(async () => {
    const api = (await import('./capacitor-core.js')).Capacitor.Plugins.DesktopPairing;
    try { await api[${JSON.stringify(method)}](); return 'ok'; } catch (e) { return e.code || 'unexpected_error'; }
  })()`);
  async function prepare() {
    const { display } = await command("pairing", { fresh: true });
    await setInputValue(cdp(), "pair-display", JSON.stringify(display));
    await cdp().tap("pair-preview");
    await waitForCondition(cdp(), "!document.getElementById('pair-begin').disabled", "reviewed re-pair scope");
    await cdp().tap("pair-begin");
    await waitText("pair-status", "请与桌面核对");
    const sas = (await text("pair-status")).match(/[0-9]{6}/)[0];
    const pending = await command("pending", { sas });
    assert.equal(pending.deviceId, deviceId);
    assert.equal(pending.sas, sas);
    await command("approve", { sas });
  }
  const exactDevice = (state, status) => assert.deepEqual(state.devices, [{ device_id: deviceId, status }]);
  async function waitGrantCount(count) {
    for (let i = 0; i < 30; i++) {
      const state = await command("status");
      if (state.grants.length === count) { exactDevice(state, "active"); return state; }
      await sleep(350);
    }
    throw Error("Manager did not show the expected count of active grants");
  }
  await prepare();
  assert.equal(await access("readTrip"), "ok");
  assert.equal(await access("pullPatch"), "ok");
  await cdp().tap("pair-cancel");
  await waitText("pair-status", "已取消");
  await cold();
  assert.equal(await access("pullPatch"), "ok");
  await waitGrantCount(1);

  // Drop a successful, one-shot claim. After a cold retry the manager reports the token was delivered.
  await prepare();
  armDrop();
  await cdp().tap("pair-confirm");
  await waitText("pair-status", "claim_unconfirmed");
  await cold();
  await waitText("pair-status", "待核实");
  await cdp().tap("pair-confirm");
  await waitText("pair-status", "token_already_delivered");
  assert.equal(await access("readTrip"), "HTTP_401_unauthorized");
  await waitGrantCount(0);
  await airplane(true);
  await save("重配期间交通费", "1.00");
  const protectedLedger = await ledger();
  const pendingOp = protectedLedger.outbox[0];
  assert.equal(protectedLedger.outboxCount, 1);
  assert.equal(pendingOp.source_device_id, source);
  const immutable = snapshot();
  await cdp().tap("pair-cancel");
  await waitText("pair-status", "新配对资料");
  await airplane(false);

  // Failure at the original SQLite binding write, after the newly claimed token is safely staged.
  await prepare();
  db("CREATE TRIGGER fixture_block_binding BEFORE INSERT ON manager_binding BEGIN SELECT RAISE(ABORT,'fixture_disk_failure'); END;");
  await cdp().tap("pair-confirm");
  await waitForCondition(cdp(), "document.getElementById('pair-status').textContent.includes('(') && !document.getElementById('pair-confirm').disabled",
    "retryable binding write failure");
  await cold();
  await waitText("pair-status", "新凭据已领取");
  assert.equal(await access("readTrip"), "HTTP_401_unauthorized");
  assert.equal(snapshot(), immutable);
  db("DROP TRIGGER fixture_block_binding;");
  await cdp().tap("pair-confirm");
  await waitText("pair-status", "配对已完成");
  await cold();
  assert.equal((await text("pair-source-id")).trim(), source);
  assert.equal(await access("readTrip"), "ok");
  assert.equal(await access("pullPatch"), "HTTP_403_exchange_not_authorized");
  const ungranted = await waitGrantCount(0);
  assert.equal(snapshot(), immutable);
  assert.equal((await ledger()).outbox[0].operation_id, pendingOp.operation_id);
  await command("grant", { source, reauthorize: true });
  await waitText("trip-sync-status", "对端已确认");
  const final = await ledger();
  assert.deepEqual([final.totalCents, final.expenseCount, final.outboxCount], [protectedLedger.totalCents, protectedLedger.expenseCount, 0]);
  assert.equal(snapshot(), immutable);
  assert.equal(await access("pullPatch"), "ok");
  let granted;
  for (let i = 0; i < 30; i++) {
    granted = await command("status");
    if (granted.head === final.syncedDesktopRevisionId) break;
    await sleep(350);
  }
  exactDevice(granted, "active");
  assert.equal(granted.head, final.syncedDesktopRevisionId);
  assert.equal(granted.paidCents, ungranted.paidCents + 100);
  assert.equal(granted.expenseCount, ungranted.expenseCount + 1);

  await command("revoke");
  await waitText("trip-sync-status", "device_revoked");
  assert.equal(await access("readTrip"), "HTTP_403_device_revoked");
  assert.equal(await access("pullPatch"), "HTTP_403_device_revoked");
  // Auto sync is now durably halted. Replay the original receiver's own encrypted fixture once, then restore.
  db(attach + "INSERT INTO fixture.copies SELECT 'after',credential FROM manager_binding;" +
    "UPDATE manager_binding SET credential=(SELECT cipher FROM fixture.copies WHERE name='before');");
  try {
    assert.equal(await access("readTrip"), "HTTP_403_device_revoked");
    assert.equal(await access("pullPatch"), "HTTP_403_device_revoked");
  } finally {
    db(attach + "UPDATE manager_binding SET credential=(SELECT cipher FROM fixture.copies WHERE name='after');" +
      "DELETE FROM fixture.copies;");
  }
  const revoked = await command("status");
  exactDevice(revoked, "revoked");
  assert.equal(revoked.grants.length, 0);
  assert.equal(snapshot(), immutable);
  console.log(JSON.stringify({ repair: true, deviceId, source, deviceRows: revoked.devices.length,
    canceledBeforeClaim: "original credential and grant active", priorCredentialAfterRotation: "401 unauthorized",
    lostClaimColdRetry: "409 token_already_delivered", stagedClaimColdResume: true, newGrantRequired: true,
    revokedOriginalAndReplacement: "403 device_revoked", mobileCents: final.totalCents,
    pending: final.outboxCount, desktopCents: revoked.paidCents, confirmedVersion: granted.head }));
}
