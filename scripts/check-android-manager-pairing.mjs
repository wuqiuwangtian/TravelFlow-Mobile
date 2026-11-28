// API 35 uses only the pairing JSON shown by the native Windows manager and Android's normal entry screens.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { checkManagerRepair } from "./check-manager-repair.mjs";
import { adb, assertIsolatedAvd, buildApk, forceStopAndReopen, getAirplaneMode, launchAndAttach,
  PACKAGE, setAirplaneMode, setInputValue, waitForCondition } from "./check-p1-offline-entry-android.mjs";

const { values } = parseArgs({ options: { serial: { type: "string" }, "desktop-repo": { type: "string" },
  "desktop-python": { type: "string" }, bind: { type: "string" }, apk: { type: "string" }, repair: { type: "boolean" } } });
const { serial, bind } = values;
assert.equal(serial, "emulator-5580");
assertIsolatedAvd(serial);
const cdpPort = 19245;
assert.ok(!adb(serial, ["forward", "--list"]).stdout.split(/\s+/).includes("tcp:" + cdpPort));
assert.ok(isIPv4(bind));
const ref = "87c719271251beee6fd2c462a06062ca9267d4ce";
const python = path.resolve(values["desktop-python"]);
const capture = (exe, args, options) => execFileSync(exe, args, { encoding: "utf8", timeout: 60000, ...options }).trim();
const native = file => capture("wslpath", ["-w", file]);
const winHost = JSON.parse(capture(python, ["-X", "utf8", "-c",
  "import sys,tempfile,json;print(json.dumps([sys.platform,tempfile.gettempdir()]))"]));
assert.equal(winHost[0], "win32");
const work = mkdtempSync(path.join(capture("wslpath", ["-u", winHost[1]]), "travelflow-manager-"));
const desktop = path.join(work, "desktop-src");
const managerState = path.join(work, "manager-state");
const airplaneBefore = getAirplaneMode(serial);
let built, session, installed, manager, replies, exited, driverFailed;
async function command(action, fields = {}) {
  manager.stdin.write(JSON.stringify({ action, ...fields }) + "\n");
  const response = await replies.next();
  if (response.done) { driverFailed = true; throw Error("Windows browser driver exited during " + action); }
  const reply = JSON.parse(response.value);
  if (!reply.ok) { driverFailed = true; throw Error(action + ": " + reply.error); }
  return reply;
}
const cdp = () => session.cdp;
const ledger = () => cdp().evaluate("window.__travelflowOfflineEntry.inspect()");
const ui = () => cdp().evaluate("window.__travelflowOfflineEntry.getUiState()");
const text = id => cdp().evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
const waitText = (id, contains) => waitForCondition(cdp(),
  `document.getElementById(${JSON.stringify(id)}).textContent.includes(${JSON.stringify(contains)})`, id + " / " + contains, 60000);
const sql = query => adb(serial, ["shell", `run-as ${PACKAGE} sqlite3 -readonly files/p1-offline-trip-ledger/store.db '${query}'`]).stdout.trim();
// Never put credential blobs or complete ledger dumps in assertion output.
const hash = data => createHash("sha256").update(data).digest("hex");
const databaseHash = () => hash(sql(".dump"));
function businessHash() {
  // Revocation persists the stop reason inside the encrypted pairing credential.
  const rows = sql(".dump").split("\n").filter(row => !/^INSERT INTO "?manager_binding"? /i.test(row));
  return hash(rows.join("\n") + sql("SELECT hex(trip_json),source_device_id FROM manager_binding"));
}
const cold = async () => {
  cdp().close();
  session = await forceStopAndReopen(serial, cdpPort, session.pid);
};
async function airplane(enabled) {
  setAirplaneMode(serial, enabled);
  for (let i = 0; i < 100; i++) {
    const route = adb(serial, ["shell", "ip", "route", "get", bind], { allowFailure: true });
    if (enabled ? route.status !== 0 && /unreachable/i.test(route.stdout + route.stderr)
      : route.status === 0 && / dev \S+ /.test(route.stdout)) return route.stdout.trim();
    await sleep(250);
  }
  throw Error("Android LAN route did not settle");
}
async function save(title, yuan) {
  const seq = (await ui()).saveAttemptSeq;
  await cdp().tap("trip-open-entry-btn");
  await setInputValue(cdp(), "trip-entry-title", title);
  await setInputValue(cdp(), "trip-entry-amount-yuan", yuan);
  await cdp().tap("trip-entry-save-btn");
  await waitForCondition(cdp(), `(() => { const s = window.__travelflowOfflineEntry.getUiState();
    return s.saveAttemptSeq > ${seq} && s.lastAttempt.outcome === "saved" && s.ledgerViewVisible; })()`, "normal expense save");
}
async function rejectedDifferentTrip(display) {
  const before = databaseHash();
  const changed = structuredClone(display);
  changed.trip.travel_id = "other-manager-trip";
  await setInputValue(cdp(), "pair-display", JSON.stringify(changed));
  await cdp().tap("pair-preview");
  await waitText("pair-status", "trip_scope_conflict");
  assert.ok(await cdp().evaluate("document.getElementById('pair-begin').disabled"));
  const status = await text("pair-status");
  assert.match(status, /不同|另一|其他|不匹配|冲突|mismatch|different|conflict|switch/);
  assert.equal(databaseHash(), before);
  return status;
}

