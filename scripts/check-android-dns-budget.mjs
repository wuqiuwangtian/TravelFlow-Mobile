// 旧系统固定双DNS实验；不接收任意地址，不写账本，不重发HTTP。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
assert.ok(process.argv.length === 4 && process.argv[2] === "--port", "Usage: check-android-dns-budget.mjs --port PORT");
const page = await connectProbe(process.argv[3]);
const state = "window.__dnsBudget";
const report = {scenario:"budget",cases:{}};
async function control(path = "state", post = false) {
  const response = await fetch(`http://127.0.0.1:18517/${path}`, {method:post ? "POST" : "GET",signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200); return response.json();
}
async function observed(test) {
  for (let i = 0; i < 100; i++) { const value = await control(); if (test(value)) return value; await delay(30); }
  throw Error("DNS budget fixture state not observed");
}
async function mode(primary, backup) {
  await observed(value => value.dns.tcpActive === 0 && value.backupDns.tcpActive === 0);
  await control(`mode/${primary}`,true); await control(`backup/${backup}`,true);
}
async function start() {
  const id = `budget_${crypto.randomUUID()}`;
  report.inFlight = {requestId:id};
  await page.evaluate(`(async () => {
    ${state}.events[${JSON.stringify(id)}] = [];
    await ${state}.stream.start({requestId:${JSON.stringify(id)},transport:'dns-valid',resolver:'fixture-pair'});
  })()`);
  return id;
}
async function finished(id, type, detail = "") {
  const events = await page.until(`${state}.events[${JSON.stringify(id)}].some(e => e.type !== 'chunk') ? ${state}.events[${JSON.stringify(id)}] : null`);
  report.inFlight.events = events;
  assert.equal(events.filter(event => event.type !== "chunk").length,1);
  assert.equal(events.at(-1).type,type,JSON.stringify(events)); assert.equal(events.at(-1).data,detail);
  const resources = await page.evaluate(`${state}.stream.resources()`);
  report.inFlight.resources = resources;
  assert.equal(resources.active,false);
  for (const key of ["workers","resolutions","dnsSockets","httpCalls","connections","networkWatches"]) assert.equal(resources[key],0,key);
  const fixture = await observed(value => value.probeOwnedSockets === 0);
  report.inFlight.fixture = fixture;
  const observation = await (await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`,{signal:AbortSignal.timeout(3000)})).json();
  report.inFlight.observation = observation;
  if (type === "done") {
    assert.equal(observation.authorized,true);
    assert.equal(observation.fixtureHost,"valid.p0-dns.invalid:18511");
    assert.equal(observation.fixtureSni,"valid.p0-dns.invalid");
    assert.deepEqual(events.filter(event => event.type === "chunk").map(event => JSON.parse(event.data).text),["旅途1","旅途2","旅途3"]);
  } else assert.equal(observation,null,"Failed DNS request reached HTTP");
  return {events,resources,fixture,observation};
}
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (api.Capacitor.getPlatform() !== 'android') throw Error('Not native Android');
    ${state} = {stream:api.registerPlugin('ProbeAsyncStream'),store:api.registerPlugin('ProbeStore'),credentials:api.registerPlugin('ProbeStream'),events:{}};
    ${state}.listener = await ${state}.stream.addListener('stream',event => { const events = ${state}.events[event.requestId]; if (events) events.push(event); });
  })()`);
  assert.equal((await page.evaluate(`${state}.stream.resources()`)).resolver,"minidns-core-owned-io");
  report.before = await page.evaluate(`${state}.store.read()`);
  await page.evaluate(`${state}.credentials.prepareCredentialFixture()`);
  for (const primary of ["drop","servfail","refused","tcp-delay"]) {
    await mode(primary,"direct");
    const id = await start();
    const result = await finished(id,"done");
    for (const dns of [result.fixture.dns,result.fixture.backupDns]) {
      assert.ok([1,28].every(type => dns.queries.some(query => query.type === type)),"A/AAAA did not both reach each DNS server");
    }
    if (primary === "tcp-delay") assert.ok(result.fixture.dns.queries.some(query => query.protocol === "tcp"));
    report.cases[primary] = result;
  }
  await mode("nxdomain","direct");
  const nx = await start();
  report.cases.nxdomain = await finished(nx,"error","DNS_FAILED");
  assert.equal(report.cases.nxdomain.fixture.backupDns.queries.length,0,"NXDOMAIN must not try backup");
  await mode("drop","drop");
  const deadline = await start();
  report.cases.deadline = await finished(deadline,"error","DEADLINE");
  assert.ok(report.cases.deadline.events.at(-1).elapsedMs >= 5900 && report.cases.deadline.events.at(-1).elapsedMs < 7000);
  assert.ok(report.cases.deadline.fixture.dns.queries.length && report.cases.deadline.fixture.backupDns.queries.length);
  await mode("drop","drop");
  const cancelled = await start();
  const live = await observed(value => value.backupDns.queries.length > 0);
  assert.ok(live.probeOwnedSockets > 0,"No live DNS socket positive control");
  const stopped = Date.now();
  await page.evaluate(`${state}.stream.cancel({requestId:${JSON.stringify(cancelled)}})`);
  report.cases.cancelled = await finished(cancelled,"cancelled");
  report.cases.cancelled.cancelMs = Date.now() - stopped;
  assert.ok(report.cases.cancelled.cancelMs < 1000);
  await mode("direct","direct");
  report.cases.reuse = await finished(await start(),"done");
  assert.equal(report.cases.reuse.fixture.backupDns.queries.length,0,"Healthy primary unnecessarily contacted backup");
  await delay(200);
  for (const result of Object.values(report.cases)) {
    const id = result.events[0].requestId;
    assert.deepEqual(await page.evaluate(`${state}.events[${JSON.stringify(id)}]`),result.events,"Late DNS or HTTP events");
  }
  report.local = await page.evaluate(`${state}.store.read()`);
  assert.deepEqual(report.local,report.before,"Read-only DNS budget check changed records");
  delete report.inFlight;
  report.fixtureAssertionsPassed = true;
  console.log(JSON.stringify(report,null,2));
} catch (error) {
  report.fixtureAssertionsPassed = false;
  console.log(JSON.stringify(report,null,2));
  throw error;
} finally {
  await page.evaluate(`(async () => { if (${state}?.listener) await ${state}.listener.remove(); })()`);
  page.close();
}
