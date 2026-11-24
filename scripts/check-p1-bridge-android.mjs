// 隔离 API 35 模拟器端到端验收：从实际 TS 页面经 Capacitor 提交虚构消费更正并验证三种故障恢复。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    } else if (arg === "--desktop-vectors") {
      opts.desktopVectors = argv[++i];
      assert.ok(opts.desktopVectors && !opts.desktopVectors.startsWith("--"), "Missing vectors JSON path");
    } else if (arg === "--apk") {
      opts.apk = argv[++i] ?? null;
    } else {
      throw new Error("Usage: check-p1-bridge-android.mjs (--build-only | --serial emulator-5580 [--cdp-port 19240] [--apk PATH] [--desktop-vectors JSON])");
    }
  }
  if (opts.buildOnly === Boolean(opts.serial)) {
    throw new Error("Specify exactly one of --build-only or --serial emulator-N");
  }
  assert.ok(!opts.desktopVectors || opts.serial, "--desktop-vectors requires --serial");
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

  async function tapExpectingError(id) {
    await tap(id);
    await until(`!document.getElementById(${JSON.stringify(id)}).disabled && document.getElementById('action-status').textContent.endsWith('失败')`);
    const outcome = await evaluate(`window.__tfP1Bridge.getLastOutcome()`);
    assert.ok(outcome && outcome.status === "error", `Expected rejection on ${id}, got: ${JSON.stringify(outcome)}`);
    return outcome;
  }

  async function tapAndWaitCreateAction(id) {
    await tap(id);
    await until(`!document.getElementById(${JSON.stringify(id)}).disabled && document.getElementById('create-status').textContent !== '正在执行'`);
    const outcome = await evaluate(`window.__tfP1Bridge.getLastCreateOutcome()`);
    assert.ok(outcome && outcome.status !== "error", `Create action ${id} failed: ${JSON.stringify(outcome)}`);
    return outcome;
  }

  return {
    evaluate,
    until,
    tap,
    setSelect,
    setInput,
    tapAndWaitAction,
    tapAndWaitCreateAction,
    tapExpectingError,
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
  assert.equal(JSON.parse(state.committedIntent).intent.payload.amount_cents, expectedCents);
  assert.equal(state.pending, null);
  assert.equal(state.confirmedOp, expectedOp);
  assert.equal(state.confirmedRev, 3);
  assert.equal(state.ticketExists, true);
  assert.equal(state.ticketIntact, true);
  assert.equal(state.ticketText, "fictional ticket 56");
  assert.equal(state.unmanagedIntact, true);
}

