// 隔离 API 35 模拟器端到端验收：从实际 TS 页面经 Capacitor 提交虚构消费更正并验证三种故障恢复。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "org.travelflow.p1bridge";
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const EXPECTED_AVD = "travelflow_p0_api35";
const EXPECTED_TITLE = "TravelFlow P1 Bridge Receipt";

function parseArgs(argv) {
  const opts = { buildOnly: false, serial: null, cdpPort: 19240, apk: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--build-only") {
      opts.buildOnly = true;
    } else if (arg === "--serial") {
      opts.serial = argv[++i] ?? null;
    } else if (arg === "--cdp-port") {
      opts.cdpPort = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--apk") {
      opts.apk = argv[++i] ?? null;
    } else {
      throw new Error("Usage: check-p1-bridge-android.mjs (--build-only | --serial emulator-5580 [--cdp-port 19240] [--apk PATH])");
    }
  }
  if (opts.buildOnly === Boolean(opts.serial)) {
    throw new Error("Specify exactly one of --build-only or --serial emulator-N");
  }
  if (!Number.isInteger(opts.cdpPort) || opts.cdpPort < 1024 || opts.cdpPort > 65535) {
    throw new Error("Invalid --cdp-port");
  }
  return opts;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 240000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.inherit ? "" : `\n${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}${detail}`);
  }
  return (result.stdout ?? "").trim();
}

