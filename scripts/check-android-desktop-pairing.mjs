// Pair an isolated API 35 AVD to the foreground desktop service via the displayed IPv4 address.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { isIPv4 } from "node:net";
import { networkInterfaces, release, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { adb, assertIsolatedAvd, buildApk, forceStopAndReopen, getAirplaneMode, launchAndAttach,
  PACKAGE, setAirplaneMode, setInputValue, waitForCondition } from "./check-p1-offline-entry-android.mjs";

const { values } = parseArgs({ options: { serial: { type: "string" }, "desktop-repo": { type: "string" },
  "desktop-python": { type: "string" }, bind: { type: "string" }, exchange: { type: "boolean" }, roundtrip: { type: "boolean" }, windows: { type: "boolean" } } });
const serial = values.serial, port = 19242;
assert.equal(serial, "emulator-5580");
assertIsolatedAvd(serial);
assert.ok(!adb(serial, ["forward", "--list"]).stdout.split(/\s+/).includes("tcp:" + port));
const bind = values.bind;
const windows = values.windows;
assert.ok(!windows || values.roundtrip, "--windows requires --roundtrip");
assert.ok(isIPv4(bind), "Provide the IPv4 address of the desktop adapter");
const python = path.resolve(values["desktop-python"]);
const capture = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 20000 }).trim();
const ps = script => capture("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script]);
const nativePath = p => windows ? capture("wslpath", ["-w", p]) : p;
let winHost;
if (windows) {
  winHost = JSON.parse(capture(python, ["-X", "utf8", "-c", "import json,platform,sys,tempfile;print(json.dumps(dict(os=sys.platform,version=platform.python_version(),temp=tempfile.gettempdir())))"]));
  assert.equal(winHost.os, "win32");
  winHost.adapter = ps(`(Get-NetIPAddress -AddressFamily IPv4 -IPAddress '${bind}' -ErrorAction Stop).InterfaceAlias`);
  assert.ok(winHost.adapter);
  winHost.wslRoute = capture("ip", ["-4", "route", "get", bind]).split("\n")[0];
} else {
  assert.ok(Object.values(networkInterfaces()).flat().some(i => !i.internal && i.address === bind),
    "Provide an IPv4 address of this desktop host with --bind");
}
const exchange = values.exchange || values.roundtrip;
const ref = windows ? "fcd696d055641193ab63d2164512ab2ad759a5fd" : values.roundtrip ? "fbb4dfc86aef7bcc71446cfd8a3b86d6d67b2f94" : values.exchange ? "34c7808f45806d197158a43f4015609d292d354b" : "768043340f3bb681bd1904cc2b873e7632070982";
const temp = windows ? capture("wslpath", ["-u", winHost.temp]) : tmpdir();
const work = mkdtempSync(path.join(temp, "travel-pair-"));
const pyFlags = ["-X", "utf8"];
const desktop = path.join(work, "desktop-src");
const state = nativePath(path.join(work, "private"));
const args = [...pyFlags, "-m", "desktop.lan_pairing"];
const control = (action, ...params) => JSON.parse(execFileSync(python,
  [...args, action, "--state-dir", state, ...params], { cwd: desktop, timeout: 10000, encoding: "utf8" }));
const airplane = getAirplaneMode(serial);
let built, installed, server, exited, session;
try {
  mkdirSync(desktop);
  const archive = path.join(work, "desktop.tar");
  execFileSync("git", ["-C", values["desktop-repo"], "archive", "-o", archive, ref, "desktop", ...(exchange ? ["backend"] : [])]);
  execFileSync("tar", ["-xf", archive, "-C", desktop]);
  const handoff = (...params) => JSON.parse(execFileSync(python, [...pyFlags, "backend/scripts/exchange_trip_handoff.py", ...params],
    { cwd: desktop, encoding: "utf8", timeout: 60000 }));
  const contextFile = path.join(work, "trip-context.json");
  const ctx = exchange ? handoff("init-trip", "--work-dir", nativePath(path.join(work, "trip")), "--context-out", nativePath(contextFile)) : null;
  const inspect = (branch = ctx.branch_id) => handoff("inspect-trip", "--database", ctx.database, "--branch-id", branch,
    "--fork-branch-id", ctx.fork_branch_id);
  const initial = ctx && inspect();
  const initialFork = ctx && inspect(ctx.fork_branch_id);
  built = buildApk(ctx ? contextFile : undefined);
  adb(serial, ["install", "-t", built.apk]);
  installed = true;
  setAirplaneMode(serial, false);
  session = await launchAndAttach(serial, port);
  async function startDesktop(listenPort, openPairing) {
    server = spawn(python, [...args, "serve", "--state-dir", state, "--bind", bind, "--port", String(listenPort), ...(openPairing ? ["--open-pairing"] : []), ...(ctx ? ["--trip-db", ctx.database] : [])],
      { cwd: desktop, stdio: ["ignore", "pipe", "inherit"] });
    exited = once(server, "exit");
    const lines = createInterface({ input: server.stdout });
    const [line] = await Promise.race([once(lines, "line"), exited.then(() => { throw Error("Desktop startup failed"); })]);
    lines.close();
    return JSON.parse(line);
  }
  const info = await startDesktop(0, true);
  assert.equal(info.lan_host, bind);
  const route = adb(serial, ["shell", "ip", "route", "get", bind]).stdout.trim();
  async function tap(id, expected) {
    await session.cdp.tap(id);
    for (let i = 0; i < 100; i++) {
      const ready = await session.cdp.evaluate("!document.querySelector('#pair-read').disabled");
      if (ready) {
        const msg = await session.cdp.evaluate("document.querySelector('#pair-status').textContent");
        assert.match(msg, expected);
        return msg;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error("Timed out waiting for " + id);
  }
  const begin = async (display, expected) => {
    await setInputValue(session.cdp, "pair-display", JSON.stringify(display));
    return tap("pair-begin", expected);
  };
  const wrong = structuredClone(info);
  wrong.cert_sha256 = (info.cert_sha256[0] === "0" ? "1" : "0") + info.cert_sha256.slice(1);
  wrong.pairing_session.cert_sha256 = wrong.cert_sha256;
  await begin(wrong, /pin_mismatch/);
  assert.equal(control("status").pending_requests.length, 0);
  const sas = (await begin(info, /核对 [0-9]{6}$/)).slice(-6);
  const pending = control("status").pending_requests;
  assert.equal(pending.length, 1);
  assert.ok(sas === pending[0].sas_code, "Desktop and Android SAS must match");
  await tap("pair-confirm", /HTTP_409_awaiting_desktop_confirm/);
  await tap("pair-read", /not_paired/);
  assert.ok(control("approve", "--request-id", pending[0].request_id, "--sas-code", sas).ok);
  await tap("pair-read", /not_paired/);
  await tap("pair-confirm", /配对已完成/);
  const trip = await tap("pair-read", /92ba6a148a17.*86\.35/);
  const pid = session.pid;
  session.cdp.close();
  session = await forceStopAndReopen(serial, port, pid);
  assert.equal(await tap("pair-read", /92ba6a148a17.*86\.35/), trip);
  let verifyRevoked;
  if (ctx) {
    const sql = query => adb(serial, ["shell", `run-as ${PACKAGE} sqlite3 -readonly files/p1-offline-trip-ledger/store.db '${query}'`]).stdout.trim();
    const phone = () => session.cdp.evaluate("window.__travelflowOfflineEntry.inspect()");
    const dbBytes = () => Buffer.from(sql("SELECT hex(CAST(raw_command_json AS BLOB)) FROM outbox"), "hex");
    const networkRoute = () => adb(serial, ["shell", "ip", "route", "get", bind], { allowFailure: true });
    const routedInterface = route.match(/ dev (\S+)/)[1];
    const exchangeRoutes = {};
    async function awaitRoute(connected) {
      for (let i = 0; i < 100; i++) {
        const route = networkRoute();
        if (connected ? route.status === 0 && route.stdout.includes(" dev " + routedInterface + " ")
          : route.status !== 0 && /unreachable/i.test(route.stderr + route.stdout)) return route.stdout.trim();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw Error("Android route did not reach expected connectivity: " + connected);
    }
    setAirplaneMode(serial, true);
    await awaitRoute(false);
    assert.equal(getAirplaneMode(serial), "1");
    await session.cdp.tap("trip-open-entry-btn");
    await setInputValue(session.cdp, "trip-entry-title", "机场地铁票");
    await setInputValue(session.cdp, "trip-entry-amount-yuan", "17.23");
    await setInputValue(session.cdp, "trip-entry-category", "transport");
    await session.cdp.tap("trip-entry-save-btn");
    await waitForCondition(session.cdp, "window.__travelflowOfflineEntry.getUiState().lastAttempt.outcome === 'saved'", "offline save");
    const offline = await phone();
    assert.deepEqual([offline.expenseCount, offline.totalCents, offline.outboxCount], [1, 1723, 1]);
    const bytes = dbBytes();
    const command = JSON.parse(bytes);
    const op = command.operation.operation_id;
    const action = async (verb, expected) => {
      const pathBefore = networkRoute().stdout.trim().split("\n")[0].trim();
      assert.ok(pathBefore.includes(" dev " + routedInterface + " "));
      await session.cdp.tap("trip-" + verb + "-" + op);
      await waitForCondition(session.cdp,
        `document.querySelector('#trip-sync-status').textContent.includes(${JSON.stringify(expected)})`, expected);
      assert.equal(networkRoute().stdout.trim().split("\n")[0].trim(), pathBefore);
      exchangeRoutes[verb + ":" + expected] = pathBefore;
    };
    setAirplaneMode(serial, false);
    const exchangeRoute = await awaitRoute(true);
    await tap("pair-read", /92ba6a148a17/);
    await action("send", "HTTP_403_exchange_not_authorized");
    assert.deepEqual(inspect().head_expenses, initial.head_expenses);
    assert.ok(control("bind-exchange", "--device-id", pending[0].device_id, "--dataset-id", ctx.dataset_id,
      "--source-device-id", ctx.authorized_devices[0], "--travel-id", ctx.travel_id, "--branch-id", ctx.branch_id).ok);
    const faultStatus = execFileSync(python, [...pyFlags, "-c", [
      "import sys", "from pathlib import Path", "from desktop.lan_pairing import _control_call",
      "print(_control_call(Path(sys.argv[1]), 'POST', '/control/exchange/fault', {'fault':'after_commit_before_reply'})[0])",
    ].join("\n"), state], { cwd: desktop, encoding: "utf8" }).trim();
    assert.equal(faultStatus, "200");
    await action("send", "delivery_unconfirmed");
    const committed = inspect();
    assert.deepEqual(committed.head_expenses, [...initial.head_expenses,
      { id: command.target.entity_id, title: command.payload.title, amount_cents: 1723, category: "transport" }]);
    assert.deepEqual(committed.version_ids, [...initial.version_ids, committed.head_revision_id]);
    assert.equal(committed.head_paid_cents, initial.head_paid_cents + 1723);
    assert.equal(committed.receipts.length, initial.receipts.length + 1);
    const receipt = committed.receipts.find(row => row.operation_id === op);
    assert.equal(receipt.intent_sha256, offline.expenses[0].intent_sha256);
    assert.equal(receipt.result_version_id, committed.head_revision_id);
    session.cdp.close();
    session = await forceStopAndReopen(serial, port, session.pid);
    const cold = await phone();
    assert.deepEqual([cold.outboxCount, cold.expenses[0].desktop_revision_id], [1, null]);
    assert.deepEqual(dbBytes(), bytes);
    await action("query", "查询确认 " + receipt.result_version_id);
    const recovered = await phone();
    assert.deepEqual([recovered.totalCents, recovered.expenseCount, recovered.outboxCount, recovered.revisionCount],
      [1723, 1, 0, offline.revisionCount]);
    assert.deepEqual([sql("SELECT desktop_revision_id FROM outbox"), sql("SELECT synced_desktop_revision_id FROM branch_head")],
      [receipt.result_version_id, receipt.result_version_id]);
    const confirmedDump = sql(".dump");
    await action("send", "原回执重放 " + receipt.result_version_id);
    assert.equal(sql(".dump"), confirmedDump);
    const replayed = inspect();
    // The desktop's post-commit hook interrupted checkpoint recovery. Replay completes it.
    assert.ok(replayed.head_checkpoint_id);
    assert.deepEqual(replayed, { ...committed, head_checkpoint_id: replayed.head_checkpoint_id });
    assert.deepEqual(committed.fork, initial.fork);
    const fork = inspect(ctx.fork_branch_id);
    assert.deepEqual(fork.head_expenses, initialFork.head_expenses);
    assert.equal(fork.head_paid_cents, initialFork.head_paid_cents);
    if (values.roundtrip) {
      const desktopEdit = windows ? handoff("edit-expense", "--database", ctx.database, "--version-id", receipt.result_version_id,
        "--expense-id", command.target.entity_id, "--amount", "21.50").version_id : JSON.parse(execFileSync(python, [path.resolve("scripts/p1-roundtrip-desktop.py"), "edit",
        ctx.database, receipt.result_version_id, command.target.entity_id, ctx.branch_id], { cwd: desktop, encoding: "utf8" }));
      const status = () => handoff("outbound-status", "--database", ctx.database);
      const queued = status().pending;
      assert.equal(queued.length, 1);
      const rawSha = createHash("sha256").update(queued[0].raw_command_json).digest("hex");
      const patchTap = async (id, expected) => {
        const beforeRoute = networkRoute().stdout.trim().split("\n")[0].trim();
        assert.ok(beforeRoute.includes(" dev " + routedInterface + " "));
        await tap(id, expected);
        assert.equal(networkRoute().stdout.trim().split("\n")[0].trim(), beforeRoute);
        exchangeRoutes[id + ":" + expected.source] = beforeRoute;
      };
      const pull = async expected => {
        await patchTap("patch-pull", expected);
        assert.equal(await session.cdp.evaluate("document.querySelector('#patch-pull').dataset.rawSha256"), rawSha);
      };
      await pull(/已更新原消费/);
      const mobileReceipt = () => JSON.parse(sql("SELECT receipt_json FROM received_patches"));
      const first = mobileReceipt();
      assert.equal(first.operation.operation_id, queued[0].operation_id);
      assert.equal(first.intent_sha256, queued[0].intent_sha256);
      assert.equal(first.entity_id, command.target.entity_id);
      const changedPhone = await phone();
      assert.deepEqual(changedPhone.expenses, [{ ...recovered.expenses[0], amount_cents: 2150 }]);
      assert.equal(changedPhone.headRevisionId, first.result_revision_id);
      assert.deepEqual([changedPhone.totalCents, changedPhone.revisionCount, changedPhone.receiptCount, changedPhone.outboxCount],
        [2150, recovered.revisionCount + 1, recovered.receiptCount, 0]);
      assert.deepEqual([changedPhone.syncedDesktopRevisionId, first.synced_desktop_revision_id], [desktopEdit, desktopEdit]);
      assert.equal(sql("SELECT count(*) FROM received_patches"), "1");
      const savedDump = sql(".dump");
      session.cdp.close();
      session = await forceStopAndReopen(serial, port, session.pid);
      assert.equal(status().pending[0].delivery_state, "verification_pending");
      assert.deepEqual(mobileReceipt(), first);
      await pull(/已读回原回执/);
      assert.equal(sql(".dump"), savedDump);
      const afterEdit = inspect();
      assert.equal(afterEdit.head_paid_cents, initial.head_paid_cents + 2150);
      assert.deepEqual(afterEdit.head_expenses, [...initial.head_expenses, { ...committed.head_expenses.at(-1), amount_cents: 2150 }]);
      assert.deepEqual(afterEdit.version_ids, [...committed.version_ids, desktopEdit]);
      assert.deepEqual(afterEdit.receipts, committed.receipts);
      await patchTap("patch-confirm", /桌面已收到更正回执/);
      const listenerPid = () => windows ? Number(ps(`(Get-NetTCPConnection -State Listen -LocalAddress '${bind}' -LocalPort ${info.lan_port} -ErrorAction Stop).OwningProcess`)) : server.pid;
      const oldPid = listenerPid();
      assert.ok(oldPid > 0);
      assert.ok(control("stop").ok);
      await exited;
      const restarted = await startDesktop(info.lan_port, false);
      const newPid = listenerPid();
      assert.ok(newPid > 0 && newPid !== oldPid);
      assert.equal(restarted.lan_port, info.lan_port);
      assert.equal(restarted.lan_host, info.lan_host);
      assert.equal(restarted.cert_sha256, info.cert_sha256);
      const confirmed = status();
      assert.deepEqual([confirmed.pending_count, confirmed.confirmed_count, confirmed.all.length], [0, 1, 1]);
      assert.equal(confirmed.confirmed[0].confirmed_mobile_revision_id, first.result_revision_id);
      assert.deepEqual(JSON.parse(confirmed.confirmed[0].last_raw_response_json).receipt, first);
      const final = inspect();
      for (const key of ["version_ids", "head_paid_cents", "head_expenses", "receipts", "fork"]) {
        assert.deepEqual(final[key], afterEdit[key]);
      }
      await patchTap("patch-confirm", /桌面已确认同一份回执/);
      assert.deepEqual(status(), confirmed);
      assert.deepEqual(inspect(), final);
      assert.equal(sql(".dump"), savedDump);
      assert.deepEqual(final.fork, initial.fork);
      const forkRead = inspect(ctx.fork_branch_id);
      assert.deepEqual(forkRead.head_expenses, initialFork.head_expenses);
      assert.equal(forkRead.head_paid_cents, initialFork.head_paid_cents);
      if (windows) {
        session.cdp.close();
        session = await forceStopAndReopen(serial, port, session.pid);
        await tap("pair-read", /92ba6a148a17.*86\.35/);
        assert.equal(sql(".dump"), savedDump);
      }
      await patchTap("patch-pull", /暂无待领更正/);
      console.log(JSON.stringify({ roundtrip: true, desktopEdit, mobileRevision: first.result_revision_id,
        operation: first.operation.operation_id, rawSha, mobileCents: changedPhone.totalCents, mobileExpenses: changedPhone.expenseCount,
        mobileVersions: changedPhone.revisionCount, mobileCreateReceipts: changedPhone.receiptCount, mobilePatchReceipts: 1,
        desktopCents: final.head_paid_cents, desktopExpenses: final.head_expenses.length, desktopVersions: final.version_ids.length,
        desktopCreateReceipts: final.receipts.length, pending: confirmed.pending_count, confirmed: confirmed.confirmed_count,
        fork: final.fork, forkPaid: forkRead.head_paid_cents, oldDesktopPid: oldPid, newDesktopPid: newPid, desktopPlatform: windows ? winHost.os : process.platform, desktopPython: winHost?.version, adapter: winHost?.adapter, wslRoute: winHost?.wslRoute, exchangeRoutes }, null, 2));
    } else verifyRevoked = async () => {
      await action("send", "HTTP_403_device_revoked");
      await action("query", "HTTP_403_device_revoked");
      assert.equal(sql(".dump"), confirmedDump);
      assert.deepEqual(inspect(), replayed);
      console.log(JSON.stringify({ op, exchangeRoute, exchangeRoutes, checkpointAfterDrop: committed.head_checkpoint_id, checkpointAfterReplay: replayed.head_checkpoint_id, rawBytes: bytes.length, rawSha256: createHash("sha256").update(bytes).digest("hex"),
        confirmedRevision: receipt.result_version_id, mobilePaid: recovered.totalCents, mobileCount: recovered.expenseCount,
        pendingAfterDrop: cold.outboxCount, pendingAfterLookup: recovered.outboxCount, desktopPaid: committed.head_paid_cents,
        desktopCount: committed.head_expenses.length, desktopReceipts: committed.receipts.length, fork: committed.fork,
        forkPaid: fork.head_paid_cents, revokedSendAndLookup: "403 device_revoked" }, null, 2));
    };
  }
  assert.ok(control("revoke", "--device-id", pending[0].device_id).revoked);
  if (verifyRevoked) await verifyRevoked();
  const revoked = await tap("pair-read", /HTTP_403_device_revoked/);
  assert.ok(!revoked.includes("92ba6a148a17"));
  assert.equal(control("status").devices[0].status, "revoked");
  console.log(JSON.stringify({ desktopCommit: ref, kernel: release(), bind, port: info.lan_port, route,
    pinMismatchRequests: 0, desktopConfirmationRequired: true, independentSasMatched: true,
    trip, pid, coldPid: session.pid, revoked: "403 device_revoked" }, null, 2));
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    if (windows) {
      try { control("stop"); } catch { server.kill("SIGTERM"); }
    } else server.kill("SIGTERM");
    await exited;
  }
  session?.cdp.close();
  if (installed) {
    adb(serial, ["forward", "--remove", "tcp:" + port], { allowFailure: true });
    setAirplaneMode(serial, airplane === "1");
    adb(serial, ["uninstall", PACKAGE]);
  }
  if (built) rmSync(built.tempRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
