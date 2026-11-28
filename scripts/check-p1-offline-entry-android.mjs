// Android API 35 隔离模拟器端到端验收：从旅行账本离线记两笔独立 CNY 消费（含断网、非法金额零写入、连点防重、强停重开与 0.1.0 命令导出校验）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "org.travelflow.p1bridge";
const ACTIVITY = `${PACKAGE}/.MainActivity`;

function parseArgs(argv) {
  const out = { serial: null, cdpPort: 19241, apk: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--serial") out.serial = argv[++i] ?? null;
    else if (arg === "--cdp-port") out.cdpPort = Number(argv[++i]);
    else if (arg === "--apk") out.apk = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.serial || !/^emulator-\d+$/.test(out.serial)) {
    throw new Error("Provide explicit isolated emulator --serial emulator-NNNN");
  }
  if (!Number.isInteger(out.cdpPort) || out.cdpPort <= 0) {
    throw new Error("Invalid --cdp-port");
  }
  return out;
}

function adbBin() {
  const home = process.env.ANDROID_HOME;
  if (!home) throw new Error("ANDROID_HOME is required");
  return path.join(home, "platform-tools", "adb");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}

function adb(serial, args, options = {}) {
  return runCommand(adbBin(), ["-s", serial, ...args], options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildApk(tripContext, sourceRoot = root, { manualSyncFixture = false, offlineFixture = false } = {}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "travelflow-p1-offline-entry-"));
  const projectDir = path.join(tempRoot, "project");
  runCommand(process.execPath, [path.join(sourceRoot, "scripts/prepare-p1-bridge-receipt.mjs"), "--output", projectDir, ...(tripContext ? ["--trip-context", tripContext] : [])], {
    cwd: root,
    stdio: "inherit",
  });
  if (offlineFixture) {
    // The original local-ledger regression has a named fixture. A normal installation starts unbound.
    assert.ok(!tripContext);
    const seed = { datasetId: "fixture-dataset", travelId: "fixture-travel", branchId: "fixture-branch",
      initialRevisionId: "fixture-r0", sourceDeviceId: "fixture-device",
      baselineSource: "vendor/contracts/expense-create-v0.1.0 (fixture-dataset / fixture-travel / fixture-branch / fixture-r0)" };
    writeFileSync(path.join(projectDir, "android/app/src/main/assets/public/offline-trip-seed.json"), JSON.stringify(seed));
  }
  if (manualSyncFixture) {
    // The historical manual transport checks deliberately pause between pull and confirm.
    const index = path.join(projectDir, "android/app/src/main/assets/public/index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace("<head>", '<head><meta name="travelflow-manual-sync-fixture">'));
  }
  runCommand("./gradlew", [":app:assembleDebug", "--no-daemon", "--console=plain"], {
    cwd: path.join(projectDir, "android"),
    stdio: "inherit",
  });
  const apk = path.join(projectDir, "android/app/build/outputs/apk/debug/app-debug.apk");
  if (!existsSync(apk)) throw new Error(`Missing built APK: ${apk}`);
  return { apk, tempRoot };
}

function assertIsolatedAvd(serial) {
  const emu = adb(serial, ["shell", "getprop", "ro.kernel.qemu"]).stdout.trim();
  const avd = adb(serial, ["shell", "getprop", "ro.boot.qemu.avd_name"]).stdout.trim();
  const sdk = adb(serial, ["shell", "getprop", "ro.build.version.sdk"]).stdout.trim();
  assert.equal(emu, "1", `Device ${serial} is not an emulator`);
  assert.equal(avd, "travelflow_p0_api35", `Unexpected AVD ${avd}; expected travelflow_p0_api35`);
  assert.equal(sdk, "35", `Unexpected SDK ${sdk}; expected 35`);
  const boot = adb(serial, ["shell", "getprop", "sys.boot_completed"]).stdout.trim();
  assert.equal(boot, "1", "Emulator boot not completed");
  const installed = adb(serial, ["shell", "pm", "list", "packages", PACKAGE]).stdout.trim();
  assert.equal(installed, "", `Refusing to overwrite existing ${PACKAGE}`);
  return { avd, sdk };
}

function getAirplaneMode(serial) {
  return adb(serial, ["shell", "settings", "get", "global", "airplane_mode_on"]).stdout.trim();
}

function setAirplaneMode(serial, enabled) {
  const val = enabled ? "1" : "0";
  adb(serial, ["shell", "settings", "put", "global", "airplane_mode_on", val]);
  adb(serial, ["shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable"], { allowFailure: true });
}

async function waitForPid(serial, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = adb(serial, ["shell", "pidof", PACKAGE], { allowFailure: true }).stdout.trim();
    const pid = Number(out.split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for PID of ${PACKAGE}`);
}

async function connectWebView(cdpPort) {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const target = targets.find((item) => item.title === "TravelFlow P1 Bridge Receipt") ?? targets[0];
  assert.ok(target?.webSocketDebuggerUrl, `Expected WebView target on port ${cdpPort}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(JSON.stringify(response.exceptionDetails));
    }
    return response.result?.value;
  }
  async function tap(id) {
    const cleanId = id.startsWith("#") ? id.slice(1) : id;
    const receiptKey = `__tfOfflineTap_${crypto.randomUUID()}`;
    try {
      const pos = await evaluate(`(async () => {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
          document.activeElement.blur();
        }
        const el = document.getElementById(${JSON.stringify(cleanId)});
        if (!el) throw new Error("Missing element #" + ${JSON.stringify(cleanId)});
        if (el.disabled) throw new Error("Disabled element #" + ${JSON.stringify(cleanId)});
        const deadline = Date.now() + 3000;
        let point = null;
        let prevKey = null;
        while (Date.now() < deadline) {
          el.scrollIntoView({ block: "center", inline: "center" });
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const rect = el.getBoundingClientRect();
          const vv = window.visualViewport;
          const candidate = {
            x: Math.round(rect.left - (vv ? vv.offsetLeft : 0) + rect.width / 2),
            y: Math.round(rect.top - (vv ? vv.offsetTop : 0) + rect.height / 2),
          };
          const vw = vv ? vv.width : window.innerWidth;
          const vh = vv ? vv.height : window.innerHeight;
          const hit = document.elementFromPoint(candidate.x, candidate.y);
          const onTarget = Boolean(hit && (hit === el || el.contains(hit)));
          const key = candidate.x + "," + candidate.y + "," + Math.round(vh);
          if (candidate.x >= 0 && candidate.y >= 0 && candidate.x < vw && candidate.y < vh && onTarget) {
            if (key === prevKey) {
              point = candidate;
              break;
            }
            prevKey = key;
          } else {
            prevKey = null;
          }
          await new Promise((r) => setTimeout(r, 120));
        }
        if (!point) {
          const rect = el.getBoundingClientRect();
          const vv = window.visualViewport;
          throw new Error("Button center outside viewport for #" + ${JSON.stringify(cleanId)} + ": " + JSON.stringify({
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            vv: vv ? { width: vv.width, height: vv.height, offsetTop: vv.offsetTop } : null,
          }));
        }
        const listener = (event) => {
          window[${JSON.stringify(receiptKey)}].clicked = {
            trusted: event.isTrusted,
            expected: event.target === el || el.contains(event.target),
            target: event.target?.id ?? "",
          };
        };
        window[${JSON.stringify(receiptKey)}] = { listener, clicked: null };
        document.addEventListener("click", listener, { capture: true, once: true });
        return point;
      })()`);
      await send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: pos.x, y: pos.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
      });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const deadline = Date.now() + 4000;
      let clicked = null;
      while (Date.now() < deadline) {
        clicked = await evaluate(`window[${JSON.stringify(receiptKey)}]?.clicked ?? null`);
        if (clicked) break;
        await sleep(40);
      }
      assert.ok(clicked?.trusted && clicked?.expected, `Touch missed #${cleanId}: ${JSON.stringify(clicked)}`);
    } finally {
      await evaluate(`(() => {
        const rec = window[${JSON.stringify(receiptKey)}];
        if (!rec) return;
        document.removeEventListener("click", rec.listener, true);
        delete window[${JSON.stringify(receiptKey)}];
      })()`).catch(() => {});
    }
  }
  return { send, evaluate, tap, close: () => ws.close() };
}

