// 仅由隔离模拟器故障控制器调用；取消确认与工作线程终态分别计时。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";

const [portFlag, port, caseFlag, scenario, clientFlag, client = "platform"] = process.argv.slice(2);
assert.ok([6, 8].includes(process.argv.length) && portFlag === "--port" && caseFlag === "--case" &&
  ["baseline", "syn", "dns", "dns-system", "dns-deadline"].includes(scenario) &&
  (!clientFlag || clientFlag === "--client") && ["platform", "okhttp"].includes(client),
  "Usage: check-android-connect.mjs --port PORT --case baseline|syn|dns|dns-system|dns-deadline [--client platform|okhttp]");
const page = await connectProbe(port);
const control = async (path, method = "GET") => {
  const response = await fetch(`http://127.0.0.1:18517/${path}`, {method, signal: AbortSignal.timeout(4000)});
  assert.equal(response.status, 200);
  return response.json();
};
const report = {scenario, client};
const requestId = `connect_${crypto.randomUUID()}`;
const state = "window.__connectionCheck";
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (api.Capacitor.getPlatform() !== 'android') throw Error('Not native Android');
    const stream = api.registerPlugin(${JSON.stringify(client === "okhttp" ? "ProbeAsyncStream" : "ProbeStream")});
    ${state} = {stream, store: api.registerPlugin('ProbeStore'), events: []};
    ${state}.listener = await stream.addListener('stream', event => {
      if (event.requestId === ${JSON.stringify(requestId)}) {
        ${state}.events.push(event);
        if (event.type !== 'chunk') ${state}.terminalAt = performance.now();
      }
    });
  })()`);
  const before = await page.evaluate(`${state}.store.read()`);
  await page.evaluate(`${state}.stream.start(${JSON.stringify({requestId, transport: scenario.startsWith("dns") ? "dns" : "http", resolver: scenario === "dns-system" ? "system" : "auto"})})`);
  if (scenario !== "baseline") {
    const end = Date.now() + 5000;
    while (true) {
      report.faultBeforeCancel = await control("state");
      if (client === "okhttp" && scenario.startsWith("dns")) {
        const resources = await page.evaluate(`${state}.stream.resources()`);
        report.expectedDnsHost = resources.dnsHost;
      }
      const dnsObserved = client === "okhttp" ? Boolean(report.expectedDnsHost && report.faultBeforeCancel.dns.heldNames.includes(report.expectedDnsHost)) : report.faultBeforeCancel.dns.held > 0;
      if (scenario === "syn" ? report.faultBeforeCancel.synPackets > 0 && report.faultBeforeCancel.synSockets > 0 : dnsObserved) break;
      assert.ok(Date.now() < end, "Required SYN_SENT or held DNS query was not observed");
      assert.equal((await page.evaluate(`${state}.events`)).length, 0, "Request ended before controlled fault");
      await delay(20);
    }
    const stoppedAt = Date.now();
    if (scenario === "dns-deadline") {
      // 明确越过原6000ms总时限，观察终态是否真的等待解析结束；不调整原超时。
      await delay(6500);
      report.terminalBeforeDnsRelease = await page.evaluate(`${state}.events`);
      report.deadlineStopsWorkerWhileDnsHeld = report.terminalBeforeDnsRelease.length === 1;
    } else {
      await page.evaluate(`(() => { ${state}.cancelAt = performance.now();
        return ${state}.stream.cancel({requestId: ${JSON.stringify(requestId)}}); })()`);
      report.cancelAcknowledgementMs = Date.now() - stoppedAt;
      assert.ok(report.cancelAcknowledgementMs < 1000, "Cancellation blocked the bridge");
      const localStarted = Date.now();
      const local = await page.evaluate(`(async () => {
        const id = 'connect_local_${crypto.randomUUID()}';
        const once = await ${state}.store.append({id});
        const twice = await ${state}.store.append({id});
        return {once, twice};
      })()`);
      report.localWriteMs = Date.now() - localStarted;
      assert.ok(report.localWriteMs < 1000, "Network cancellation blocked local storage");
      assert.deepEqual(local.once, local.twice, "Replay changed the ledger");
      assert.equal(local.once.total_cents, before.total_cents + 123);
      assert.equal(local.once.entries.length, before.entries.length + 1);
      const entries = new Map(local.once.entries.map(entry => [entry.id, entry]));
      for (const entry of before.entries) assert.deepEqual(entries.get(entry.id), entry);
      if (["dns", "dns-system"].includes(scenario)) {
        await delay(1200);
        report.terminalBeforeDnsRelease = await page.evaluate(`${state}.events`);
      }
    }
    if (scenario.startsWith("dns")) {
      report.dnsHoldObservedMs = Date.now() - stoppedAt;
      if (client === "okhttp" && scenario !== "dns-system") {
        report.resourcesBeforeDnsRelease = await page.evaluate(`${state}.stream.resources()`);
        const resources = report.resourcesBeforeDnsRelease;
        assert.equal(resources.active, false);
        for (const key of ["workers", "resolutions", "dnsSockets", "httpCalls", "connections"]) assert.equal(resources[key], 0, key);
        assert.equal(report.terminalBeforeDnsRelease.length, 1, "Candidate still waits for DNS release");
        const reuse = await page.evaluate(`(async () => {
          const id = 'reuse_${crypto.randomUUID()}';
          ${state}.reuseEvents = [];
          ${state}.reuseListener = await ${state}.stream.addListener('stream', event => {
            if (event.requestId === id) ${state}.reuseEvents.push(event);
          });
          await ${state}.stream.start({requestId: id, transport: 'http'});
          return id;
        })()`);
        report.reusedBeforeDnsRelease = await page.until(`${state}.reuseEvents.some(e => e.type !== 'chunk') ? ${state}.reuseEvents : null`);
        assert.equal(report.reusedBeforeDnsRelease.at(-1).type, "done", reuse);
        await page.evaluate(`${state}.reuseListener.remove()`);
      }
      report.released = await control("release", "POST");
    }
    const events = await page.until(`${state}.events.some(e => e.type !== 'chunk') ? ${state}.events : null`, 10000);
    report.terminalAfterStopMs = Date.now() - stoppedAt;
    assert.equal(events.length, 1, "Pre-connection experiment must have one terminal and no chunks");
    assert.equal(events[0].type, scenario === "dns-deadline" ? "error" : "cancelled");
    assert.equal(events[0].data, scenario === "dns-deadline" ? "DEADLINE" : "");
    report.events = events;
    report.cancelToTerminalMs = scenario === "dns-deadline" ? null :
      await page.evaluate(`${state}.terminalAt - ${state}.cancelAt`);
    report.promptCancellationPassed = scenario === "dns-deadline" ? null : report.cancelToTerminalMs < 1000;
    if (client === "okhttp" && scenario !== "dns-system") {
      if (scenario === "dns-deadline") assert.ok(events[0].elapsedMs >= 5900 && events[0].elapsedMs < 6500);
      else assert.equal(report.promptCancellationPassed, true, "Candidate must really cancel within one second");
    }
    report.faultAfterTerminal = await control("state");
    assert.equal(report.faultAfterTerminal.synSockets, 0, "Socket remained in SYN_SENT after terminal");
  } else {
    report.events = await page.until(`${state}.events.some(e => e.type !== 'chunk') ? ${state}.events : null`);
    assert.equal(report.events.at(-1).type, "done");
    assert.equal(report.events.filter(e => e.type === "chunk").length, 3);
  }
  const after = await page.evaluate(`${state}.store.read()`);
  report.local = {before: {count: before.entries.length, cents: before.total_cents}, after: {count: after.entries.length, cents: after.total_cents}};
  if (["baseline", "dns-deadline"].includes(scenario)) assert.deepEqual(after, before);
  await delay(200);
  assert.deepEqual(await page.evaluate(`${state}.events`), report.events, "Events arrived after terminal");
  console.log(JSON.stringify({fixtureAssertionsPassed: true, ...report}, null, 2));
} finally {
  if (scenario.startsWith("dns")) await control("release", "POST").catch(() => {});
  await page.evaluate(`(async () => {
    if (${state}) {
      try { await ${state}.stream.cancel({requestId: ${JSON.stringify(requestId)}}); } catch {}
      await ${state}.listener.remove();
      delete ${state};
    }
  })()`).catch(() => {});
  page.close();
}