try {
  mkdirSync(desktop);
  const archive = path.join(work, "desktop.tar");
  capture("git", ["-C", values["desktop-repo"], "archive", "-o", archive, ref, "desktop", "backend", "frontend"]);
  capture("tar", ["-xf", archive, "-C", desktop]);
  if (!values.apk) built = buildApk();
  const apk = values.apk ? path.resolve(values.apk) : built.apk;
  const seed = JSON.parse(capture("python3", ["-c", [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as apk:",
    "    seed = 'assets/public/offline-trip-seed.json'",
    "    print(apk.read(seed).decode('utf-8') if seed in apk.namelist() else 'null')",
  ].join("\n"), apk]));
  assert.equal(seed, null, "Runtime APK must not contain a preconfigured travel scope");
  const apkSha = hash(readFileSync(apk));
  adb(serial, ["install", "-t", apk]);
  installed = true;
  await airplane(false);
  session = await launchAndAttach(serial, cdpPort);
  assert.equal((await ledger()).initialized, false);
  assert.ok(await cdp().evaluate("document.getElementById('trip-open-entry-btn').disabled"));

  const environment = { ...process.env };
  const dropMarker = path.join(work, "drop-claim-once");
  if (values.repair) {
    const hooks = path.join(work, "observer");
    mkdirSync(hooks);
    copyFileSync("scripts/p1-drop-claim-fixture.py", path.join(hooks, "sitecustomize.py"));
    environment.WSLENV = [environment.WSLENV, "PYTHONPATH/w", "TRAVELFLOW_TEST_CLAIM_DROP/w"].filter(Boolean).join(":");
    environment.PYTHONPATH = native(hooks);
    environment.TRAVELFLOW_TEST_CLAIM_DROP = native(dropMarker);
  }
  manager = spawn(python, ["-X", "utf8", "-u", native(path.resolve("scripts/p1-manager-browser.py")), native(managerState)],
    { cwd: desktop, env: environment, stdio: ["pipe", "pipe", "inherit"] });
  exited = once(manager, "exit");
  replies = createInterface({ input: manager.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  await command("start", { bind, port: 0 });
  const { display: pairing } = await command("pairing");
  const display = typeof pairing === "string" ? JSON.parse(pairing) : pairing;
  assert.equal(display.lan_host, bind);
  const trip = display.trip;
  assert.ok([trip.title, trip.dataset_id, trip.travel_id, trip.branch_id, trip.current_revision_id].every(Boolean));
  const initial = await command("status");
  assert.ok(initial.running);
  assert.equal(initial.head, trip.current_revision_id);
  await setInputValue(cdp(), "pair-display", JSON.stringify(display));
  await cdp().tap("pair-preview");
  await waitForCondition(cdp(), "!document.getElementById('pair-begin').disabled", "scope preview valid");
  const review = await text("pair-trip-review");
  for (const value of [trip.title, trip.dataset_id, trip.travel_id, trip.branch_id, trip.current_revision_id]) assert.ok(review.includes(value));
  assert.equal((await ledger()).initialized, false);
  await cdp().tap("pair-begin");
  await waitForCondition(cdp(), "/[0-9]{6}/.test(document.getElementById('pair-status').textContent)", "Android pairing SAS");
  const sas = (await text("pair-status")).match(/[0-9]{6}/)[0];
  const pending = await command("pending");
  assert.equal(sas, pending.sas);
  await command("approve", { sas });
  await cdp().tap("pair-confirm");
  await waitForCondition(cdp(), "!document.getElementById('trip-open-entry-btn').disabled", "activate reviewed ledger");
  const opened = await ledger();
  assert.deepEqual([opened.datasetId, opened.travelId, opened.branchId, opened.revisions[0].revision_id],
    [trip.dataset_id, trip.travel_id, trip.branch_id, trip.current_revision_id]);
  const source = (await text("pair-source-id")).trim();
  assert.ok(source.length > 0);
  assert.notEqual(source, pending.deviceId);
  assert.equal(opened.expenseCount, 0);

  await airplane(true);
  await save("机场地铁票", "17.23");
  await save("市内公交票", "6.50");
  const queued = await ledger();
  assert.deepEqual([queued.expenseCount, queued.totalCents, queued.outboxCount], [2, 2373, 2]);
  assert.deepEqual(queued.outbox.map(o => o.source_device_id), [source, source]);
  for (const item of queued.outbox) {
    assert.equal(item.command.target.travel_id, trip.travel_id);
    assert.equal(item.command.target.branch_id, trip.branch_id);
    assert.equal(item.command.operation.dataset_id, trip.dataset_id);
  }
  const route = await airplane(false);
  await waitText("trip-sync-status", "等待桌面授权");
  const denied = await command("status");
  assert.equal(denied.paidCents, initial.paidCents);
  assert.equal(denied.grants.length, 0);
  assert.equal((await ledger()).outboxCount, 2);
  await command("grant", { source });
  await waitText("trip-sync-status", "对端已确认");
  const paid = await ledger();
  let after = await command("status");
  for (let i = 0; i < 20 && after.head !== paid.syncedDesktopRevisionId; i++) {
    await sleep(400);
    after = await command("status");
  }
  assert.deepEqual([paid.totalCents, paid.expenseCount, paid.receiptCount, paid.revisionCount, paid.outboxCount], [2373, 2, 2, 3, 0]);
  assert.deepEqual([after.paidCents, after.expenseCount], [initial.paidCents + 2373, initial.expenseCount + 2]);
  assert.equal(after.head, paid.syncedDesktopRevisionId);
  assert.equal(after.head, paid.expenses[1].desktop_revision_id);
  const confirmed = paid.expenses.map(e => e.desktop_revision_id);
  assert.ok(confirmed.every(Boolean) && new Set(confirmed).size === 2);
  assert.ok(after.grants.some(g => g.device_id === pending.deviceId && g.source_device_id === source));
  console.log(JSON.stringify({ desktop: ref, apkSha, route, host: bind, port: display.lan_port, businessSource: source,
    pairedDevice: pending.deviceId, paidCents: paid.totalCents, desktopPaidCents: after.paidCents,
    confirmedVersions: confirmed, pending: paid.outboxCount }));

  if (values.repair) {
    await checkManagerRepair({ serial, command, cdp, ledger, text, waitText, cold, airplane, save, source,
      deviceId: pending.deviceId, armDrop: () => writeFileSync(dropMarker, "armed", { flag: "wx" }) });
  } else await checkManagerRestart();

  async function checkManagerRestart() {
    const restarted = await command("restart");
    assert.deepEqual([restarted.host, restarted.port, restarted.pin, restarted.head], [bind, display.lan_port, display.cert_sha256, after.head]);
    assert.equal(restarted.paidCents, after.paidCents);
    assert.deepEqual(restarted.grants, after.grants);
    await cold();
    assert.equal((await text("pair-source-id")).trim(), source);
    assert.equal((await ledger()).syncedDesktopRevisionId, after.head);
    await save("轮渡票", "3.00");
    await waitText("trip-sync-status", "对端已确认");
    const reconnected = await ledger();
    assert.deepEqual([reconnected.totalCents, reconnected.expenseCount, reconnected.receiptCount, reconnected.outboxCount],
      [2673, 3, 3, 0]);
    assert.deepEqual(reconnected.expenses.slice(0, 2).map(e => e.desktop_revision_id), confirmed);
    let postRestart = await command("status");
    for (let i = 0; i < 20 && postRestart.head !== reconnected.syncedDesktopRevisionId; i++) {
      await sleep(400);
      postRestart = await command("status");
    }
    assert.equal(postRestart.head, reconnected.expenses[2].desktop_revision_id);
    assert.deepEqual([postRestart.paidCents, postRestart.expenseCount], [after.paidCents + 300, after.expenseCount + 1]);

    const fresh = (await command("pairing")).display;
    const active = typeof fresh === "string" ? JSON.parse(fresh) : fresh;
    const mismatchConfirmed = await rejectedDifferentTrip(active);
    await airplane(true);
    await save("行李寄存", "1.00");
    const mismatchPending = await rejectedDifferentTrip(active);
    const beforeRevoke = businessHash();
    await command("revoke");
    await airplane(false);
    await waitText("trip-sync-status", "device_revoked");
    await cold();
    await waitText("trip-sync-status", "device_revoked");
    await cdp().evaluate("for (let i=0;i<5;i++) window.dispatchEvent(new Event('online'))");
    await sleep(6500);
    assert.equal(businessHash(), beforeRevoke);
    const protectedLedger = await ledger();
    assert.deepEqual([protectedLedger.totalCents, protectedLedger.outboxCount], [2773, 1]);
    const revoked = await command("status");
    assert.deepEqual([revoked.head, revoked.paidCents, revoked.expenseCount], [postRestart.head, postRestart.paidCents, postRestart.expenseCount]);
    assert.ok(revoked.devices.some(d => d.device_id === pending.deviceId && d.status === "revoked"));
    console.log(JSON.stringify({ restartEndpoint: [restarted.host, restarted.port], savedPinMatched: true,
      localAfterRevoke: protectedLedger.totalCents, pendingAfterRevoke: protectedLedger.outboxCount,
      mismatchConfirmed, mismatchPending, receiptsBeforeRevoke: reconnected.receiptCount, postRestartConfirmed: postRestart.head, desktopHead: revoked.head }));
  }
} finally {
  if (manager && manager.exitCode === null && manager.signalCode === null) {
    try { if (!driverFailed) await command("close"); } finally {
      manager.stdin.end();
      await exited;
    }
  }
  session?.cdp.close();
  if (installed) {
    adb(serial, ["forward", "--remove", "tcp:" + cdpPort], { allowFailure: true });
    setAirplaneMode(serial, airplaneBefore === "1");
    adb(serial, ["uninstall", PACKAGE]);
  }
  if (built) rmSync(built.tempRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
