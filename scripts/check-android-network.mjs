// 由专用AVD控制器改变虚拟无线状态；只使用固定虚构服务与固定123分记录。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
const args = process.argv.slice(2);
assert.ok([2,3].includes(args.length) && args[0] === "--port" && (args.length === 2 || args[2] === "--offline"), "Usage: check-android-network.mjs --port PORT [--offline]");
const page = await connectProbe(args[1]);
const state = "window.__networkCheck";
const report = {scenario:args[2] ? "network-offline-cold" : "dns-network", cases:{}};
async function control(path, post = false) {
  const response = await fetch(`http://127.0.0.1:18517/${path}`, {method:post ? "POST" : "GET", signal:AbortSignal.timeout(15000)});
  assert.equal(response.status, 200); return response.json();
}
async function observed(test) {
  for (let i = 0; i < 100; i++) { const value = await control("state"); if (await test(value)) return value; await delay(30); }
  throw Error("Expected network fixture state not observed");
}
async function resources() { return page.evaluate(`${state}.stream.resources()`); }
async function networkReady(available) {
  return page.until(`(async () => { const value = await ${state}.stream.resources(); return Boolean(value.currentNetwork) === ${available} ? value : null; })()`, 15000);
}
async function stableNetwork() {
  let previous = "", unchangedSince = Date.now();
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await resources();
    if (!value.currentNetwork || value.currentNetwork !== previous) {
      previous = value.currentNetwork; unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= 750) return value;
    await delay(50);
  }
  throw Error("No stable virtual network after restore");
}
async function start(transport, mode = "normal") {
  const id = `network_${crypto.randomUUID()}`;
  await page.evaluate(`(async () => {
    ${state}.events[${JSON.stringify(id)}] = [];
    await ${state}.stream.start(${JSON.stringify({requestId:id,transport,mode})});
  })()`);
  return id;
}
async function finished(id) {
  const events = await page.until(`${state}.events[${JSON.stringify(id)}].some(e => e.type !== 'chunk') ? ${state}.events[${JSON.stringify(id)}] : null`);
  assert.equal(events.filter(e => e.type !== "chunk").length, 1);
  const value = await resources();
  assert.equal(value.active, false);
  for (const key of ["workers","resolutions","dnsSockets","httpCalls","connections","networkWatches"]) assert.equal(value[key], 0, key);
  return {events,resources:value};
}
async function appendOffline() {
  const before = await page.evaluate(`${state}.store.read()`);
  const id = `network_local_${crypto.randomUUID()}`;
  const started = Date.now();
  const value = await page.evaluate(`(async () => {
    const once = await ${state}.store.append({id:${JSON.stringify(id)}});
    const replay = await ${state}.store.append({id:${JSON.stringify(id)}});
    return {once,replay};
  })()`);
  assert.ok(Date.now() - started < 1000, "Networking blocked local storage");
  assert.deepEqual(value.replay, value.once);
  assert.equal(value.once.entries.length, before.entries.length + 1);
  assert.equal(value.once.total_cents, before.total_cents + 123);
  const records = new Map(value.once.entries.map(entry => [entry.id,entry]));
  for (const entry of before.entries) assert.deepEqual(records.get(entry.id), entry, "Existing record changed");
  return {count:value.once.entries.length,cents:value.once.total_cents};
}
async function server(id) {
  return (await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`, {signal:AbortSignal.timeout(3000)})).json();
}
async function success(label) {
  const id = await start("dns-valid");
  const result = await finished(id);
  assert.equal(result.events.at(-1).type,"done",JSON.stringify({label,...result,fault:await control("state")}));
  assert.deepEqual(result.events.filter(event => event.type === "chunk").map(event => JSON.parse(event.data).text),["旅途1","旅途2","旅途3"]);
  const observation = await server(id);
  assert.equal(observation.fixtureHost,"valid.p0-dns.invalid:18511");
  assert.equal(observation.fixtureSni,"valid.p0-dns.invalid");
  assert.equal(observation.authorized,true);
  return {...result,observation};
}
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (api.Capacitor.getPlatform() !== 'android') throw Error('Not native Android');
    ${state} = {stream:api.registerPlugin('ProbeAsyncStream'),store:api.registerPlugin('ProbeStore'),credentials:api.registerPlugin('ProbeStream'),events:{},terminalAt:{}};
    ${state}.listener = await ${state}.stream.addListener('stream', event => {
      const events = ${state}.events[event.requestId];
      if (events) { events.push(event); if (event.type !== 'chunk') ${state}.terminalAt[event.requestId] = performance.now(); }
    });
  })()`);
  report.before = await page.evaluate(`${state}.store.read()`);
  if (args[2]) {
    report.offline = await networkReady(false);
    const id = await start("http");
    report.rejected = await finished(id);
    assert.equal(report.rejected.events[0].data,"NETWORK_UNAVAILABLE");
    assert.equal(await server(id),null);
    report.saved = await appendOffline();
  } else {
    await stableNetwork();
    await page.evaluate(`${state}.credentials.prepareCredentialFixture()`);
    report.baseline = await success("baseline");
    const legacy = (await resources()).resolver === "minidns-core-owned-io";
    for (const phase of legacy ? ["dns","tcp","reading"] : ["dns","reading"]) {
      await control(`mode/${phase === "tcp" ? "tcp-hold" : "direct"}`,true);
      const initial = await stableNetwork();
      const id = await start(phase === "dns" ? "dns" : "dns-valid",phase === "reading" ? "stall" : "normal");
      if (phase === "reading") await page.until(`${state}.events[${JSON.stringify(id)}].some(e => e.type === 'chunk')`);
      else await observed(async value => phase === "tcp" ? value.dns.tcpActive === 1 : value.dns.heldNames.includes((await resources()).dnsHost));
      const active = await resources();
      assert.equal(active.active,true); assert.equal(active.networkWatches,1);
      assert.equal(active.boundNetwork,initial.currentNetwork);
      assert.ok(active.resolutions === 1 || phase === "reading");
      await page.evaluate(`${state}.switchedAt = performance.now()`);
      const radio = await control("network/off",true);
      const offline = await networkReady(false);
      const result = await finished(id);
      const terminal = result.events.at(-1);
      assert.equal(terminal.type,"error");
      assert.ok(["NETWORK_LOST","DNS_FAILED","NETWORK_OR_PROTOCOL","TIMEOUT"].includes(terminal.data));
      const stopToTerminalMs = await page.evaluate(`${state}.terminalAt[${JSON.stringify(id)}] - ${state}.switchedAt`);
      assert.ok(stopToTerminalMs < 3000,"Request did not terminate promptly after radio change");
      const callbackToTerminalMs = terminal.networkLostMs < 0 ? null : terminal.elapsedMs - terminal.networkLostMs;
      if (callbackToTerminalMs !== null) assert.ok(callbackToTerminalMs < 1000);
      const fault = await observed(value => value.probeOwnedSockets === 0);
      const local = await appendOffline();
      const failed = await start("http");
      const rejection = await finished(failed);
      assert.equal(rejection.events[0].data,"NETWORK_UNAVAILABLE");
      assert.equal(await server(failed),null);
      // 不释放旧DNS回复；先重建网络，再发明确的新请求，确认没有复用失效Network。
      await control("network/restore",true);
      const restored = await stableNetwork();
      assert.notEqual(restored.currentNetwork,initial.currentNetwork);
      await delay(200);
      assert.deepEqual(await page.evaluate(`${state}.events[${JSON.stringify(id)}]`),result.events,"Old request replayed or emitted late events");
      if (phase !== "reading") assert.equal(await server(id),null);
      // 断网可能阻断FIN；先确认应用已无FD，再单独标记测试对端的主动清理。
      const retired = phase === "tcp" ? await control("network/retire-dns-peer",true) : null;
      if (retired) await observed(value => value.dns.tcpActive === 0);
      await control("release",true);
      await control("mode/direct",true);
      const recovered = await success(`recovered_${phase}`);
      assert.equal(recovered.events.at(-1).boundNetwork,restored.currentNetwork);
      report.cases[phase] = {initial,active,radio,offline,...result,stopToTerminalMs,callbackToTerminalMs,fault,local,rejection,restored,retired,recovered};
    }
    for (const result of Object.values(report.cases)) {
      const id = result.events[0].requestId;
      assert.deepEqual(await page.evaluate(`${state}.events[${JSON.stringify(id)}]`),result.events,"Old request emitted after later network changes");
    }
    assert.ok(Object.values(report.cases).some(value => value.events.at(-1).data === "NETWORK_LOST"),"No actual network-loss callback exercised");
  }
  report.local = await page.evaluate(`${state}.store.read()`);
  report.fixtureAssertionsPassed = true;
  console.log(JSON.stringify(report,null,2));
} finally {
  await control("network/restore",true).catch(() => {});
  await control("release",true).catch(() => {});
  await page.evaluate(`(async () => { if (${state}?.listener) await ${state}.listener.remove(); })()`);
  page.close();
}
