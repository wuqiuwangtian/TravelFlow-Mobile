// 保留应用数据升级回归：从旧提交（默认 131b848）安装旧 APK 制造提交前／后中断，覆盖安装新 APK 后验证恢复。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const EXPECTED_LUNCH_SHA256 = "e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd";

function parseArgs(argv) {
  const opts = { serial: null, cdpPort: 19240, baseRef: "131b848", oldApk: null, newApk: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--serial") opts.serial = argv[++i] ?? null;
    else if (arg === "--cdp-port") opts.cdpPort = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--base-ref") opts.baseRef = argv[++i] ?? "131b848";
    else if (arg === "--old-apk") opts.oldApk = argv[++i] ?? null;
    else if (arg === "--new-apk") opts.newApk = argv[++i] ?? null;
    else throw new Error("Usage: check-p1-bridge-upgrade.mjs --serial emulator-5580 [--cdp-port 19240] [--base-ref 131b848] [--old-apk PATH] [--new-apk PATH]");
  }
  assert.match(opts.serial ?? "", /^emulator-\d+$/, "Expected explicit --serial emulator-N");
  assert.ok(Number.isInteger(opts.cdpPort) && opts.cdpPort >= 1024 && opts.cdpPort <= 65535, "Invalid --cdp-port");
  return opts;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 240000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function buildApkFromRepoDir(repoDir, outProjectDir) {
  const androidHome = process.env.ANDROID_HOME;
  const javaHome = process.env.JAVA_HOME;
  assert.ok(androidHome && javaHome, "ANDROID_HOME and JAVA_HOME must be set");
  run(process.execPath, [path.join(repoDir, "scripts/prepare-p1-bridge-receipt.mjs"), "--output", outProjectDir], {
    cwd: repoDir,
  });
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  run(gradlew, [":app:assembleDebug", "--no-daemon", "--console=plain"], {
    cwd: path.join(outProjectDir, "android"),
    env: {
      ...process.env,
      ANDROID_HOME: androidHome,
      JAVA_HOME: javaHome,
      PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const apk = path.join(outProjectDir, "android/app/build/outputs/apk/debug/app-debug.apk");
  assert.ok(existsSync(apk), `Missing built APK: ${apk}`);
  return apk;
}

function buildBaseRefApk(baseRef, tmpDir) {
  const baseRepo = path.join(tmpDir, "base-repo");
  mkdirSync(baseRepo, { recursive: true });
  const archive = spawnSync("git", ["-C", root, "archive", baseRef], { maxBuffer: 64 * 1024 * 1024 });
  if (archive.error || archive.status !== 0) {
    throw new Error(`git archive ${baseRef} failed: ${archive.stderr?.toString() ?? archive.error}`);
  }
  const untar = spawnSync("tar", ["-x", "-C", baseRepo], { input: archive.stdout });
  if (untar.error || untar.status !== 0) {
    throw new Error(`tar extract failed: ${untar.stderr?.toString() ?? untar.error}`);
  }
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: baseRepo });
  return buildApkFromRepoDir(baseRepo, path.join(tmpDir, "old-app"));
}

function createAdb(adbPath, serial) {
  const fn = (...args) => run(adbPath, ["-s", serial, ...args], { timeout: 60000 });
  fn.serial = serial;
  fn.adbPath = adbPath;
  return fn;
}

function pidOf(adb) {
  const res = spawnSync(adb.adbPath, ["-s", adb.serial, "shell", "pidof", PACKAGE], { encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) return null;
  const first = (res.stdout ?? "").trim().split(/\s+/).filter(Boolean)[0];
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
    } catch {}
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
    const receipt = JSON.stringify(`__tfUpgradeTap_${crypto.randomUUID()}`);
    try {
      const point = await evaluate(`(async () => {
        const button = document.getElementById(${JSON.stringify(id)});
        if (!button || button.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(id)});
        button.scrollIntoView({block: 'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = button.getBoundingClientRect();
        const viewport = window.visualViewport;
        const point = {
          x: box.x + box.width / 2 - (viewport ? viewport.offsetLeft : 0),
          y: box.y + box.height / 2 - (viewport ? viewport.offsetTop : 0),
        };
        const listener = event => {
          window[${receipt}].clicked = { trusted: event.isTrusted, expected: event.target === button || button.contains(event.target) };
        };
        window[${receipt}] = { listener, clicked: null };
        document.addEventListener('click', listener, { capture: true, once: true });
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
      assert.ok(clicked.trusted && clicked.expected, `Touch missed ${id}`);
    } finally {
      if (!closed) {
        try {
          await evaluate(`(() => {
            const r = window[${receipt}];
            if (!r) return;
            document.removeEventListener('click', r.listener, true);
            delete window[${receipt}];
          })()`);
        } catch {
          if (!expectDeath) throw new Error("Failed cleaning tap listener");
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
    await until(`!document.getElementById('create-seed').disabled`);
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
    tapAndWaitCreateAction,
    close: () => {
      try { ws.close(); } catch {}
    },
  };
}

async function launchAndAttach(adb, cdpPort, previousPid = null) {
  try { adb("forward", "--remove", `tcp:${cdpPort}`); } catch {}
  adb("shell", "am", "start", "-W", "-n", ACTIVITY);
  const pid = await waitForPid(adb, (p) => p !== null && p !== previousPid, "new app process");
  adb("forward", `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`);
  const client = await connectWebView(cdpPort);
  await client.until(`document.getElementById('runtime')?.textContent?.includes('Android原生桥已就绪')`);
  await client.until(`!document.getElementById('create-seed').disabled`);
  return { pid, client };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const androidHome = process.env.ANDROID_HOME;
  assert.ok(androidHome, "ANDROID_HOME must be set");
  const adb = createAdb(path.join(androidHome, "platform-tools/adb"), opts.serial);
  assert.equal(adb("shell", "getprop", "ro.boot.qemu.avd_name"), EXPECTED_AVD, `Expected AVD ${EXPECTED_AVD}`);
  assert.equal(adb("shell", "getprop", "ro.build.version.sdk"), "35", "Expected API 35");
  assert.equal(adb("shell", "getprop", "sys.boot_completed"), "1", "AVD is not booted");

  const installed = adb("shell", "pm", "list", "packages", "-u", PACKAGE).split(/\r?\n/);
  assert.ok(!installed.includes(`package:${PACKAGE}`), `Existing ${PACKAGE} detected; refusing replacement`);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "travelflow-p1-upgrade-"));
  try {
    const oldApk = opts.oldApk ? path.resolve(opts.oldApk) : buildBaseRefApk(opts.baseRef, tmpDir);
    const newApk = opts.newApk ? path.resolve(opts.newApk) : buildApkFromRepoDir(root, path.join(tmpDir, "new-app"));

    assert.ok(adb("install", "-t", oldApk).includes("Success"), "Old APK install failed");
    try {
      // Phase 1: Under old APK (131b848), create both before-commit and after-commit legacy pending records.
      let session = await launchAndAttach(adb, opts.cdpPort);
      for (const { scenario, faultMode } of [
        { scenario: "create-before-commit", faultMode: "before_commit" },
        { scenario: "create-after-commit", faultMode: "after_commit_drop_reply" },
      ]) {
        await session.client.setSelect("create-scenario", scenario);
        await session.client.tapAndWaitCreateAction("create-seed");
        await session.client.setSelect("create-fault-mode", faultMode);
        const pidBefore = session.pid;
        await session.client.tap("create-submit", { expectDeath: true });
        await waitForPid(adb, (p) => p === null || p !== pidBefore, `old APK ${scenario} crash`);
        session.client.close();
        if (scenario === "create-before-commit") {
          session = await launchAndAttach(adb, opts.cdpPort, pidBefore);
        }
      }

      // Phase 2: In-place upgrade preserving app data!
      assert.ok(adb("install", "-r", "-t", newApk).includes("Success"), "In-place upgrade install failed");

      session = await launchAndAttach(adb, opts.cdpPort);
      const scenarios = {};
      try {
        for (const scenario of ["create-after-commit", "create-before-commit"]) {
          await session.client.setSelect("create-scenario", scenario);
          const beforeRecover = await session.client.evaluate(`window.__tfP1Bridge.inspectCreateState(${JSON.stringify(scenario)})`);
          const pagePendingBefore = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);

          assert.ok(beforeRecover.pending, `Missing legacy pending record after upgrade for ${scenario}`);
          assert.equal(beforeRecover.pending.operationId, "fixture-op-lunch");
          assert.equal(beforeRecover.pending.datasetId, "fixture-dataset");
          assert.equal(beforeRecover.pending.sourceDeviceId, "fixture-device");
          assert.equal(beforeRecover.pending.expectedRevisionId, "fixture-r0");
          assert.equal(beforeRecover.pending.intentSha256, EXPECTED_LUNCH_SHA256);
          assert.equal(beforeRecover.pending.recoveryState, "pending_verification");
          assert.ok(!pagePendingBefore.includes("undefined"), `Page displayed undefined after upgrade: ${pagePendingBefore}`);
          assert.ok(pagePendingBefore.includes("提交结果待核实（未确认）"), pagePendingBefore);
          assert.ok(pagePendingBefore.includes("fixture-r0"), pagePendingBefore);

          await session.client.setSelect("create-fault-mode", "none");
          const recovered = await session.client.tapAndWaitCreateAction("create-recover");
          const pagePendingAfter = await session.client.evaluate(`document.getElementById('create-pending-state').textContent`);
          if (scenario === "create-after-commit") {
            assert.equal(recovered.status, "confirmed_existing");
          } else {
            assert.equal(recovered.status, "recovered_by_retry");
            assert.equal(recovered.lookup.state, "not_found_at_settled_read");
            assert.equal(recovered.retry.replayed, false);
          }
          assert.equal(recovered.state.pending, null);
          assert.equal(recovered.state.confirmedOp, "fixture-op-lunch");
          assert.ok(recovered.state.confirmedRevisionId && recovered.state.confirmedRevisionId !== "fixture-r0");
          assert.equal(recovered.state.expenseCount, 1);
          assert.equal(recovered.state.totalCents, 8635);
          assert.equal(recovered.state.revisionCount, 2);
          assert.equal(recovered.state.receiptCount, 1);
          assert.equal(recovered.state.outboxCount, 1);
          assert.ok(pagePendingAfter.includes("已确认入账"), pagePendingAfter);

          scenarios[scenario] = {
            pagePendingBefore,
            recoveredStatus: recovered.status,
            confirmedRevisionId: recovered.state.confirmedRevisionId,
            pagePendingAfter,
            final: {
              expenseCount: recovered.state.expenseCount,
              totalCents: recovered.state.totalCents,
              revisionCount: recovered.state.revisionCount,
              receiptCount: recovered.state.receiptCount,
              outboxCount: recovered.state.outboxCount,
            },
          };
        }
      } finally {
        session.client.close();
      }

      console.log(JSON.stringify({
        passed: true,
        baseRef: opts.baseRef,
        avd: EXPECTED_AVD,
        sdk: "35",
        scenarios,
      }, null, 2));
    } finally {
      try { adb("forward", "--remove", `tcp:${opts.cdpPort}`); } catch {}
      try { adb("shell", "am", "force-stop", PACKAGE); } catch {}
      const uninstallOut = adb("uninstall", PACKAGE);
      assert.ok(uninstallOut.includes("Success"), `Uninstall failed: ${uninstallOut}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