function assertBaselineUnchanged(state) {
  assert.equal(state.seeded, true);
  assert.equal(state.head, 2);
  assert.equal(state.cents, 756);
  assert.equal(state.historyCount, 3);
  assert.equal(state.receiptCount, 2);
  assert.equal(state.outboxCount, 2);
  assert.equal(state.opReceiptCount, 0);
  assert.equal(state.opOutboxCount, 0);
  assert.equal(state.pending, null);
  assert.equal(state.confirmedOp, null);
  assert.equal(state.ticketIntact, true);
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

    // 5. bound-int32-max: 拒绝 842.9 / 1e3 / 10000000000（不持久化待核实、不改账本），随后提交 2147483647
    {
      const scenario = "bound-int32-max";
      await session.client.setSelect("scenario", scenario);
      const seeded = await session.client.tapAndWaitAction("seed-scenario");
      assertBaselineUnchanged(seeded.state);
      await session.client.setSelect("fault-mode", "none");

      const rejectedInputs = [];
      for (const badRaw of ["842.9", "1e3", "10000000000"]) {
        await session.client.setInput("amount-cents", badRaw);
        const submitErr = await session.client.tapExpectingError("submit-patch");
        const stateAfterSubmit = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
        assertBaselineUnchanged(stateAfterSubmit);
        const prepareErr = await session.client.tapExpectingError("prepare-pending");
        const stateAfterPrepare = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
        assertBaselineUnchanged(stateAfterPrepare);
        rejectedInputs.push({ input: badRaw, submitError: submitErr.error, prepareError: prepareErr.error, unchanged: true });
      }

      const validCents = 2147483647;
      await session.client.setInput("amount-cents", String(validCents));
      const submitted = await session.client.tapAndWaitAction("submit-patch");
      assert.equal(submitted.status, "committed");
      const { operationId, intentJson } = submitted.pending;
      assertFinalInvariants(submitted.state, operationId, intentJson, validCents);

      const replayed = await session.client.tapAndWaitAction("replay-confirmed");
      assert.equal(replayed.status, "replayed");
      assertFinalInvariants(replayed.state, operationId, intentJson, validCents);

      const conflict = await session.client.tapAndWaitAction("conflict-check");
      assert.equal(conflict.status, "intent_conflict");
      assertFinalInvariants(conflict.state, operationId, intentJson, validCents);

      report.scenarios[scenario] = {
        rejectedInputs,
        operationId,
        validCents,
        replayStatus: replayed.status,
        conflictStatus: conflict.status,
        final: {
          head: conflict.state.head,
          cents: conflict.state.cents,
          intentAmountCents: JSON.parse(conflict.state.committedIntent).intent.payload.amount_cents,
          opReceiptCount: conflict.state.opReceiptCount,
          opOutboxCount: conflict.state.opOutboxCount,
          ticketIntact: conflict.state.ticketIntact,
        },
      };
    }

    // 6. bound-int32-over: 2147483648 跨过 32 位上限，贯通保存待核实、独立写进程、SQLite、确认和重放
    {
      const scenario = "bound-int32-over";
      const validCents = 2147483648;
      await session.client.setSelect("scenario", scenario);
      const seeded = await session.client.tapAndWaitAction("seed-scenario");
      assertBaselineUnchanged(seeded.state);
      await session.client.setInput("amount-cents", String(validCents));

      const prepared = await session.client.tapAndWaitAction("prepare-pending");
      const { operationId, intentJson } = prepared.pending;
      assert.equal(prepared.pending.amountCents, validCents);

      const lockInfo = await session.client.evaluate(`window.__tfP1Bridge.holdWriterLock(${JSON.stringify({
        scenario,
        operationId,
        intentJson,
        amountCents: validCents,
        expectedRevision: 2,
        commitOnRelease: true,
      })})`);
      assert.notEqual(lockInfo.writerPid, lockInfo.callerPid);

      let busyOutcome;
      try {
        busyOutcome = await session.client.tapAndWaitAction("recover-pending");
      } finally {
        await session.client.evaluate(`window.__tfP1Bridge.releaseWriterLock(${JSON.stringify(scenario)})`);
      }
      assert.equal(busyOutcome.status, "pending_busy");
      assert.equal(busyOutcome.state.pending?.amountCents, validCents);

      const pidBeforeKill = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario}`);

      session = await launchAndAttach(adb, cdpPort, pidBeforeKill);
      await session.client.setSelect("scenario", scenario);
      const recovered = await session.client.tapAndWaitAction("recover-pending");
      assert.equal(recovered.status, "confirmed_existing");
      assertFinalInvariants(recovered.state, operationId, intentJson, validCents);

      const replayed = await session.client.tapAndWaitAction("replay-confirmed");
      assert.equal(replayed.status, "replayed");
      assertFinalInvariants(replayed.state, operationId, intentJson, validCents);

      const conflict = await session.client.tapAndWaitAction("conflict-check");
      assert.equal(conflict.status, "intent_conflict");
      assertFinalInvariants(conflict.state, operationId, intentJson, validCents);

      report.scenarios[scenario] = {
        callerPidBefore: pidBeforeKill,
        writerPid: lockInfo.writerPid,
        callerPidAfter: session.pid,
        operationId,
        validCents,
        busyStatus: busyOutcome.status,
        recoveredStatus: recovered.status,
        replayStatus: replayed.status,
        conflictStatus: conflict.status,
        final: {
          head: conflict.state.head,
          cents: conflict.state.cents,
          intentAmountCents: JSON.parse(conflict.state.committedIntent).intent.payload.amount_cents,
          opReceiptCount: conflict.state.opReceiptCount,
          opOutboxCount: conflict.state.opOutboxCount,
          ticketIntact: conflict.state.ticketIntact,
        },
      };
    }

    // 7. bound-max-cents: 9999999999 上限贯通提交丢应答、重开恢复、确认、重放和冲突拒绝
    {
      const scenario = "bound-max-cents";
      const validCents = 9999999999;
      await session.client.setSelect("scenario", scenario);
      const seeded = await session.client.tapAndWaitAction("seed-scenario");
      assertBaselineUnchanged(seeded.state);
      await session.client.setSelect("fault-mode", "after_commit_drop_reply");
      await session.client.setInput("amount-cents", String(validCents));

      const pidBefore = session.pid;
      await session.client.tap("submit-patch", { expectDeath: true });
      await waitForPid(adb, (p) => p === null || p !== pidBefore, "bound-max-cents crash");
      session.client.close();

      session = await launchAndAttach(adb, cdpPort, pidBefore);
      await session.client.setSelect("scenario", scenario);
      const afterCrash = await session.client.evaluate(`window.__tfP1Bridge.inspectState(${JSON.stringify(scenario)})`);
      assert.ok(afterCrash.pending);
      assert.equal(afterCrash.pending.amountCents, validCents);
      assert.equal(afterCrash.cents, validCents);
      const { operationId, intentJson } = afterCrash.pending;

      const recovered = await session.client.tapAndWaitAction("recover-pending");
      assert.equal(recovered.status, "confirmed_existing");
      assertFinalInvariants(recovered.state, operationId, intentJson, validCents);

      const replayed = await session.client.tapAndWaitAction("replay-confirmed");
      assert.equal(replayed.status, "replayed");
      assertFinalInvariants(replayed.state, operationId, intentJson, validCents);

      const conflict = await session.client.tapAndWaitAction("conflict-check");
      assert.equal(conflict.status, "intent_conflict");
      assertFinalInvariants(conflict.state, operationId, intentJson, validCents);

      report.scenarios[scenario] = {
        pidBefore,
        pidAfter: session.pid,
        operationId,
        validCents,
        recoveredStatus: recovered.status,
        replayStatus: replayed.status,
        conflictStatus: conflict.status,
        final: {
          head: conflict.state.head,
          cents: conflict.state.cents,
          intentAmountCents: JSON.parse(conflict.state.committedIntent).intent.payload.amount_cents,
          opReceiptCount: conflict.state.opReceiptCount,
          opOutboxCount: conflict.state.opOutboxCount,
          ticketIntact: conflict.state.ticketIntact,
        },
      };
    }

    // 8 & 9. 第二阶段：从空账本 TS 页面按固定桌面样例执行 expense.create（提交前中断与提交后丢应答）
    const createFixtureBytes = readFileSync(path.join(root, "docs/internal/fixtures/p1-desktop-expense-create.json"));
    assert.equal(
      createHash("sha256").update(createFixtureBytes).digest("hex"),
      "da9a97398ebb1e0e3b8e0e17097a8f8bc79da25602f6e7a119800572341a7b3f",
    );
    const createFixture = JSON.parse(createFixtureBytes.toString("utf8"));

    const expectedLunchV1 = {
      id: "fixture-lunch",
      title: "午餐",
      amount_cents: 8635,
      currency: "CNY",
      paid_on: null,
      category: "meal",
      day: null,
      activity_id: null,
      notes: "",
      receipt_ids: [],
      budget_item_id: null,
      settles_budget: false,
    };
    const expectedLunchV2 = { ...expectedLunchV1, notes: "虚构更正" };

    function buildSeedExpense(index) {
      return {
        id: `fixture-seed-${String(index).padStart(4, "0")}`,
        title: "seed",
        amount_cents: 100,
        currency: "CNY",
        paid_on: null,
        category: "other",
        day: null,
        activity_id: null,
        notes: "",
        receipt_ids: [],
        budget_item_id: null,
        settles_budget: false,
      };
    }

    function snapshotSha256(expenses) {
      return createHash("sha256").update(JSON.stringify({ expenses }), "utf8").digest("hex");
    }

    function assertCreateRevisions(revisions, createRevision, advancedHead) {
      assert.equal(revisions.length, advancedHead ? 3 : 2);
      assert.deepEqual(revisions[0], {
        revision_id: "fixture-r0",
        parent_revision_id: null,
        expense_count: 0,
        total_cents: 0,
        snapshot_sha256: snapshotSha256([]),
        snapshot: { expenses: [] },
      });
      assert.deepEqual(revisions[1], {
        revision_id: createRevision,
        parent_revision_id: "fixture-r0",
        expense_count: 1,
        total_cents: 8635,
        snapshot_sha256: snapshotSha256([expectedLunchV1]),
        snapshot: { expenses: [expectedLunchV1] },
      });
      if (advancedHead) {
        assert.deepEqual(revisions[2], {
          revision_id: advancedHead,
          parent_revision_id: createRevision,
          expense_count: 1,
          total_cents: 8635,
          snapshot_sha256: snapshotSha256([expectedLunchV2]),
          snapshot: { expenses: [expectedLunchV2] },
        });
      }
    }

    for (const { scenario, faultMode } of [
      { scenario: "create-before-commit", faultMode: "before_commit" },
      { scenario: "create-after-commit", faultMode: "after_commit_drop_reply" },
    ]) {
      await session.client.setSelect("create-scenario", scenario);
      const seeded = await session.client.tapAndWaitCreateAction("create-seed");
      assert.equal(seeded.state.seeded, true);
      assert.equal(seeded.state.headRevisionId, "fixture-r0");
      assert.equal(seeded.state.expenses.length, 0);
      assert.equal(seeded.state.revisionCount, 1);
      assert.equal(seeded.state.receiptCount, 0);
      assert.equal(seeded.state.outboxCount, 0);

      await session.client.setSelect("create-fault-mode", faultMode);
      const pidBefore = session.pid;
      await session.client.tap("create-submit", { expectDeath: true });
      await waitForPid(adb, (p) => p === null || p !== pidBefore, `${scenario} crash`);
      session.client.close();

      session = await launchAndAttach(adb, cdpPort, pidBefore);
      await session.client.setSelect("create-scenario", scenario);
      const afterCrash = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
      assert.equal(afterCrash.pending?.operationId, "fixture-op-lunch");
      assert.equal(afterCrash.confirmedOp, null);
      if (faultMode === "before_commit") {
        assert.equal(afterCrash.headRevisionId, "fixture-r0");
        assert.equal(afterCrash.expenses.length, 0);
        assert.equal(afterCrash.revisionCount, 1);
        assert.equal(afterCrash.receiptCount, 0);
        assert.equal(afterCrash.outboxCount, 0);
      } else {
        assert.notEqual(afterCrash.headRevisionId, "fixture-r0");
        assert.equal(afterCrash.expenses.length, 1);
        assert.equal(afterCrash.revisionCount, 2);
        assert.equal(afterCrash.receiptCount, 1);
        assert.equal(afterCrash.outboxCount, 1);
      }

      const recovered = await session.client.tapAndWaitCreateAction("create-recover");
      const createRevision = recovered.state.headRevisionId;
      assert.ok(createRevision && createRevision !== "fixture-r0");
      if (faultMode === "before_commit") {
        assert.equal(recovered.status, "recovered_by_retry");
        assert.equal(recovered.lookup.state, "not_found_at_settled_read");
        assert.equal(recovered.retry.replayed, false);
        assert.equal(recovered.retry.effect, "changed");
        assert.deepEqual(recovered.verifiedLookup, {
          accepted: true,
          state: "committed",
          receipt: { effect: "changed", result_revision_id: createRevision },
        });
      } else {
        assert.equal(recovered.status, "confirmed_existing");
        assert.deepEqual(recovered.lookup, {
          accepted: true,
          state: "committed",
          receipt: { effect: "changed", result_revision_id: createRevision },
        });
      }
      assert.equal(recovered.state.expenses.length, 1);
      const [lunch] = recovered.state.expenses;
      assert.deepEqual(
        [lunch.id, lunch.title, lunch.amount_cents, lunch.currency, lunch.paid_on, lunch.receipt_ids],
        ["fixture-lunch", "午餐", 8635, "CNY", null, []],
      );
      assert.equal(recovered.state.revisionCount, 2);
      assert.equal(recovered.state.receiptCount, 1);
      assert.equal(recovered.state.outboxCount, 1);
      assert.deepEqual(JSON.parse(recovered.state.receipts[0].intent_json).intent, createFixture.command);
      for (const row of [recovered.state.receipts[0], recovered.state.outbox[0]]) {
        assert.deepEqual(
          [row.dataset_id, row.source_device_id, row.operation_id, row.result_revision_id],
          ["fixture-dataset", "fixture-device", "fixture-op-lunch", createRevision],
        );
      }
      assert.equal(recovered.state.pending, null);
      assert.equal(recovered.state.confirmedOp, "fixture-op-lunch");
      assert.equal(recovered.state.confirmedRevisionId, createRevision);

      const advanced = await session.client.tapAndWaitCreateAction("create-advance-head");
      const advancedHead = advanced.state.headRevisionId;
      assert.equal(advanced.result.accepted, true);
      assert.equal(advanced.result.effect, "changed");
      assert.notEqual(advancedHead, createRevision);
      assert.equal(advanced.state.revisionCount, 3);
      assert.equal(advanced.state.receiptCount, 2);
      assert.equal(advanced.state.outboxCount, 2);
      assert.equal(advanced.state.expenses[0].notes, "虚构更正");

      const replayed = await session.client.tapAndWaitCreateAction("create-replay");
      for (const entry of [replayed.replayOriginal, replayed.replayReordered]) {
        assert.deepEqual(entry, {
          accepted: true,
          kind: "committed",
          replayed: true,
          effect: "changed",
          result_revision_id: createRevision,
        });
      }
      assert.equal(replayed.state.headRevisionId, advancedHead);
      assert.equal(replayed.state.revisionCount, 3);
      assert.equal(replayed.state.receiptCount, 2);
      assert.equal(replayed.state.outboxCount, 2);

      const rejections = await session.client.tapAndWaitCreateAction("create-check-rejections");
      assert.deepEqual(rejections.diffAmount, { accepted: false, error: "intent_conflict" });
      assert.deepEqual(rejections.diffShare, { accepted: false, error: "intent_conflict" });
      assert.deepEqual(rejections.staleBaseline, { accepted: false, error: "baseline_conflict" });
      assert.deepEqual(rejections.duplicateEntity, { accepted: false, error: "entity_exists" });
      assert.deepEqual(
        rejections.invalidAmounts.map((item) => [item.amount, item.tsError, item.nativeResult]),
        [
          [0, "integer_range", { accepted: false, error: "integer_range" }],
          [true, "type", { accepted: false, error: "type" }],
          [1.25, "integer_range", { accepted: false, error: "integer_range" }],
          [10000000000, "integer_range", { accepted: false, error: "integer_range" }],
        ],
      );
      assert.equal(rejections.state.headRevisionId, advancedHead);
      assert.equal(rejections.state.revisionCount, 3);
      assert.equal(rejections.state.receiptCount, 2);
      assert.equal(rejections.state.outboxCount, 2);
      assert.equal(rejections.state.expenses.length, 1);

      const auth = await session.client.tapAndWaitCreateAction("create-check-auth");
      assert.equal(auth.results.length, 3);
      for (const item of auth.results) {
        assert.deepEqual(item.response, { accepted: false, error: "denied" });
        assert.equal(Object.hasOwn(item.response, "receipt"), false);
        assert.equal(item.readsAfter, item.readsBefore);
      }
      assert.equal(auth.state.headRevisionId, advancedHead);
      assert.equal(auth.state.revisionCount, 3);
      assert.equal(auth.state.receiptCount, 2);
      assert.equal(auth.state.outboxCount, 2);
      assertCreateRevisions(auth.state.revisions, createRevision, advancedHead);

      // Force-stop and reopen to verify full historical snapshots survive cold restart after replay.
      const pidBeforeReopen = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario} reopen`);
      session = await launchAndAttach(adb, cdpPort, pidBeforeReopen);
      await session.client.setSelect("create-scenario", scenario);
      const reopenedState = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
      assertCreateRevisions(reopenedState.revisions, createRevision, advancedHead);
      assert.deepEqual(reopenedState.expenses, [expectedLunchV2]);
      assert.equal(reopenedState.receiptCount, 2);
      assert.equal(reopenedState.outboxCount, 2);

      report.scenarios[scenario] = {
        pidBefore,
        pidAfter: pidBeforeReopen,
        pidAfterReopen: session.pid,
        operationId: "fixture-op-lunch",
        entityId: "fixture-lunch",
        result_revision_id: createRevision,
        advanced_head_revision_id: advancedHead,
        afterCrash: {
          headRevisionId: afterCrash.headRevisionId,
          expenses: afterCrash.expenses.length,
          revisionCount: afterCrash.revisionCount,
          receiptCount: afterCrash.receiptCount,
          outboxCount: afterCrash.outboxCount,
        },
        recoveredStatus: recovered.status,
        replay_after_head_advance: true,
        fullSnapshotsVerifiedAcrossReopen: true,
        rejections: {
          diffAmount: rejections.diffAmount.error,
          diffShare: rejections.diffShare.error,
          staleBaseline: rejections.staleBaseline.error,
          duplicateEntity: rejections.duplicateEntity.error,
          invalidAmounts: rejections.invalidAmounts.map((item) => [item.amount, item.nativeResult.error]),
          authDeniedZeroReads: true,
        },
        final: {
          headRevisionId: reopenedState.headRevisionId,
          expenses: reopenedState.expenses.length,
          revisionCount: reopenedState.revisionCount,
          receiptCount: reopenedState.receiptCount,
          outboxCount: reopenedState.outboxCount,
        },
      };
    }

    // 10 & 11. 恢复时完整意图核对冲突对照（同键异金额、仅共享票据许可不同）及写入意图一致性校验
    for (const { scenario, diff } of [
      { scenario: "create-conflict-amount", diff: { amount_cents: 8636 } },
      { scenario: "create-conflict-share", diff: { allow_shared_receipts: true } },
    ]) {
      await session.client.setSelect("create-scenario", scenario);
      const staged = await session.client.evaluate(
        `window.__tfP1Bridge.stageCreateRecoveryConflict(${JSON.stringify(scenario)}, ${JSON.stringify(diff)})`,
      );
      assert.equal(staged.committed.accepted, true);
      const committedRev = staged.committed.result_revision_id;
      assertCreateRevisions(staged.state.revisions, committedRev, null);

      const mismatchResult = await session.client.evaluate(
        `window.__tfP1Bridge.submitMismatchedCreateIntent(${JSON.stringify(scenario)})`,
      );
      assert.deepEqual(mismatchResult, { accepted: false, error: "intent_mismatch" });

      // Cold restart before triggering recovery from the TS page.
      const pidBeforeKill = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario}`);
      session = await launchAndAttach(adb, cdpPort, pidBeforeKill);
      await session.client.setSelect("create-scenario", scenario);

      const recovered = await session.client.tapAndWaitCreateAction("create-recover");
      assert.equal(recovered.status, "intent_conflict");
      assert.deepEqual(recovered.lookup, { accepted: false, error: "intent_conflict" });
      assert.equal(recovered.state.pending?.operationId, "fixture-op-lunch");
      assert.equal(recovered.state.pending?.canonicalIntentJson, staged.conflictingCanon);
      assert.equal(recovered.state.confirmedOp, null);
      assert.equal(recovered.state.confirmedRevisionId, null);
      assert.equal(recovered.state.headRevisionId, committedRev);
      assert.equal(recovered.state.revisionCount, 2);
      assert.equal(recovered.state.receiptCount, 1);
      assert.equal(recovered.state.outboxCount, 1);
      assert.deepEqual(recovered.state.expenses, [expectedLunchV1]);
      assertCreateRevisions(recovered.state.revisions, committedRev, null);

      report.scenarios[scenario] = {
        pidBeforeKill,
        pidAfterReopen: session.pid,
        diff,
        committedRevisionId: committedRev,
        writeMismatchError: mismatchResult.error,
        recoverStatus: recovered.status,
        pendingPreserved: true,
        confirmedOp: recovered.state.confirmedOp,
        final: {
          headRevisionId: recovered.state.headRevisionId,
          expenses: recovered.state.expenses.length,
          revisionCount: recovered.state.revisionCount,
          receiptCount: recovered.state.receiptCount,
          outboxCount: recovered.state.outboxCount,
        },
      };
    }

    // 12. create-boundary-fields-scope: 核对当前可交换字段范围、写入前虚构身份及目标旅行／分支作用域
    {
      const scenario = "create-boundary-fields-scope";
      await session.client.setSelect("create-scenario", scenario);
      const res = await session.client.evaluate(`window.__tfP1Bridge.runCreateBoundaryFieldsAndScope()`);

      const expectedFieldErrors = {
        paid_on: "unsupported_capability",
        day: "unsupported_capability",
        activity_id: "unsupported_capability",
        receipt_ids: "unsupported_capability",
        budget_item_id: "unsupported_capability",
        settles_budget: "invalid_field",
        category: "invalid_field",
        currency: "unsupported_capability",
      };
      for (const item of res.fieldCases) {
        assert.deepEqual(item.result, { accepted: false, error: expectedFieldErrors[item.label] }, `Field ${item.label}`);
      }
      for (const item of res.identityCases) {
        assert.deepEqual(item.result, { accepted: false, error: "denied" }, `Identity ${item.label}`);
      }
      for (const item of res.scopeCases) {
        assert.deepEqual(item.result, { accepted: false, error: "scope_mismatch" }, `Scope ${item.label}`);
      }
      assert.equal(res.stateAfterRejections.headRevisionId, "fixture-r0");
      assert.equal(res.stateAfterRejections.expenseCount, 0);
      assert.equal(res.stateAfterRejections.revisionCount, 1);
      assert.equal(res.stateAfterRejections.receiptCount, 0);
      assert.equal(res.stateAfterRejections.outboxCount, 0);

      assert.equal(res.validCommit.accepted, true);
      assert.equal(res.stateAfterValid.expenseCount, 1);
      assert.equal(res.stateAfterValid.revisionCount, 2);
      assert.equal(res.stateAfterValid.receiptCount, 1);
      assert.equal(res.stateAfterValid.outboxCount, 1);
      assertCreateRevisions(res.stateAfterValid.revisions, res.validCommit.result_revision_id, null);

      for (const item of res.usedCreateScopeCases) {
        assert.deepEqual(item.result, { accepted: false, error: "scope_mismatch" }, `Used create scope ${item.label}`);
      }
      for (const item of res.newPatchScopeCases) {
        assert.deepEqual(item.result, { accepted: false, error: "scope_mismatch" }, `New patch scope ${item.label}`);
      }
      assert.equal(res.validNotesPatch.accepted, true);
      for (const item of res.usedPatchScopeCases) {
        assert.deepEqual(item.result, { accepted: false, error: "scope_mismatch" }, `Used patch scope ${item.label}`);
      }
      assert.equal(res.stateFinal.expenseCount, 1);
      assert.equal(res.stateFinal.totalCents, 8635);
      assert.equal(res.stateFinal.revisionCount, 3);
      assert.equal(res.stateFinal.receiptCount, 2);
      assert.equal(res.stateFinal.outboxCount, 2);
      assertCreateRevisions(res.stateFinal.revisions, res.validCommit.result_revision_id, res.validNotesPatch.result_revision_id);

      report.scenarios[scenario] = {
        fieldRejections: Object.fromEntries(res.fieldCases.map((item) => [item.label, item.result.error])),
        identityRejections: Object.fromEntries(res.identityCases.map((item) => [item.label, item.result.error])),
        scopeRejections: Object.fromEntries([
          ...res.scopeCases,
          ...res.usedCreateScopeCases,
          ...res.newPatchScopeCases,
          ...res.usedPatchScopeCases,
        ].map((item) => [item.label, item.result.error])),
        zeroWritesAfterAllRejections: true,
        validCommitRevisionId: res.validCommit.result_revision_id,
        validNotesPatchRevisionId: res.validNotesPatch.result_revision_id,
        final: {
          expenseCount: res.stateFinal.expenseCount,
          totalCents: res.stateFinal.totalCents,
          revisionCount: res.stateFinal.revisionCount,
          receiptCount: res.stateFinal.receiptCount,
          outboxCount: res.stateFinal.outboxCount,
        },
      };
    }

    // 13 & 14. 20→21 与 1999→2000：冷重开后独立核对页面笔数、总额、分页明细与逐版完整历史快照摘要，再核对拒绝与重放零改账
    for (const { scenario, initialCount, initialRevisionId, expectCapReject } of [
      { scenario: "create-boundary-over-20", initialCount: 20, initialRevisionId: "fixture-r20", expectCapReject: false },
      { scenario: "create-boundary-cap-2000", initialCount: 1999, initialRevisionId: "fixture-r1999", expectCapReject: true },
    ]) {
      const targetCount = initialCount + 1;
      const expectedInitialCents = initialCount * 100;
      const expectedFinalCents = expectedInitialCents + 8635;
      const initialList = Array.from({ length: initialCount }, (_, i) => buildSeedExpense(i + 1));
      const finalList = [expectedLunchV1, ...initialList]; // "fixture-lunch" sorts before "fixture-seed-0001"
      const expectedInitSha = snapshotSha256(initialList);
      const expectedFinalSha = snapshotSha256(finalList);

      await session.client.setSelect("create-scenario", scenario);
      const created = await session.client.evaluate(
        `window.__tfP1Bridge.seedAndCommitCreateCount(${JSON.stringify(scenario)}, ${initialCount}, ${JSON.stringify(initialRevisionId)})`,
      );
      assert.equal(created.seeded.expenseCount, initialCount);
      assert.equal(created.seeded.totalCents, expectedInitialCents);
      assert.equal(created.commitNext.accepted, true);
      assert.equal(created.commitNext.replayed, false);
      const committedRev = created.commitNext.result_revision_id;
      assert.equal(created.stateAfterCommit.expenseCount, targetCount);
      assert.equal(created.stateAfterCommit.totalCents, expectedFinalCents);

      // Cold restart before independent page, pagination, and per-revision snapshot verification.
      const pidBeforeKill = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario}`);
      session = await launchAndAttach(adb, cdpPort, pidBeforeKill);
      await session.client.setSelect("create-scenario", scenario);

      const ledgerText = await session.client.evaluate(`document.getElementById('create-ledger').textContent`);
      const formattedYuan = (expectedFinalCents / 100).toFixed(2);
      assert.ok(ledgerText.includes(`消费 ${targetCount} 笔`), `Unexpected ledger count text: ${ledgerText}`);
      assert.ok(ledgerText.includes(`合计 ¥${formattedYuan}`), `Unexpected ledger total text: ${ledgerText}`);

      const reopened = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)}, 0, 20)`);
      assert.equal(reopened.expenseCount, targetCount);
      assert.equal(reopened.totalCents, expectedFinalCents);
      assert.equal(reopened.expenses.length, 20);
      assert.equal(reopened.hasMoreExpenses, true);
      assert.deepEqual(reopened.expenses[0], expectedLunchV1);
      assert.equal(reopened.revisions.length, 2);
      assert.equal(reopened.revisions[0].revision_id, initialRevisionId);
      assert.equal(reopened.revisions[0].expense_count, initialCount);
      assert.equal(reopened.revisions[0].total_cents, expectedInitialCents);
      assert.equal(reopened.revisions[0].snapshot_sha256, expectedInitSha);
      assert.equal(reopened.revisions[1].revision_id, committedRev);
      assert.equal(reopened.revisions[1].parent_revision_id, initialRevisionId);
      assert.equal(reopened.revisions[1].expense_count, targetCount);
      assert.equal(reopened.revisions[1].total_cents, expectedFinalCents);
      assert.equal(reopened.revisions[1].snapshot_sha256, expectedFinalSha);

      // Verify UI pagination controls via real CDP touch on 20->21.
      if (!expectCapReject) {
        const page2 = await session.client.tapAndWaitCreateAction("create-page-next");
        assert.equal(page2.state.pageOffset, 20);
        assert.equal(page2.state.expenses.length, 1);
        assert.equal(page2.state.hasMoreExpenses, false);
        assert.deepEqual(page2.state.expenses[0], buildSeedExpense(20));
        const page1 = await session.client.tapAndWaitCreateAction("create-page-prev");
        assert.equal(page1.state.pageOffset, 0);
        assert.equal(page1.state.expenses.length, 20);
        assert.equal(page1.state.hasMoreExpenses, true);
      }

      // Independently reconstruct paginated historical records from both revisions.
      const rev0LastPage = await session.client.evaluate(
        `window.__tfP1Bridge.readCreateRevisionPage(${JSON.stringify(scenario)}, ${JSON.stringify(initialRevisionId)}, ${initialCount - 1}, 20)`,
      );
      assert.equal(rev0LastPage.accepted, true);
      assert.equal(rev0LastPage.expense_count, initialCount);
      assert.equal(rev0LastPage.total_cents, expectedInitialCents);
      assert.equal(rev0LastPage.snapshot_sha256, expectedInitSha);
      assert.deepEqual(rev0LastPage.expenses, [buildSeedExpense(initialCount)]);

      const rev1FirstPage = await session.client.evaluate(
        `window.__tfP1Bridge.readCreateRevisionPage(${JSON.stringify(scenario)}, ${JSON.stringify(committedRev)}, 0, 20)`,
      );
      assert.equal(rev1FirstPage.accepted, true);
      assert.equal(rev1FirstPage.expense_count, targetCount);
      assert.equal(rev1FirstPage.total_cents, expectedFinalCents);
      assert.equal(rev1FirstPage.snapshot_sha256, expectedFinalSha);
      assert.deepEqual(rev1FirstPage.expenses[0], expectedLunchV1);

      const rev1LastPage = await session.client.evaluate(
        `window.__tfP1Bridge.readCreateRevisionPage(${JSON.stringify(scenario)}, ${JSON.stringify(committedRev)}, ${targetCount - 1}, 20)`,
      );
      assert.equal(rev1LastPage.accepted, true);
      assert.deepEqual(rev1LastPage.expenses, [buildSeedExpense(initialCount)]);

      // Verify rejections and replays do not mutate ledger, totals, or revision digests.
      const guards = await session.client.evaluate(
        `window.__tfP1Bridge.checkCreatePostRestartGuards(${JSON.stringify(scenario)}, ${JSON.stringify(initialRevisionId)}, ${JSON.stringify(committedRev)}, ${expectCapReject})`,
      );
      assert.deepEqual(guards.rejectNew, {
        accepted: false,
        error: expectCapReject ? "expense_count" : "entity_exists",
      });
      for (const replay of [guards.replayOriginal, guards.replayReordered]) {
        assert.deepEqual(replay, {
          accepted: true,
          kind: "committed",
          replayed: true,
          effect: "changed",
          result_revision_id: committedRev,
        });
      }
      assert.deepEqual(guards.conflictResult, { accepted: false, error: "intent_conflict" });
      assert.equal(guards.stateFinal.headRevisionId, committedRev);
      assert.equal(guards.stateFinal.expenseCount, targetCount);
      assert.equal(guards.stateFinal.totalCents, expectedFinalCents);
      assert.equal(guards.stateFinal.revisionCount, 2);
      assert.equal(guards.stateFinal.receiptCount, 1);
      assert.equal(guards.stateFinal.outboxCount, 1);
      assert.equal(guards.stateFinal.revisions[0].snapshot_sha256, expectedInitSha);
      assert.equal(guards.stateFinal.revisions[1].snapshot_sha256, expectedFinalSha);

      report.scenarios[scenario] = {
        pidBeforeKill,
        pidAfterReopen: session.pid,
        seededCount: initialCount,
        committedRev,
        pageLedgerText: ledgerText,
        rev0Sha256: expectedInitSha,
        rev1Sha256: expectedFinalSha,
        rejectNewError: guards.rejectNew.error,
        replayOriginalReplayed: guards.replayOriginal.replayed,
        replayReorderedReplayed: guards.replayReordered.replayed,
        conflictError: guards.conflictResult.error,
        final: {
          headRevisionId: guards.stateFinal.headRevisionId,
          expenseCount: guards.stateFinal.expenseCount,
          totalCents: guards.stateFinal.totalCents,
          revisionCount: guards.stateFinal.revisionCount,
          receiptCount: guards.stateFinal.receiptCount,
          outboxCount: guards.stateFinal.outboxCount,
        },
      };
    }

    // 15. EC10: 付款日 2026-11-23 能力不匹配，提交后强停重开仍保留完整待发送输入，不入账、不显示已同步、不自动删日期
    for (const scenario of ["create-pending-ec10", "create-pending-ec10-saved"]) {
      const expectedEc10Command = {
        ...createFixture.command,
        payload: { ...createFixture.command.payload, paid_on: "2026-11-23" },
      };
      await session.client.setSelect("create-scenario", scenario);
      const seeded = await session.client.tapAndWaitCreateAction("create-seed");
      assert.equal(seeded.state.expenseCount, 0);
      assert.equal(seeded.state.headRevisionId, "fixture-r0");

      await session.client.setSelect("create-fault-mode", "none");
      await session.client.setInput("create-paid-on", "2026-11-23");
      const savedBeforeSend = scenario === "create-pending-ec10-saved";
      if (savedBeforeSend) {
        const prepared = await session.client.tapAndWaitCreateAction("create-prepare-pending");
        assert.equal(prepared.pending.recoveryState, "pending_unsent");
        const oldPid = session.pid;
        session.client.close();
        adb("shell", "am", "force-stop", PACKAGE);
        await waitForPid(adb, (p) => p === null, "cold start before first send");
        session = await launchAndAttach(adb, cdpPort, oldPid);
        await session.client.setSelect("create-scenario", scenario);
      }
      const submitted = await session.client.tapAndWaitCreateAction(savedBeforeSend ? "create-recover" : "create-submit");
      assert.equal(submitted.status, "unsupported_capability");
      assert.deepEqual(submitted.result, { accepted: false, error: "unsupported_capability" });
      assert.equal(submitted.state.expenseCount, 0);
      assert.equal(submitted.state.totalCents, 0);
      assert.equal(submitted.state.revisionCount, 1);
      assert.equal(submitted.state.receiptCount, 0);
      assert.equal(submitted.state.outboxCount, 0);
      assert.equal(submitted.state.confirmedOp, null);
      assert.ok(submitted.state.pending);
      const savedSha256 = submitted.state.pending.intentSha256;
      assert.equal(
        savedSha256,
        createHash("sha256").update(submitted.state.pending.canonicalIntentJson, "utf8").digest("hex"),
      );

      // Manual lookup on a blocked_unsupported_capability record must NOT overwrite the block reason.
      const manualLookup = await session.client.tapAndWaitCreateAction("create-lookup-only");
      assert.equal(manualLookup.status, "not_found_at_settled_read");
      assert.equal(manualLookup.lookup.state, "not_found_at_settled_read");
      assert.equal(manualLookup.state.pending?.recoveryState, "blocked_unsupported_capability");
      assert.equal(manualLookup.state.pending?.lastError, "unsupported_capability");
      assert.equal(manualLookup.state.expenseCount, 0);

      // Mark JS-only memory before force-stop; cold restart must wipe JS memory while preserving native pending storage.
      await session.client.evaluate(`window.__tfJsMemoryOnlySentinel = "ec10-before-stop";`);
      const pidBeforeStop = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario}`);

      session = await launchAndAttach(adb, cdpPort, pidBeforeStop);
      const jsMemorySurvived = await session.client.evaluate(`window.__tfJsMemoryOnlySentinel !== undefined`);
      assert.equal(jsMemorySurvived, false, "Cold restart must wipe JS memory; recovery cannot rely on JS heap");

      await session.client.setSelect("create-scenario", scenario);
      const reopened = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
      const pageLedgerAfterStop = await session.client.evaluate(`document.getElementById('create-ledger').textContent`);
      const pagePendingAfterStop = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);

      assert.ok(reopened.pending, "Persisted pending command missing after cold restart");
      assert.equal(reopened.pending.operationId, "fixture-op-lunch");
      assert.equal(reopened.pending.datasetId, "fixture-dataset");
      assert.equal(reopened.pending.sourceDeviceId, "fixture-device");
      assert.equal(reopened.pending.expectedRevisionId, "fixture-r0");
      assert.equal(reopened.pending.recoveryState, "blocked_unsupported_capability");
      assert.equal(reopened.pending.lastError, "unsupported_capability");
      assert.equal(reopened.pending.intentSha256, savedSha256);
      assert.deepEqual(JSON.parse(reopened.pending.rawCommandJson), expectedEc10Command);
      assert.deepEqual(JSON.parse(reopened.pending.canonicalIntentJson).intent, expectedEc10Command);
      assert.equal(reopened.confirmedOp, null);
      assert.equal(reopened.headRevisionId, "fixture-r0");
      assert.equal(reopened.expenseCount, 0);
      assert.equal(reopened.totalCents, 0);
      assert.equal(reopened.revisionCount, 1);
      assert.equal(reopened.receiptCount, 0);
      assert.equal(reopened.outboxCount, 0);
      assert.ok(pagePendingAfterStop.includes("本机待发送（未发送／未入账）"), pagePendingAfterStop);
      assert.ok(pagePendingAfterStop.includes("2026-11-23"), pagePendingAfterStop);
      assert.ok(pagePendingAfterStop.includes("blocked_unsupported_capability"), pagePendingAfterStop);
      assert.ok(!pagePendingAfterStop.includes("已确认入账"), pagePendingAfterStop);

      // Triggering recover must NOT strip paid_on or auto-resend.
      const recoverAttempt = await session.client.tapAndWaitCreateAction("create-recover");
      assert.equal(recoverAttempt.status, "blocked_unsupported_capability");
      assert.equal(recoverAttempt.state.expenseCount, 0);
      assert.equal(recoverAttempt.state.receiptCount, 0);
      assert.equal(recoverAttempt.state.outboxCount, 0);
      assert.deepEqual(JSON.parse(recoverAttempt.state.pending.rawCommandJson), expectedEc10Command);

      report.scenarios[scenario] = {
        pidBeforeStop,
        pidAfterReopen: session.pid,
        jsMemoryWipedOnColdStart: !jsMemorySurvived,
        manualLookupPreservedBlock: true,
        operationId: reopened.pending.operationId,
        intentSha256: savedSha256,
        restoredPaidOn: JSON.parse(reopened.pending.rawCommandJson).payload.paid_on,
        restoredAmountCents: JSON.parse(reopened.pending.rawCommandJson).payload.amount_cents,
        restoredBaseline: reopened.pending.expectedRevisionId,
        recoverAttemptStatus: recoverAttempt.status,
        pageLedgerText: pageLedgerAfterStop,
        pagePendingText: pagePendingAfterStop,
        final: {
          headRevisionId: recoverAttempt.state.headRevisionId,
          expenseCount: recoverAttempt.state.expenseCount,
          totalCents: recoverAttempt.state.totalCents,
          revisionCount: recoverAttempt.state.revisionCount,
          receiptCount: recoverAttempt.state.receiptCount,
          outboxCount: recoverAttempt.state.outboxCount,
        },
      };
    }

    // 16. EC07: 8635 分可交换午餐，依次在写锁忙、稳定缺失、提交后丢应答三处强停重开并按状态恢复确认
    {
      const scenario = "create-pending-ec07";
      const expectedLunchSha256 = "e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd";
      const steps = [];

      await session.client.setSelect("create-scenario", scenario);
      const seeded = await session.client.tapAndWaitCreateAction("create-seed");
      assert.equal(seeded.state.expenseCount, 0);
      await session.client.setInput("create-paid-on", "");
      await session.client.setSelect("create-fault-mode", "none");

      const prepared = await session.client.tapAndWaitCreateAction("create-prepare-pending");
      assert.equal(prepared.pending.operationId, "fixture-op-lunch");
      assert.equal(prepared.pending.intentSha256, expectedLunchSha256);

      // Step 1: Write lock held by separate :writer process -> pending_busy -> force-stop -> cold reopen.
      const lockInfo = await session.client.evaluate(`window.__tfP1Bridge.holdCreateWriterLock(${JSON.stringify(scenario)})`);
      assert.notEqual(lockInfo.writerPid, lockInfo.callerPid);
      let busyOutcome;
      try {
        busyOutcome = await session.client.tapAndWaitCreateAction("create-recover");
      } finally {
        await session.client.evaluate(`window.__tfP1Bridge.releaseCreateWriterLock(${JSON.stringify(scenario)})`);
      }
      assert.equal(busyOutcome.status, "pending_busy");
      assert.equal(busyOutcome.lookup.state, "pending_busy");
      assert.equal(busyOutcome.state.expenseCount, 0);
      assert.equal(busyOutcome.state.pending?.recoveryState, "pending_busy");

      await session.client.evaluate(`window.__tfJsMemoryOnlySentinel = "ec07-after-busy";`);
      const pidAfterBusy = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario} busy`);
      session = await launchAndAttach(adb, cdpPort, pidAfterBusy);
      assert.equal(await session.client.evaluate(`window.__tfJsMemoryOnlySentinel !== undefined`), false);
      await session.client.setSelect("create-scenario", scenario);
      const stateAfterBusyReopen = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
      const ledgerBusy = await session.client.evaluate(`document.getElementById('create-ledger').textContent`);
      const pendingBusy = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);
      assert.equal(stateAfterBusyReopen.pending?.operationId, "fixture-op-lunch");
      assert.equal(stateAfterBusyReopen.pending?.intentSha256, expectedLunchSha256);
      assert.equal(stateAfterBusyReopen.pending?.recoveryState, "pending_busy");
      assert.equal(stateAfterBusyReopen.expenseCount, 0);
      assert.equal(stateAfterBusyReopen.totalCents, 0);
      assert.equal(stateAfterBusyReopen.receiptCount, 0);
      assert.equal(stateAfterBusyReopen.outboxCount, 0);
      assert.ok(pendingBusy.includes("提交结果待核实（未确认）"), pendingBusy);
      assert.ok(pendingBusy.includes("pending_busy"), pendingBusy);
      steps.push({
        step: "after_write_lock_busy_reopen",
        callerPid: session.pid,
        writerPid: lockInfo.writerPid,
        operationId: stateAfterBusyReopen.pending.operationId,
        intentSha256: stateAfterBusyReopen.pending.intentSha256,
        receiverTotalCents: stateAfterBusyReopen.totalCents,
        receiptCount: stateAfterBusyReopen.receiptCount,
        outboxCount: stateAfterBusyReopen.outboxCount,
        pageLedgerText: ledgerBusy,
        pagePendingText: pendingBusy,
      });

      // Step 2: Settled lookup returns not_found_at_settled_read -> force-stop -> cold reopen.
      const settledLookup = await session.client.tapAndWaitCreateAction("create-lookup-only");
      assert.equal(settledLookup.status, "not_found_at_settled_read");
      assert.equal(settledLookup.lookup.state, "not_found_at_settled_read");
      assert.equal(settledLookup.state.pending?.recoveryState, "pending_not_found");
      assert.equal(settledLookup.state.expenseCount, 0);

      await session.client.evaluate(`window.__tfJsMemoryOnlySentinel = "ec07-after-not-found";`);
      const pidAfterNotFound = session.pid;
      session.client.close();
      adb("shell", "am", "force-stop", PACKAGE);
      await waitForPid(adb, (p) => p === null, `force-stop ${scenario} not-found`);
      session = await launchAndAttach(adb, cdpPort, pidAfterNotFound);
      assert.equal(await session.client.evaluate(`window.__tfJsMemoryOnlySentinel !== undefined`), false);
      await session.client.setSelect("create-scenario", scenario);
      const stateAfterNotFoundReopen = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
      const ledgerNotFound = await session.client.evaluate(`document.getElementById('create-ledger').textContent`);
      const pendingNotFound = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);
      assert.equal(stateAfterNotFoundReopen.pending?.operationId, "fixture-op-lunch");
      assert.equal(stateAfterNotFoundReopen.pending?.intentSha256, expectedLunchSha256);
      assert.equal(stateAfterNotFoundReopen.pending?.recoveryState, "pending_not_found");
      assert.equal(stateAfterNotFoundReopen.expenseCount, 0);
      assert.equal(stateAfterNotFoundReopen.totalCents, 0);
      assert.ok(pendingNotFound.includes("本机待发送（未发送／未入账）"), pendingNotFound);
      assert.ok(pendingNotFound.includes("pending_not_found"), pendingNotFound);
      steps.push({
        step: "after_settled_not_found_reopen",
        callerPid: session.pid,
        operationId: stateAfterNotFoundReopen.pending.operationId,
        intentSha256: stateAfterNotFoundReopen.pending.intentSha256,
        receiverTotalCents: stateAfterNotFoundReopen.totalCents,
        receiptCount: stateAfterNotFoundReopen.receiptCount,
        outboxCount: stateAfterNotFoundReopen.outboxCount,
        pageLedgerText: ledgerNotFound,
        pagePendingText: pendingNotFound,
      });

      // Step 3: Retry with original intent under after_commit_drop_reply -> process dies -> cold reopen -> recover & confirm.
      await session.client.setSelect("create-fault-mode", "after_commit_drop_reply");
      await session.client.evaluate(`window.__tfJsMemoryOnlySentinel = "ec07-before-drop-reply";`);
      const pidBeforeDrop = session.pid;
      await session.client.tap("create-recover", { expectDeath: true });
      await waitForPid(adb, (p) => p === null || p !== pidBeforeDrop, `${scenario} drop-reply crash`);
      session.client.close();

      session = await launchAndAttach(adb, cdpPort, pidBeforeDrop);
      assert.equal(await session.client.evaluate(`window.__tfJsMemoryOnlySentinel !== undefined`), false);
      await session.client.setSelect("create-scenario", scenario);
      const stateAfterDropReopen = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
      const ledgerDrop = await session.client.evaluate(`document.getElementById('create-ledger').textContent`);
      const pendingDrop = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);
      assert.equal(stateAfterDropReopen.pending?.operationId, "fixture-op-lunch");
      assert.equal(stateAfterDropReopen.pending?.intentSha256, expectedLunchSha256);
      assert.equal(stateAfterDropReopen.pending?.recoveryState, "pending_verification");
      assert.equal(stateAfterDropReopen.confirmedOp, null);
      assert.equal(stateAfterDropReopen.expenseCount, 1);
      assert.equal(stateAfterDropReopen.totalCents, 8635);
      assert.equal(stateAfterDropReopen.revisionCount, 2);
      assert.equal(stateAfterDropReopen.receiptCount, 1);
      assert.equal(stateAfterDropReopen.outboxCount, 1);
      assert.ok(pendingDrop.includes("提交结果待核实（未确认）"), pendingDrop);
      assert.ok(pendingDrop.includes("pending_verification"), pendingDrop);
      assert.ok(!pendingDrop.includes("pending_not_found"), pendingDrop);
      assert.ok(!pendingDrop.includes("已确认入账"), pendingDrop);
      steps.push({
        step: "after_commit_drop_reply_reopen",
        callerPid: session.pid,
        operationId: stateAfterDropReopen.pending.operationId,
        intentSha256: stateAfterDropReopen.pending.intentSha256,
        receiverTotalCents: stateAfterDropReopen.totalCents,
        receiptCount: stateAfterDropReopen.receiptCount,
        outboxCount: stateAfterDropReopen.outboxCount,
        pageLedgerText: ledgerDrop,
        pagePendingText: pendingDrop,
      });

      await session.client.setSelect("create-fault-mode", "none");
      const confirmed = await session.client.tapAndWaitCreateAction("create-recover");
      const committedRev = confirmed.state.headRevisionId;
      assert.equal(confirmed.status, "confirmed_existing");
      assert.deepEqual(confirmed.lookup, {
        accepted: true,
        state: "committed",
        receipt: { effect: "changed", result_revision_id: committedRev },
      });
      assert.equal(confirmed.state.pending, null);
      assert.equal(confirmed.state.confirmedOp, "fixture-op-lunch");
      assert.equal(confirmed.state.confirmedRevisionId, committedRev);
      assert.equal(confirmed.state.expenseCount, 1);
      assert.equal(confirmed.state.totalCents, 8635);
      assert.equal(confirmed.state.revisionCount, 2);
      assert.equal(confirmed.state.receiptCount, 1);
      assert.equal(confirmed.state.outboxCount, 1);
      assertCreateRevisions(confirmed.state.revisions, committedRev, null);
      const ledgerConfirmed = await session.client.evaluate(`document.getElementById('create-ledger').textContent`);
      const pendingConfirmed = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);
      assert.ok(pendingConfirmed.includes("已确认入账"), pendingConfirmed);
      steps.push({
        step: "confirmed_after_matching_intent_and_revision",
        callerPid: session.pid,
        operationId: confirmed.state.confirmedOp,
        intentSha256: expectedLunchSha256,
        committedRevisionId: committedRev,
        receiverTotalCents: confirmed.state.totalCents,
        receiptCount: confirmed.state.receiptCount,
        outboxCount: confirmed.state.outboxCount,
        pageLedgerText: ledgerConfirmed,
        pagePendingText: pendingConfirmed,
      });

      report.scenarios[scenario] = {
        committedRevisionId: committedRev,
        steps,
        final: {
          headRevisionId: committedRev,
          expenseCount: confirmed.state.expenseCount,
          totalCents: confirmed.state.totalCents,
          revisionCount: confirmed.state.revisionCount,
          receiptCount: confirmed.state.receiptCount,
          outboxCount: confirmed.state.outboxCount,
          confirmedOp: confirmed.state.confirmedOp,
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
      let report;
      if (opts.desktopVectors) {
        const { checkVectorGaps } = await import("./check-p1-vector-gaps.mjs");
        const { client } = await launchAndAttach(adb, opts.cdpPort);
        try { report = await checkVectorGaps(opts.desktopVectors, { client, adb }); }
        finally { client.close(); }
      } else {
        report = await runScenarios(adb, opts.cdpPort);
      }
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