async function attachWebView(serial, cdpPort) {
  const pid = await waitForPid(serial);
  adb(serial, ["forward", "--remove", `tcp:${cdpPort}`], { allowFailure: true });
  adb(serial, ["forward", `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`]);
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const cdp = await connectWebView(cdpPort);
      const readyDeadline = Date.now() + 15000;
      while (Date.now() < readyDeadline) {
        const ready = await cdp.evaluate(
          `Boolean(window.__travelflowOfflineEntry && (document.getElementById("runtime")?.dataset.ready === "true" ||
            !document.getElementById("trip-open-entry-btn")?.disabled))`,
        );
        if (ready) return { cdp, pid };
        await sleep(200);
      }
      cdp.close();
      throw new Error("Offline entry page did not become ready");
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError ?? new Error("Failed to attach to WebView");
}

async function launchAndAttach(serial, cdpPort) {
  adb(serial, ["shell", "am", "start", "-W", "-n", ACTIVITY]);
  return attachWebView(serial, cdpPort);
}

async function forceStopAndReopen(serial, cdpPort, previousPid) {
  adb(serial, ["shell", "am", "force-stop", PACKAGE]);
  await sleep(600);
  const { cdp, pid } = await launchAndAttach(serial, cdpPort);
  assert.notEqual(pid, previousPid, `Expected fresh PID after force-stop (got ${pid})`);
  return { cdp, pid };
}

async function setInputValue(cdp, id, value) {
  const ok = await cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(value)};
  })()`);
  assert.equal(ok, true, `Failed to set #${id}`);
}

async function insertTextViaCdp(cdp, id, value) {
  await cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) throw new Error("Missing element #" + ${JSON.stringify(id)});
    el.focus();
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await cdp.send("Input.insertText", { text: value });
  const actual = await cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
  assert.equal(actual, value, `Input.insertText truncated or altered #${id}`);
}

async function waitForCondition(cdp, expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await cdp.evaluate(expression);
    if (matched) return;
    await sleep(120);
  }
  const ui = await cdp.evaluate(`window.__travelflowOfflineEntry?.getUiState?.()`).catch(() => null);
  throw new Error(`Timed out waiting for ${label} (ui=${JSON.stringify(ui)})`);
}

