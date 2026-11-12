// 旧Android原生DNS协议增补；固定对端，账本只读。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
assert.ok(process.argv.length === 4 && process.argv[2] === "--port", "Usage: check-android-dns-codec.mjs --port PORT");
const page = await connectProbe(process.argv[3]);
const report = {scenario: "dns-codec", client: "okhttp", cases: {}};
const state = "window.__codecCheck";
async function fixture(path = "/state", post = false) {
  const response = await fetch(`http://127.0.0.1:18517${path}`, {method: post ? "POST" : "GET", signal: AbortSignal.timeout(3000)});
  assert.equal(response.status, 200); return response.json();
}
async function waitFixture(test) {
  for (let i = 0; i < 100; i++) { const value = await fixture(); if (test(value.dns)) return value.dns; await delay(30); }
  throw Error("DNS protocol condition not observed");
}
async function finished(id, type, detail = "") {
  const events = await page.until(`${state}.events[${JSON.stringify(id)}].some(e => e.type !== 'chunk') ? ${state}.events[${JSON.stringify(id)}] : null`, 8000);
  assert.equal(events.filter(e => e.type !== "chunk").length, 1);
  assert.equal(events.at(-1).type, type); assert.equal(events.at(-1).data, detail);
  const resources = await page.evaluate(`${state}.stream.resources()`);
  assert.equal(resources.active, false);
  for (const key of ["workers", "resolutions", "dnsSockets", "httpCalls", "connections"]) assert.equal(resources[key], 0, key);
  return {events, resources};
}
async function start(mode) {
  await fixture(`/mode/${mode}`, true);
  const id = `codec_${crypto.randomUUID()}`;
  await page.evaluate(`(async () => {
    ${state}.events[${JSON.stringify(id)}] = [];
    await ${state}.stream.start({requestId:${JSON.stringify(id)},transport:'dns-valid'});
  })()`);
  return id;
}
async function server(id) {
  return (await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`, {signal: AbortSignal.timeout(3000)})).json();
}
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (api.Capacitor.getPlatform() !== 'android') throw Error('Not native Android');
    ${state} = {stream:api.registerPlugin('ProbeAsyncStream'),credentials:api.registerPlugin('ProbeStream'),store:api.registerPlugin('ProbeStore'),events:{}};
    ${state}.listener = await ${state}.stream.addListener('stream', event => {
      const events = ${state}.events[event.requestId]; if (events) events.push(event);
    });
  })()`);
  assert.equal((await page.evaluate(`${state}.stream.resources()`)).resolver, "minidns-core-owned-io", "Use the legacy codec branch");
  const before = await page.evaluate(`${state}.store.read()`);
  await page.evaluate(`${state}.credentials.prepareCredentialFixture()`);
  for (const mode of ["cname", "tcp"]) {
    const id = await start(mode);
    const result = await finished(id, "done");
    assert.deepEqual(result.events.filter(e => e.type === "chunk").map(e => JSON.parse(e.data).text), ["旅途1", "旅途2", "旅途3"]);
    const observation = await server(id);
    assert.equal(observation.fixtureHost, "valid.p0-dns.invalid:18511");
    assert.equal(observation.fixtureSni, "valid.p0-dns.invalid");
    assert.equal(observation.authorized, true);
    const dns = await waitFixture(value => value.tcpActive === 0);
    assert.ok(dns.queries.some(q => mode === "cname" ? q.name === "answer.p0-dns.invalid" : q.protocol === "tcp"));
    report.cases[mode] = {...result, observation, dns};
  }
  for (const mode of ["loop", "ipv6", "truncated-tcp"]) {
    const id = await start(mode);
    const result = await finished(id, "error", "DNS_FAILED");
    assert.equal(await server(id), null);
    report.cases[mode] = {...result, dns: await waitFixture(value => value.tcpActive === 0)};
  }
  for (const mode of ["cancel", "deadline"]) {
    const id = await start("tcp-hold");
    await waitFixture(value => value.tcpActive === 1 && value.queries.some(q => q.protocol === "tcp"));
    const started = Date.now();
    if (mode === "cancel") await page.evaluate(`${state}.stream.cancel({requestId:${JSON.stringify(id)}})`);
    const result = await finished(id, mode === "cancel" ? "cancelled" : "error", mode === "cancel" ? "" : "DEADLINE");
    const cancelMs = Date.now() - started;
    if (mode === "cancel") assert.ok(cancelMs < 1000);
    else assert.ok(result.events.at(-1).elapsedMs >= 5900 && result.events.at(-1).elapsedMs < 7000);
    const dns = await waitFixture(value => value.tcpActive === 0 && value.tcpPeerClosed === 1);
    assert.equal(await server(id), null);
    await delay(150);
    assert.equal((await page.evaluate(`${state}.events[${JSON.stringify(id)}]`)).length, 1);
    report.cases[mode] = {...result, cancelMs, dns};
  }
  await fixture("/mode/direct", true);
  const after = await page.evaluate(`${state}.store.read()`);
  assert.deepEqual(after, before, "Read-only protocol checks changed the ledger");
  report.ledger = after;
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page.evaluate(`(async () => { if (${state}?.listener) await ${state}.listener.remove(); })()`);
  page.close();
}