function buildDebugApk(tmpDir) {
  const androidHome = process.env.ANDROID_HOME;
  const javaHome = process.env.JAVA_HOME;
  assert.ok(androidHome, "ANDROID_HOME must be set");
  assert.ok(javaHome, "JAVA_HOME must be set");
  const projectDir = path.join(tmpDir, "p1-bridge-app");
  run(process.execPath, [path.join(root, "scripts/prepare-p1-bridge-receipt.mjs"), "--output", projectDir]);
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  run(gradlew, [":app:assembleDebug", "--no-daemon", "--console=plain"], {
    cwd: path.join(projectDir, "android"),
    env: {
      ...process.env,
      ANDROID_HOME: androidHome,
      JAVA_HOME: javaHome,
      PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const apk = path.join(projectDir, "android/app/build/outputs/apk/debug/app-debug.apk");
  assert.ok(existsSync(apk), `Missing built debug APK at ${apk}`);
  return apk;
}

function createAdb(adbPath, serial) {
  return (...args) => run(adbPath, ["-s", serial, ...args], { timeout: 60000 });
}

function pidOf(adb) {
  const result = spawnSync(process.env.ANDROID_HOME + "/platform-tools/adb", [
    "-s", adb.serial, "shell", "pidof", PACKAGE,
  ], { encoding: "utf8", timeout: 15000 });
  if (result.status !== 0) return null;
  const first = (result.stdout ?? "").trim().split(/\s+/).filter(Boolean)[0];
  return first ? Number.parseInt(first, 10) : null;
}

async function waitForPid(adb, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = pidOf(adb);
    if (predicate(pid)) return pid;
    await delay(100);
  }
  throw new Error(`Timed out waiting for PID condition: ${label}`);
}

async function connectWebView(port) {
  const deadline = Date.now() + 15000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find((item) => item.title === EXPECTED_TITLE);
        if (target?.webSocketDebuggerUrl) break;
      }
    } catch {
      // WebView DevTools socket not ready yet.
    }
    await delay(150);
  }
  assert.ok(target, `Expected isolated WebView titled "${EXPECTED_TITLE}"`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onclose = () => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP WebSocket closed"));
    }
    pending.clear();
  };
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };

  function call(method, params = {}) {
    if (closed) return Promise.reject(new Error("CDP WebSocket already closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }

  async function until(expression, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(50);
    }
    throw new Error(`Condition timed out: ${expression}`);
  }

  async function tap(id, { expectDeath = false } = {}) {
    const receipt = JSON.stringify(`__tfP1Tap_${crypto.randomUUID()}`);
    try {
      const point = await evaluate(`(async () => {
        const button = document.getElementById(${JSON.stringify(id)});
        if (!button) throw Error('Missing button ' + ${JSON.stringify(id)});
        if (button.disabled) throw Error('Button disabled: ' + ${JSON.stringify(id)});
        button.scrollIntoView({block: 'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = button.getBoundingClientRect();
        const viewport = window.visualViewport;
        const point = {
          x: box.x + box.width / 2 - (viewport ? viewport.offsetLeft : 0),
          y: box.y + box.height / 2 - (viewport ? viewport.offsetTop : 0),
        };
        const listener = event => {
          window[${receipt}].clicked = {
            trusted: event.isTrusted,
            expected: event.target === button || button.contains(event.target),
          };
        };
        window[${receipt}] = {listener, clicked: null};
        document.addEventListener('click', listener, {capture: true, once: true});
        return point;
      })()`);
      await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      if (expectDeath) {
        try {
          const clicked = await until(`window[${receipt}]?.clicked`, 3000);
          assert.ok(clicked.trusted && clicked.expected, `Touch missed ${id}`);
        } catch (error) {
          if (!closed && !String(error).includes("CDP WebSocket")) throw error;
        }
        return;
      }
      const clicked = await until(`window[${receipt}].clicked`, 3000);
      assert.ok(clicked.trusted && clicked.expected, `Touch missed ${id}: ${JSON.stringify(clicked)}`);
    } finally {
      if (!closed) {
        try {
          await evaluate(`(() => {
            const receipt = window[${receipt}];
            if (!receipt) return;
            document.removeEventListener('click', receipt.listener, true);
            delete window[${receipt}];
          })()`);
        } catch {
          if (!expectDeath) throw new Error("Failed cleaning up tap listener");
        }
      }
    }
  }

  async function setSelect(id, value) {
    await evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await until(`!document.getElementById('seed-scenario').disabled`);
  }

  async function setInput(id, value) {
    await evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
  }

  async function tapAndWaitAction(id) {
    await evaluate(`window.__tfPrevAction = document.getElementById('action-status').textContent;`);
    await tap(id);
    await until(`!document.getElementById(${JSON.stringify(id)}).disabled && document.getElementById('action-status').textContent !== '正在执行'`);
    const outcome = await evaluate(`window.__tfP1Bridge.getLastOutcome()`);
    assert.ok(outcome && outcome.status !== "error", `Action ${id} failed: ${JSON.stringify(outcome)}`);
    return outcome;
  }

  return {
    evaluate,
    until,
    tap,
    setSelect,
    setInput,
    tapAndWaitAction,
    close: () => {
      try { ws.close(); } catch {}
    },
  };
}

async function launchAndAttach(adb, cdpPort, previousPid = null) {
  try {
    adb("forward", "--remove", `tcp:${cdpPort}`);
  } catch {
    // Ignore if not previously forwarded.
  }
  adb("shell", "am", "start", "-W", "-n", ACTIVITY);
  const pid = await waitForPid(adb, (p) => p !== null && p !== previousPid, "new app process");
  adb("forward", `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`);
  const client = await connectWebView(cdpPort);
  await client.until(`document.getElementById('runtime')?.textContent?.includes('Android原生桥已就绪')`);
  await client.until(`!document.getElementById('seed-scenario').disabled`);
  return { pid, client };
}

function assertFinalInvariants(state, expectedOp, expectedIntent, expectedCents) {
  assert.equal(state.seeded, true);
  assert.equal(state.head, 3);
  assert.equal(state.cents, expectedCents);
  assert.equal(state.historyCount, 4);
  assert.equal(state.receiptCount, 3);
  assert.equal(state.outboxCount, 3);
  assert.equal(state.opReceiptCount, 1);
  assert.equal(state.opOutboxCount, 1);
  assert.equal(state.opHistoryCount, 1);
  assert.equal(state.committedIntent, expectedIntent);
  assert.equal(state.pending, null);
  assert.equal(state.confirmedOp, expectedOp);
  assert.equal(state.confirmedRev, 3);
  assert.equal(state.ticketExists, true);
  assert.equal(state.ticketIntact, true);
  assert.equal(state.ticketText, "fictional ticket 56");
  assert.equal(state.unmanagedIntact, true);
}

async function runScenarios(adb, cdpPort) {
  const report = {
    avd: adb("shell", "getprop", "ro.boot.qemu.avd_name"),
    sdk: adb("shell", "getprop", "ro.build.version.sdk"),
    abi: adb("shell", "getprop", "ro.product.cpu.abi"),
    package: PACKAGE,
    scenarios: {},
  };

  let session = await launchAndAttach(adb, cdpPort);

  try {
    // 1. before-commit: 提交前中断，重开查无回执后用原操作 ID 与原意图重试并仅提交一次
    {
      const scenario = "before-commit";
      await session.client.setSelect("scenario", scenario);
      const seeded = await session.client.tapAndWaitAction("seed-scenario");
      assert.equal(seeded.state.head, 2);
      assert.equal(seeded.state.cents, 756);
      assert.equal(seeded.state.ticketIntact, true);
      await session.client.setSelect("fault-mode", "before_commit");
      await session.client.setInput("amount-cents", 842);

      const pidBefore = session.pid;
      await session.client.tap("submit-patch", { expectDeath: true });
      await waitForPid(adb, (p) => p === null || p !== pidBefore, "before-commit crash");
      session.client.close();

      session = await launchAndAttach(adb, cdpPort, pidBefore);
      await session.client.setSelect("scenario", scenario);
      const afterCrash = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
      assert.ok(afterCrash.pending, "Expected persisted pending intent after before-commit crash");
      const { operationId, intentJson } = afterCrash.pending;
      assert.equal(afterCrash.head, 2);
      assert.equal(afterCrash.cents, 756);
      assert.equal(afterCrash.opReceiptCount, 0);
      assert.equal(afterCrash.opOutboxCount, 0);
      assert.equal(afterCrash.ticketIntact, true);

      const recovered = await session.client.tapAndWaitAction("recover-pending");
      assert.equal(recovered.lookup.status, "no_receipt");
      assert.equal(recovered.status, "recovered_committed");
      assert.equal(recovered.retry.status, "committed");
      assert.equal(recovered.retry.operationId, operationId);
      assertFinalInvariants(recovered.state, operationId, intentJson, 842);

      const replayed = await session.client.tapAndWaitAction("replay-confirmed");
      assert.equal(replayed.status, "replayed");
      assertFinalInvariants(replayed.state, operationId, intentJson, 842);

      const conflict = await session.client.tapAndWaitAction("conflict-check");
      assert.equal(conflict.status, "intent_conflict");
      assertFinalInvariants(conflict.state, operationId, intentJson, 842);

      report.scenarios[scenario] = {
        pidBefore,
        pidAfter: session.pid,
        operationId,
        beforeCrash: { head: seeded.state.head, cents: seeded.state.cents, history: seeded.state.historyCount, receipt: seeded.state.receiptCount, outbox: seeded.state.outboxCount },
        afterCrash: { head: afterCrash.head, cents: afterCrash.cents, opReceiptCount: afterCrash.opReceiptCount, opOutboxCount: afterCrash.opOutboxCount, pendingPreserved: true },
        recoveredStatus: recovered.status,
        replayStatus: replayed.status,
        conflictStatus: conflict.status,
        final: {
          head: conflict.state.head,
          cents: conflict.state.cents,
          history: conflict.state.historyCount,
          receipt: conflict.state.receiptCount,
          outbox: conflict.state.outboxCount,
          opReceiptCount: conflict.state.opReceiptCount,
          opOutboxCount: conflict.state.opOutboxCount,
          ticketIntact: conflict.state.ticketIntact,
          sqlite: conflict.state.sqlite,
          journal: conflict.state.journal,
        },
      };
    }

    // 2. after-commit-drop-reply: 提交成功但页面未收到应答，重开查回原回执且不重复写入
    {
      const scenario = "after-commit-drop-reply";
      await session.client.setSelect("scenario", scenario);
      const seeded = await session.client.tapAndWaitAction("seed-scenario");
      assert.equal(seeded.state.head, 2);
      assert.equal(seeded.state.cents, 756);
      await session.client.setSelect("fault-mode", "after_commit_drop_reply");
      await session.client.setInput("amount-cents", 851);

      const pidBefore = session.pid;
      await session.client.tap("submit-patch", { expectDeath: true });
      await waitForPid(adb, (p) => p === null || p !== pidBefore, "after-commit-drop-reply crash");
      session.client.close();

      session = await launchAndAttach(adb, cdpPort, pidBefore);
      await session.client.setSelect("scenario", scenario);
      const afterCrash = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
      assert.ok(afterCrash.pending, "Expected persisted pending intent after dropped reply");
      const { operationId, intentJson } = afterCrash.pending;
      assert.equal(afterCrash.head, 3);
      assert.equal(afterCrash.cents, 851);
      assert.equal(afterCrash.opReceiptCount, 1);
      assert.equal(afterCrash.opOutboxCount, 1);
      assert.equal(afterCrash.confirmedOp, null);

      const recovered = await session.client.tapAndWaitAction("recover-pending");
      assert.equal(recovered.lookup.status, "confirmed");
      assert.equal(recovered.status, "confirmed_existing");
      assertFinalInvariants(recovered.state, operationId, intentJson, 851);

      // Force-stop and reopen to verify confirmed state persists across cold restart.
      const pidBeforeReopen = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, "force-stop after-commit-drop-reply");
      session = await launchAndAttach(adb, cdpPort, pidBeforeReopen);
      await session.client.setSelect("scenario", scenario);
      const reopened = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
      assertFinalInvariants(reopened, operationId, intentJson, 851);

      report.scenarios[scenario] = {
        pidBefore,
        pidAfterCrash: pidBeforeReopen,
        pidAfterReopen: session.pid,
        operationId,
        afterCrash: { head: afterCrash.head, cents: afterCrash.cents, opReceiptCount: afterCrash.opReceiptCount, opOutboxCount: afterCrash.opOutboxCount, pendingPreserved: true },
        recoveredStatus: recovered.status,
        final: {
          head: reopened.head,
          cents: reopened.cents,
          history: reopened.historyCount,
          receipt: reopened.receiptCount,
          outbox: reopened.outboxCount,
          opReceiptCount: reopened.opReceiptCount,
          opOutboxCount: reopened.opOutboxCount,
          ticketIntact: reopened.ticketIntact,
        },
      };
    }

    // 3 & 4. lock-busy-commit & lock-busy-rollback: 独立写进程持锁时 TS 查询收到 pending_busy 并保留原意图
    for (const { scenario, commitOnRelease, cents } of [
      { scenario: "lock-busy-commit", commitOnRelease: true, cents: 863 },
      { scenario: "lock-busy-rollback", commitOnRelease: false, cents: 874 },
    ]) {
      await session.client.setSelect("scenario", scenario);
      const seeded = await session.client.tapAndWaitAction("seed-scenario");
      assert.equal(seeded.state.head, 2);
      await session.client.setInput("amount-cents", cents);

      const prepared = await session.client.tapAndWaitAction("prepare-pending");
      const { operationId, intentJson } = prepared.pending;
      assert.ok(operationId && intentJson);

      const lockInfo = await session.client.evaluate(`window.__tfP1Bridge.holdWriterLock(${JSON.stringify({
        scenario,
        operationId,
        intentJson,
        amountCents: cents,
        expectedRevision: 2,
        commitOnRelease,
      })})`);
      assert.notEqual(lockInfo.writerPid, lockInfo.callerPid, "Writer must run in a distinct Android process");

      let busyOutcome;
      try {
        busyOutcome = await session.client.tapAndWaitAction("recover-pending");
      } finally {
        await session.client.evaluate(`window.__tfP1Bridge.releaseWriterLock(${JSON.stringify(scenario)})`);
      }

      assert.equal(busyOutcome.status, "pending_busy");
      assert.equal(busyOutcome.lookup.status, "pending_busy");
      assert.equal(busyOutcome.lookup.plainReceipts, 0);
      assert.equal(busyOutcome.state.pending?.operationId, operationId);
      assert.equal(busyOutcome.state.pending?.intentJson, intentJson);
      assert.equal(busyOutcome.state.confirmedOp, null);

      // Kill the caller process without delivering any receipt from the writer, then reopen.
      const pidBeforeKill = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario}`);

      session = await launchAndAttach(adb, cdpPort, pidBeforeKill);
      await session.client.setSelect("scenario", scenario);
      const afterReopen = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
      assert.equal(afterReopen.pending?.operationId, operationId);
      assert.equal(afterReopen.pending?.intentJson, intentJson);
      assert.equal(afterReopen.head, commitOnRelease ? 3 : 2);
      assert.equal(afterReopen.cents, commitOnRelease ? cents : 756);

      const recovered = await session.client.tapAndWaitAction("recover-pending");
      if (commitOnRelease) {
        assert.equal(recovered.lookup.status, "confirmed");
        assert.equal(recovered.status, "confirmed_existing");
      } else {
        assert.equal(recovered.lookup.status, "no_receipt");
        assert.equal(recovered.status, "recovered_committed");
        assert.equal(recovered.retry.operationId, operationId);
      }
      assertFinalInvariants(recovered.state, operationId, intentJson, cents);

      report.scenarios[scenario] = {
        callerPidBefore: pidBeforeKill,
        writerPid: lockInfo.writerPid,
        callerPidAfter: session.pid,
        operationId,
        busyLookup: {
          status: busyOutcome.lookup.status,
          plainReceipts: busyOutcome.lookup.plainReceipts,
          pendingPreserved: true,
        },
        afterReopenBeforeRecover: {
          head: afterReopen.head,
          cents: afterReopen.cents,
          opReceiptCount: afterReopen.opReceiptCount,
          opOutboxCount: afterReopen.opOutboxCount,
        },
        recoveredStatus: recovered.status,
        final: {
          head: recovered.state.head,
          cents: recovered.state.cents,
          history: recovered.state.historyCount,
          receipt: recovered.state.receiptCount,
          outbox: recovered.state.outboxCount,
          opReceiptCount: recovered.state.opReceiptCount,
          opOutboxCount: recovered.state.opOutboxCount,
          ticketIntact: recovered.state.ticketIntact,
        },
      };
    }
  } finally {
    session.client.close();
  }

  return { passed: true, ...report };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "travelflow-p1-bridge-"));
  try {
    const apk = opts.apk ? path.resolve(opts.apk) : buildDebugApk(tmpDir);
    if (opts.buildOnly) {
      console.log(JSON.stringify({
        passed: true,
        mode: "build-only",
        package: PACKAGE,
        apkBuilt: true,
        emulatorExecuted: false,
      }, null, 2));
      return;
    }

    assert.match(opts.serial, /^emulator-\d+$/, "Expected explicit emulator serial (e.g. emulator-5580)");
    const androidHome = process.env.ANDROID_HOME;
    assert.ok(androidHome, "ANDROID_HOME must be set");
    const adbPath = path.join(androidHome, "platform-tools/adb");
    const adb = createAdb(adbPath, opts.serial);
    adb.serial = opts.serial;

    assert.equal(adb("shell", "getprop", "ro.boot.qemu.avd_name"), EXPECTED_AVD, `Expected AVD ${EXPECTED_AVD}`);
    assert.equal(adb("shell", "getprop", "ro.build.version.sdk"), "35", "Expected API 35");
    assert.equal(adb("shell", "getprop", "sys.boot_completed"), "1", "AVD is not booted");

    const installed = adb("shell", "pm", "list", "packages", "-u", PACKAGE).split(/\r?\n/);
    assert.ok(!installed.includes(`package:${PACKAGE}`), `Existing ${PACKAGE} detected; refusing replacement`);

    const installOut = adb("install", "-t", apk);
    assert.ok(installOut.includes("Success"), `APK install failed: ${installOut}`);
    try {
      const report = await runScenarios(adb, opts.cdpPort);
      console.log(JSON.stringify(report, null, 2));
    } finally {
      try { adb("forward", "--remove", `tcp:${opts.cdpPort}`); } catch {}
      try { adb("shell", "am", "force-stop", PACKAGE); } catch {}
      const uninstallOut = adb("uninstall", PACKAGE);
      assert.ok(uninstallOut.includes("Success"), `APK uninstall failed: ${uninstallOut}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