async function doubleTapElement(cdp, id) {
  const receiptKey = `__tfOfflineDblTap_${crypto.randomUUID()}`;
  try {
    const pos = await cdp.evaluate(`(async () => {
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return null;
      if (el.disabled) throw new Error("Disabled element #" + ${JSON.stringify(id)});
      const deadline = Date.now() + 3000;
      let point = null;
      let prevKey = null;
      while (Date.now() < deadline) {
        el.scrollIntoView({ block: "center", inline: "center" });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const ox = vv ? vv.offsetLeft : 0;
        const oy = vv ? vv.offsetTop : 0;
        const candidate = { x: Math.round(rect.left - ox + rect.width / 2), y: Math.round(rect.top - oy + rect.height / 2) };
        const vw = vv ? vv.width : window.innerWidth;
        const vh = vv ? vv.height : window.innerHeight;
        const hit = document.elementFromPoint(candidate.x, candidate.y);
        const onTarget = Boolean(hit && (hit === el || el.contains(hit)));
        const key = candidate.x + "," + candidate.y + "," + Math.round(vh);
        if (candidate.x >= 0 && candidate.y >= 0 && candidate.x < vw && candidate.y < vh && onTarget) {
          if (key === prevKey) {
            point = candidate;
            break;
          }
          prevKey = key;
        } else {
          prevKey = null;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      if (!point) {
        const rect = el.getBoundingClientRect();
        const vv = window.visualViewport;
        throw new Error("Button center outside viewport for #" + ${JSON.stringify(id)} + ": " + JSON.stringify({
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          vv: vv ? { width: vv.width, height: vv.height, offsetTop: vv.offsetTop } : null,
        }));
      }
      const listener = (event) => {
        window[${JSON.stringify(receiptKey)}].hits.push({
          trusted: event.isTrusted,
          expected: event.target === el || el.contains(event.target),
          target: event.target?.id ?? "",
        });
      };
      window[${JSON.stringify(receiptKey)}] = { listener, hits: [] };
      document.addEventListener("click", listener, { capture: true });
      return point;
    })()`);
    assert.ok(pos, `Missing element #${id} for double tap`);
    // Dispatch two rapid touch taps back-to-back to verify double-tap idempotency.
    for (let i = 0; i < 2; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: pos.x, y: pos.y, radiusX: 2, radiusY: 2, force: 1, id: i + 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await sleep(15);
    }
    const deadline = Date.now() + 4000;
    let hits = [];
    while (Date.now() < deadline) {
      hits = await cdp.evaluate(`window[${JSON.stringify(receiptKey)}]?.hits ?? []`);
      if (hits.length > 0) break;
      await sleep(40);
    }
    assert.ok(hits.some((h) => h.trusted && h.expected), `Double tap missed #${id}: ${JSON.stringify(hits)}`);
  } finally {
    await cdp.evaluate(`(() => {
      const rec = window[${JSON.stringify(receiptKey)}];
      if (!rec) return;
      document.removeEventListener("click", rec.listener, true);
      delete window[${JSON.stringify(receiptKey)}];
    })()`).catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const envInfo = assertIsolatedAvd(opts.serial);
  const originalAirplane = getAirplaneMode(opts.serial);

  let built = null;
  let apkPath = opts.apk;
  let installed = false;
  let cdp = null;

  try {
    if (!apkPath) {
      built = buildApk(undefined, root, { offlineFixture: true });
      apkPath = built.apk;
    }
    adb(opts.serial, ["install", "-t", apkPath]);
    installed = true;

    // Enable airplane mode to verify genuine offline saving with no network.
    setAirplaneMode(opts.serial, true);
    await sleep(600);
    assert.equal(getAirplaneMode(opts.serial), "1", "Failed to enable airplane mode");

    let session = await launchAndAttach(opts.serial, opts.cdpPort);
    cdp = session.cdp;
    const pidInitial = session.pid;

    // 1. Verify empty offline travel ledger state.
    const initialState = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    const initialUi = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(initialState.initialized, true);
    assert.equal(initialState.datasetId, "fixture-dataset");
    assert.equal(initialState.travelId, "fixture-travel");
    assert.equal(initialState.branchId, "fixture-branch");
    assert.equal(initialState.headRevisionId, "fixture-r0");
    assert.equal(initialState.expenseCount, 0);
    assert.equal(initialState.totalCents, 0);
    assert.equal(initialState.revisionCount, 1);
    assert.equal(initialState.receiptCount, 0);
    assert.equal(initialState.outboxCount, 0);
    assert.equal(initialUi.ledgerViewVisible, true);
    assert.match(initialUi.summaryText, /共 0 笔 · 合计 ¥0\.00/);
    assert.match(initialUi.metaText, /fixture-r0/);

    // 2. Open "记一笔" via real CDP touch and verify invalid amounts produce zero writes.
    await cdp.tap("#trip-open-entry-btn");
    await waitForCondition(cdp, `window.__travelflowOfflineEntry.getUiState().entryViewVisible === true`, "entry view");

    const invalidAmountCases = [
      ["", /金额须为正数且最多两位小数/],
      ["0", /金额超出允许范围/],
      ["0.00", /金额超出允许范围/],
      ["-12.50", /金额须为正数且最多两位小数/],
      ["86.355", /金额须为正数且最多两位小数/],
      ["1e2", /金额须为正数且最多两位小数/],
      ["abc", /金额须为正数且最多两位小数/],
      ["100000000.00", /金额超出允许范围/],
    ];
    const rejectedInputs = [];
    for (const [rawAmount, expectedErrPattern] of invalidAmountCases) {
      const prevSeq = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState().saveAttemptSeq`);
      await setInputValue(cdp, "trip-entry-title", "无效金额测试");
      await setInputValue(cdp, "trip-entry-amount-yuan", rawAmount);
      await setInputValue(cdp, "trip-entry-category", "transport");
      await cdp.tap("#trip-entry-save-btn");
      await waitForCondition(
        cdp,
        `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeq} && u.lastAttempt.outcome === "validation_error"; })()`,
        `validation_error for invalid amount ${rawAmount}`,
      );
      const uiErr = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
      assert.equal(uiErr.entryViewVisible, true, `Should stay on entry view for invalid amount ${rawAmount}`);
      assert.match(uiErr.errorText, expectedErrPattern, `Unexpected error text for ${rawAmount}: ${uiErr.errorText}`);
      const st = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
      assert.equal(st.expenseCount, 0, `Zero writes expected for invalid amount ${rawAmount}`);
      assert.equal(st.revisionCount, 1);
      assert.equal(st.receiptCount, 0);
      assert.equal(st.outboxCount, 0);
      rejectedInputs.push({ input: rawAmount, error: uiErr.errorText });
    }

    // 2b. Verify non-BMP scalar over-limit (101 "𠮷" title / 1001 "𠮷" notes) & U+FEFF are rejected without silent truncation or stripping.
    const nonBmp100 = "𠮷".repeat(100);
    const nonBmp101 = "𠮷".repeat(101);
    const nonBmp1000 = "𠮷".repeat(1000);
    const nonBmp1001 = "𠮷".repeat(1001);

    let prevSeq = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState().saveAttemptSeq`);
    await insertTextViaCdp(cdp, "trip-entry-title", nonBmp101);
    await setInputValue(cdp, "trip-entry-amount-yuan", "86.35");
    await setInputValue(cdp, "trip-entry-category", "meal");
    await setInputValue(cdp, "trip-entry-notes", "");
    await cdp.tap("#trip-entry-save-btn");
    await waitForCondition(
      cdp,
      `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeq} && u.lastAttempt.outcome === "validation_error"; })()`,
      "validation_error for 101-scalar title",
    );
    const uiOverTitle = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(uiOverTitle.entryViewVisible, true);
    assert.match(uiOverTitle.errorText, /标题须为 1 至 100 个字符/);
    assert.equal(uiOverTitle.titleValue, nonBmp101, "Over-limit title draft must be preserved without silent truncation");
    assert.equal((await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`)).expenseCount, 0);

    prevSeq = uiOverTitle.saveAttemptSeq;
    await insertTextViaCdp(cdp, "trip-entry-title", nonBmp100);
    await insertTextViaCdp(cdp, "trip-entry-notes", nonBmp1001);
    await cdp.tap("#trip-entry-save-btn");
    await waitForCondition(
      cdp,
      `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeq} && u.lastAttempt.outcome === "validation_error"; })()`,
      "validation_error for 1001-scalar notes",
    );
    const uiOverNotes = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(uiOverNotes.entryViewVisible, true);
    assert.match(uiOverNotes.errorText, /备注长度不能超过 1000 个字符/);
    assert.equal(uiOverNotes.notesValue, nonBmp1001, "Over-limit notes draft must be preserved without silent truncation");
    assert.equal((await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`)).expenseCount, 0);

    prevSeq = uiOverNotes.saveAttemptSeq;
    await setInputValue(cdp, "trip-entry-title", "FEFF检查");
    await setInputValue(cdp, "trip-entry-notes", "A\uFEFFB");
    await cdp.tap("#trip-entry-save-btn");
    await waitForCondition(
      cdp,
      `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeq} && u.lastAttempt.outcome === "validation_error"; })()`,
      "validation_error for U+FEFF notes",
    );
    const uiFeff = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(uiFeff.entryViewVisible, true);
    assert.match(uiFeff.errorText, /U\+FEFF/);
    assert.equal(uiFeff.notesValue, "A\uFEFFB", "U+FEFF must be rejected without silent stripping");
    assert.equal((await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`)).expenseCount, 0);

    // 3. Enter first expense (non-fixed-lunch sample: 42.80 yuan -> 4280 cents) and rapid double-tap Save!
    prevSeq = uiFeff.saveAttemptSeq;
    await setInputValue(cdp, "trip-entry-title", "机场快线车票");
    await setInputValue(cdp, "trip-entry-amount-yuan", "42.80");
    await setInputValue(cdp, "trip-entry-category", "transport");
    await setInputValue(cdp, "trip-entry-notes", "首都机场线");
    await doubleTapElement(cdp, "trip-entry-save-btn");
    await waitForCondition(
      cdp,
      `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeq} && u.lastAttempt.outcome === "saved" && u.ledgerViewVisible === true; })()`,
      "saved and returned to ledger after first save",
    );

    const afterFirstState = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    const afterFirstUi = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(afterFirstState.expenseCount, 1, "Rapid double-tap must record only one expense");
    assert.equal(afterFirstState.totalCents, 4280);
    assert.equal(afterFirstState.revisionCount, 2);
    assert.equal(afterFirstState.receiptCount, 1);
    assert.equal(afterFirstState.outboxCount, 1);
    const rev1 = afterFirstState.headRevisionId;
    assert.notEqual(rev1, "fixture-r0");
    assert.equal(afterFirstState.expenses[0].title, "机场快线车票");
    assert.equal(afterFirstState.expenses[0].amount_cents, 4280);
    assert.equal(afterFirstState.expenses[0].category, "transport");
    assert.equal(afterFirstState.expenses[0].paid_on, null);
    assert.equal(afterFirstState.expenses[0].notes, "首都机场线");
    assert.equal(afterFirstState.expenses[0].delivery_state, "pending_send");
    assert.notEqual(afterFirstState.expenses[0].operation_id, afterFirstState.expenses[0].id);
    assert.match(afterFirstUi.summaryText, /共 1 笔 · 合计 ¥42\.80/);
    assert.match(afterFirstUi.syncStatusText, /已保存在本机 · 待同步 1 笔/);
    assert.ok(!afterFirstUi.syncStatusText.includes("对端已确认"), "Must not claim desktop confirmed");
    assert.equal(afterFirstUi.renderedItems.length, 1);
    assert.match(afterFirstUi.renderedItems[0].text, /机场快线车票/);
    assert.match(afterFirstUi.renderedItems[0].text, /¥42\.80/);
    assert.match(afterFirstUi.renderedItems[0].text, /已保存在本机 · 待同步/);

    // 4. Force-stop cold restart and verify first expense persists.
    cdp.close();
    session = await forceStopAndReopen(opts.serial, opts.cdpPort, pidInitial);
    cdp = session.cdp;
    const pidAfterFirstStop = session.pid;

    const reopenedFirstState = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    const reopenedFirstUi = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(reopenedFirstState.expenseCount, 1);
    assert.equal(reopenedFirstState.totalCents, 4280);
    assert.equal(reopenedFirstState.headRevisionId, rev1);
    assert.equal(reopenedFirstState.outboxCount, 1);
    assert.match(reopenedFirstUi.summaryText, /共 1 笔 · 合计 ¥42\.80/);
    assert.match(reopenedFirstUi.renderedItems[0].text, /已保存在本机 · 待同步/);

    // 5. Enter second expense (86.35 yuan -> 8635 cents, matching desktop fixed lunch comparison).
    await cdp.tap("#trip-open-entry-btn");
    await waitForCondition(cdp, `window.__travelflowOfflineEntry.getUiState().entryViewVisible === true`, "second entry view");
    const prevSeqSecond = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState().saveAttemptSeq`);
    await setInputValue(cdp, "trip-entry-title", "午餐");
    await setInputValue(cdp, "trip-entry-amount-yuan", "86.35");
    await setInputValue(cdp, "trip-entry-category", "meal");
    await setInputValue(cdp, "trip-entry-notes", "");
    await cdp.tap("#trip-entry-save-btn");
    await waitForCondition(
      cdp,
      `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeqSecond} && u.lastAttempt.outcome === "saved" && u.ledgerViewVisible === true; })()`,
      "saved and returned to ledger after second save",
    );

    const afterSecondState = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    const afterSecondUi = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    assert.equal(afterSecondState.expenseCount, 2);
    assert.equal(afterSecondState.totalCents, 12915);
    assert.equal(afterSecondState.revisionCount, 3);
    assert.equal(afterSecondState.receiptCount, 2);
    assert.equal(afterSecondState.outboxCount, 2);
    const rev2 = afterSecondState.headRevisionId;
    assert.notEqual(rev2, rev1);
    assert.match(afterSecondUi.summaryText, /共 2 笔 · 合计 ¥129\.15/);
    assert.match(afterSecondUi.syncStatusText, /已保存在本机 · 待同步 2 笔/);
    assert.equal(afterSecondUi.renderedItems.length, 2);
    assert.match(afterSecondUi.renderedItems[1].text, /午餐/);
    assert.match(afterSecondUi.renderedItems[1].text, /¥86\.35/);
    assert.match(afterSecondUi.renderedItems[1].text, /已保存在本机 · 待同步/);

    // 6. Second force-stop cold restart and verify both expenses, revision chain, and exported 0.1.0 commands.
    cdp.close();
    session = await forceStopAndReopen(opts.serial, opts.cdpPort, pidAfterFirstStop);
    cdp = session.cdp;
    const pidAfterSecondStop = session.pid;

    const finalState = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    const finalUi = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState()`);
    const exported = await cdp.evaluate(`window.__travelflowOfflineEntry.exportOutboxCommands()`);

    assert.equal(finalState.expenseCount, 2);
    assert.equal(finalState.totalCents, 12915);
    assert.equal(finalState.headRevisionId, rev2);
    assert.equal(finalState.revisionCount, 3);
    assert.equal(finalState.receiptCount, 2);
    assert.equal(finalState.outboxCount, 2);
    assert.equal(finalState.revisions[0].revision_id, "fixture-r0");
    assert.equal(finalState.revisions[0].parent_revision_id, null);
    assert.equal(finalState.revisions[1].revision_id, rev1);
    assert.equal(finalState.revisions[1].parent_revision_id, "fixture-r0");
    assert.equal(finalState.revisions[2].revision_id, rev2);
    assert.equal(finalState.revisions[2].parent_revision_id, rev1);
    assert.match(finalUi.summaryText, /共 2 笔 · 合计 ¥129\.15/);

    // Only the root has a known desktop parent. Both local intents must still verify independently.
    assert.equal(exported.contract_id, "travelflow.expense-create");
    assert.equal(exported.contract_version, "0.1.0");
    assert.equal(exported.count, 1);
    assert.equal(exported.items.length, 1);

    const [item1, item2] = finalState.outbox;
    assert.equal(finalState.outbox.length, 2);
    assert.equal(exported.items[0].raw_command_json, item1.raw_command_json);
    assert.equal(exported.items[0].intent_sha256, item1.intent_sha256);
    assert.notEqual(item1.operation_id, item1.entity_id);
    assert.notEqual(item2.operation_id, item2.entity_id);
    assert.notEqual(item1.operation_id, item2.operation_id);
    assert.notEqual(item1.entity_id, item2.entity_id);
    assert.equal(item1.expected_revision_id, "fixture-r0");
    assert.equal(item1.result_revision_id, rev1);
    assert.equal(item2.expected_revision_id, rev1);
    assert.equal(item2.result_revision_id, rev2);

    const desktopFixture = JSON.parse(
      readFileSync(path.join(root, "docs/internal/fixtures/p1-desktop-expense-create.json"), "utf8"),
    );

    for (const item of finalState.outbox) {
      assert.equal(item.delivery_state, "pending_send");
      assert.equal(item.command.profile, "p1-host-control-1");
      assert.equal(item.command.kind, "expense.create");
      assert.equal(item.command.operation.dataset_id, "fixture-dataset");
      assert.equal(item.command.operation.source_device_id, "fixture-device");
      assert.equal(item.command.target.travel_id, "fixture-travel");
      assert.equal(item.command.target.branch_id, "fixture-branch");
      assert.equal(item.command.payload.currency, "CNY");
      assert.equal(item.command.payload.paid_on, null);
      assert.equal(item.command.payload.day, null);
      assert.equal(item.command.payload.activity_id, null);
      assert.deepEqual(item.command.payload.receipt_ids, []);
      assert.equal(item.command.payload.budget_item_id, null);
      assert.equal(item.command.payload.settles_budget, false);
      assert.equal(item.command.payload.allow_shared_receipts, false);

      const p1Canon = fingerprintIntent(Buffer.from(item.raw_command_json, "utf8"), "control");
      assert.equal(p1Canon.accepted, true);
      assert.equal(item.canonical_intent_json, p1Canon.canonical_json);
      const recomputedSha = createHash("sha256").update(item.canonical_intent_json, "utf8").digest("hex");
      assert.equal(item.intent_sha256, recomputedSha);
      assert.equal(item.intent_sha256, p1Canon.sha256);

      assert.equal(item.receipt_query.profile, "p1-host-query-1");
      assert.equal(item.receipt_query.kind, "receipt.lookup");
      assert.equal(item.receipt_query.operation.operation_id, item.operation_id);
    }

    // Second item payload matches frozen 0.1.0 desktop 86.35 yuan lunch payload exactly!
    assert.deepEqual(item2.command.payload, desktopFixture.command.payload);

    // 7. Native pre-transaction shape validation: missing explicit-null field (paid_on) & unknown fields must reject with zero writes.
    const baseCommand = {
      profile: "p1-host-control-1",
      kind: "expense.create",
      operation: {
        dataset_id: "fixture-dataset",
        source_device_id: "fixture-device",
        operation_id: "op-shape-missing-paid-on",
      },
      target: {
        travel_id: "fixture-travel",
        branch_id: "fixture-branch",
        entity_id: "exp-shape-missing-paid-on",
      },
      expected_revision_id: rev2,
      payload: {
        title: "缺字段测试",
        amount_cents: 1200,
        currency: "CNY",
        paid_on: null,
        category: "other",
        day: null,
        activity_id: null,
        notes: "",
        receipt_ids: [],
        allow_shared_receipts: false,
        budget_item_id: null,
        settles_budget: false,
      },
    };
    const missingPaidOnCmd = structuredClone(baseCommand);
    delete missingPaidOnCmd.payload.paid_on;
    const resMissingPaidOn = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawCommand(${JSON.stringify(missingPaidOnCmd)})`,
    );
    assert.equal(resMissingPaidOn.accepted, false);
    assert.equal(resMissingPaidOn.error, "shape");

    const unknownPayloadFieldCmd = structuredClone(baseCommand);
    unknownPayloadFieldCmd.operation.operation_id = "op-shape-unknown-payload";
    unknownPayloadFieldCmd.target.entity_id = "exp-shape-unknown-payload";
    unknownPayloadFieldCmd.payload.extra_field = 1;
    const resUnknownPayload = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawCommand(${JSON.stringify(unknownPayloadFieldCmd)})`,
    );
    assert.equal(resUnknownPayload.accepted, false);
    assert.equal(resUnknownPayload.error, "shape");

    const unknownTopFieldCmd = structuredClone(baseCommand);
    unknownTopFieldCmd.operation.operation_id = "op-shape-unknown-top";
    unknownTopFieldCmd.target.entity_id = "exp-shape-unknown-top";
    unknownTopFieldCmd.extra_top = true;
    const resUnknownTop = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawCommand(${JSON.stringify(unknownTopFieldCmd)})`,
    );
    assert.equal(resUnknownTop.accepted, false);
    assert.equal(resUnknownTop.error, "shape");

    const afterShapeRejects = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    assert.equal(afterShapeRejects.expenseCount, 2, "Shape rejections must cause zero writes");
    assert.equal(afterShapeRejects.totalCents, 12915);
    assert.equal(afterShapeRejects.revisionCount, 3);
    assert.equal(afterShapeRejects.receiptCount, 2);
    assert.equal(afterShapeRejects.outboxCount, 2);
    assert.equal(afterShapeRejects.headRevisionId, rev2);

    // 7b. Native raw-string bridge validation: duplicate key, non-canonical whitespace envelope, and normal canonical commit + replay.
    const rawValidCmd = structuredClone(baseCommand);
    rawValidCmd.operation.operation_id = "op-raw-dup-key";
    rawValidCmd.target.entity_id = "exp-raw-dup-key";
    rawValidCmd.payload.title = "重复键检查";
    rawValidCmd.payload.amount_cents = 8635;
    const rawValidJson = JSON.stringify(rawValidCmd);
    const rawValidCanon = fingerprintIntent(Buffer.from(rawValidJson, "utf8"), "control");
    assert.equal(rawValidCanon.accepted, true);
    const dupKeyRawJson = rawValidJson.replace('"amount_cents":8635', '"amount_cents":100,"amount_cents":8635');
    assert.notEqual(dupKeyRawJson, rawValidJson);
    const resDupKey = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawStrings(${JSON.stringify(dupKeyRawJson)}, ${JSON.stringify(rawValidCanon.canonical_json)})`,
    );
    assert.equal(resDupKey.accepted, false);
    assert.equal(resDupKey.error, "duplicate_key");

    const wsCmd = structuredClone(baseCommand);
    wsCmd.operation.operation_id = "op-raw-whitespace-envelope";
    wsCmd.target.entity_id = "exp-raw-whitespace-envelope";
    wsCmd.payload.title = "非规范封装检查";
    wsCmd.payload.amount_cents = 8635;
    const wsRawJson = JSON.stringify(wsCmd);
    const wsCanon = fingerprintIntent(Buffer.from(wsRawJson, "utf8"), "control");
    assert.equal(wsCanon.accepted, true);
    const prettyEnvelope = JSON.stringify(JSON.parse(wsCanon.canonical_json), null, 2);
    const resPrettyEnvelope = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawStrings(${JSON.stringify(wsRawJson)}, ${JSON.stringify(prettyEnvelope)})`,
    );
    assert.equal(resPrettyEnvelope.accepted, false);
    assert.equal(resPrettyEnvelope.error, "non_canonical_intent");

    const badEscape = wsRawJson.replace('"profile"', String.raw`"\u００７０rofile"`);
    assert.notEqual(badEscape, wsRawJson);
    const invalidEscape = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawStrings(${JSON.stringify(badEscape)}, ${JSON.stringify(wsCanon.canonical_json)})`,
    );
    assert.deepEqual(invalidEscape, { accepted: false, error: "invalid_json" });

    const afterRawRejects = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    assert.equal(afterRawRejects.expenseCount, 2, "Duplicate key & non-canonical rejections must cause zero writes");
    assert.equal(afterRawRejects.totalCents, 12915);
    assert.equal(afterRawRejects.revisionCount, 3);
    assert.equal(afterRawRejects.receiptCount, 2);
    assert.equal(afterRawRejects.outboxCount, 2);

    // 8. Positive non-BMP exact-limit test via real CDP Input.insertText: 100 "𠮷" title + 1000 "𠮷" notes saves intact & passes fingerprintIntent + same-key replay.
    await cdp.tap("#trip-open-entry-btn");
    await waitForCondition(cdp, `window.__travelflowOfflineEntry.getUiState().entryViewVisible === true`, "third entry view");
    const prevSeqNonBmp = await cdp.evaluate(`window.__travelflowOfflineEntry.getUiState().saveAttemptSeq`);
    await insertTextViaCdp(cdp, "trip-entry-title", nonBmp100);
    await setInputValue(cdp, "trip-entry-amount-yuan", "12.34");
    await setInputValue(cdp, "trip-entry-category", "other");
    await insertTextViaCdp(cdp, "trip-entry-notes", nonBmp1000);
    await cdp.tap("#trip-entry-save-btn");
    await waitForCondition(
      cdp,
      `(() => { const u = window.__travelflowOfflineEntry.getUiState(); return u.saveAttemptSeq > ${prevSeqNonBmp} && u.lastAttempt.outcome === "saved" && u.ledgerViewVisible === true; })()`,
      "saved and returned to ledger after non-BMP save",
    );

    const afterNonBmpState = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    const exportedAfterNonBmp = await cdp.evaluate(`window.__travelflowOfflineEntry.exportOutboxCommands()`);
    assert.equal(afterNonBmpState.expenseCount, 3);
    assert.equal(afterNonBmpState.totalCents, 14149);
    assert.equal(afterNonBmpState.revisionCount, 4);
    assert.equal(afterNonBmpState.receiptCount, 3);
    assert.equal(afterNonBmpState.outboxCount, 3);
    assert.deepEqual(exportedAfterNonBmp.items, exported.items);
    const item3 = afterNonBmpState.outbox[2];
    assert.equal(Array.from(item3.command.payload.title).length, 100);
    assert.equal(item3.command.payload.title, nonBmp100);
    assert.equal(Array.from(item3.command.payload.notes).length, 1000);
    assert.equal(item3.command.payload.notes, nonBmp1000);
    assert.equal(item3.command.payload.paid_on, null);
    const p1Canon3 = fingerprintIntent(Buffer.from(item3.raw_command_json, "utf8"), "control");
    assert.equal(p1Canon3.accepted, true);
    assert.equal(item3.canonical_intent_json, p1Canon3.canonical_json);
    assert.equal(item3.intent_sha256, p1Canon3.sha256);

    // Same-key canonical replay on the 3rd expense must return replayed=true & original revision with zero extra rows.
    const replayItem3 = await cdp.evaluate(
      `window.__travelflowOfflineEntry.submitRawStrings(${JSON.stringify(item3.raw_command_json)}, ${JSON.stringify(item3.canonical_intent_json)})`,
    );
    assert.equal(replayItem3.accepted, true);
    assert.equal(replayItem3.replayed, true);
    assert.equal(replayItem3.result_revision_id, item3.result_revision_id);
    assert.equal(replayItem3.intent_sha256, item3.intent_sha256);
    for (const token of ["1234.0", "12.34e2", "1234.0000000000000001"]) {
      const raw = item3.raw_command_json.replace('"amount_cents":1234', '"amount_cents":' + token);
      assert.notEqual(raw, item3.raw_command_json);
      const result = await cdp.evaluate(
        `window.__travelflowOfflineEntry.submitRawStrings(${JSON.stringify(raw)}, ${JSON.stringify(item3.canonical_intent_json)})`,
      );
      if (token === "1234.0000000000000001") {
        assert.throws(() => fingerprintIntent(Buffer.from(raw), "control"), { code: "integer_range" });
        assert.deepEqual(result, { accepted: false, error: "integer_range" });
      } else {
        assert.equal(fingerprintIntent(Buffer.from(raw), "control").sha256, item3.intent_sha256);
        assert.deepEqual(result, replayItem3);
      }
    }
    const afterReplay3 = await cdp.evaluate(`window.__travelflowOfflineEntry.inspect()`);
    assert.equal(afterReplay3.expenseCount, 3);
    assert.equal(afterReplay3.totalCents, 14149);
    assert.equal(afterReplay3.revisionCount, 4);
    assert.equal(afterReplay3.receiptCount, 3);
    assert.equal(afterReplay3.outboxCount, 3);

    console.log(JSON.stringify({
      passed: true,
      avd: envInfo.avd,
      sdk: envInfo.sdk,
      package: PACKAGE,
      offlineAirplaneModeVerified: true,
      pids: {
        initial: pidInitial,
        afterFirstForceStop: pidAfterFirstStop,
        afterSecondForceStop: pidAfterSecondStop,
      },
      baselineSource: finalState.baselineSource,
      invalidAmountRejections: rejectedInputs,
      textValidationRegressions: {
        overLimitTitle101RejectedAndPreserved: true,
        overLimitNotes1001RejectedAndPreserved: true,
        feffRejectedAndPreserved: true,
        nonBmpExact100Title1000NotesSavedAndCanonicalized: true,
      },
      nativeShapeRejections: {
        missingPaidOn: resMissingPaidOn.error,
        unknownPayloadField: resUnknownPayload.error,
        unknownTopField: resUnknownTop.error,
        duplicateKey: resDupKey.error,
        nonCanonicalWhitespaceEnvelope: resPrettyEnvelope.error,
        sameKeyCanonicalReplayVerified: replayItem3.replayed === true,
        zeroWritesVerified: true,
      },
      doubleTapSingleWriteVerified: true,
      expenses: finalState.expenses.map((e) => ({
        entity_id: e.id,
        operation_id: e.operation_id,
        title: e.title,
        amount_cents: e.amount_cents,
        category: e.category,
        paid_on: e.paid_on,
        notes: e.notes,
        delivery_state: e.delivery_state,
        expected_revision_id: e.expected_revision_id,
        result_revision_id: e.result_revision_id,
        intent_sha256: e.intent_sha256,
      })),
      revisions: finalState.revisions.map((r) => ({
        revision_id: r.revision_id,
        parent_revision_id: r.parent_revision_id,
        expense_count: r.expense_count,
        total_cents: r.total_cents,
      })),
      finalTwoExpenseSnapshot: {
        expenseCount: finalState.expenseCount,
        totalCents: finalState.totalCents,
        revisionCount: finalState.revisionCount,
        receiptCount: finalState.receiptCount,
        outboxCount: finalState.outboxCount,
        headRevisionId: finalState.headRevisionId,
        summaryText: finalUi.summaryText,
        syncStatusText: finalUi.syncStatusText,
        sqlite: finalState.sqlite,
        journal: finalState.journal,
      },
      finalAfterNonBmp: {
        expenseCount: afterNonBmpState.expenseCount,
        totalCents: afterNonBmpState.totalCents,
        revisionCount: afterNonBmpState.revisionCount,
        receiptCount: afterNonBmpState.receiptCount,
        outboxCount: afterNonBmpState.outboxCount,
        headRevisionId: afterNonBmpState.headRevisionId,
        nonBmpIntentSha256: item3.intent_sha256,
      },
      exportedContract: {
        contract_id: exported.contract_id,
        contract_version: exported.contract_version,
        count: exported.count,
        localIntents: finalState.outboxCount,
        secondLocalIntentMatchesDesktopLunchPayload: true,
      },
    }, null, 2));
  } finally {
    if (cdp) {
      try { cdp.close(); } catch {}
    }
    try {
      setAirplaneMode(opts.serial, originalAirplane === "1");
    } catch {}
    adb(opts.serial, ["forward", "--remove", `tcp:${opts.cdpPort}`], { allowFailure: true });
    if (installed) {
      adb(opts.serial, ["uninstall", PACKAGE], { allowFailure: true });
    }
    if (built) {
      rmSync(built.tempRoot, { recursive: true, force: true });
    }
  }
}

export { adb, assertIsolatedAvd, buildApk, forceStopAndReopen, getAirplaneMode, launchAndAttach,
  PACKAGE, setAirplaneMode, setInputValue, waitForCondition };

if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
