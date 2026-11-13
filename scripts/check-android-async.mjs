// 可选debug客户端：DNS结果必须用于域名HTTPS，证书、SNI、取消和资源回收分别检查。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
assert.ok(process.argv.length === 4 && process.argv[2] === "--port", "Usage: check-android-async.mjs --port PORT");
const page = await connectProbe(process.argv[3]);
const report = {scenario: "dns-tls", client: "okhttp"};
const state = "window.__asyncCheck";
async function observation(path, id = "check") {
  return (await fetch(`http://127.0.0.1:18510/${path}?requestId=${id}`, {signal: AbortSignal.timeout(3000)})).json();
}
async function waitObservation(path, id, test) {
  for (let i = 0; i < 100; i++) { const value = await observation(path, id); if (test(value)) return value; await delay(30); }
  throw Error(`Fixture observation missing: ${path}`);
}
async function start(transport, mode = "normal", after = 0) {
  const id = `async_${crypto.randomUUID()}`;
  await page.evaluate(`(async () => {
    ${state}.events[${JSON.stringify(id)}] = [];
    await ${state}.stream.start(${JSON.stringify({requestId: id, transport, mode, after})});
  })()`);
  return id;
}
async function finished(id, type, data = "") {
  const events = await page.until(`${state}.events[${JSON.stringify(id)}].some(e => e.type !== 'chunk') ? ${state}.events[${JSON.stringify(id)}] : null`, 8000);
  assert.equal(events.filter(e => e.type !== "chunk").length, 1);
  assert.equal(events.at(-1).type, type); assert.equal(events.at(-1).data, data);
  const resources = await page.evaluate(`${state}.stream.resources()`);
  assert.equal(resources.active, false);
  for (const key of ["workers", "resolutions", "dnsSockets", "httpCalls", "connections", "networkWatches"]) assert.equal(resources[key], 0, key);
  return {events, resources};
}
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (api.Capacitor.getPlatform() !== 'android') throw Error('Not native Android');
    ${state} = {stream: api.registerPlugin('ProbeAsyncStream'), credentials: api.registerPlugin('ProbeStream'), store: api.registerPlugin('ProbeStore'), events: {}};
    ${state}.listener = await ${state}.stream.addListener('stream', event => {
      const events = ${state}.events[event.requestId]; if (events) events.push(event);
    });
  })()`);
  const before = await page.evaluate(`${state}.store.read()`);
  if ((await page.evaluate(`${state}.stream.resources()`)).resolver === "android-dnsresolver") {
    const id = `reject_pair_${crypto.randomUUID()}`;
    const code = await page.evaluate(`(async () => {
      try { await ${state}.stream.start({requestId:${JSON.stringify(id)},transport:'dns-valid',resolver:'fixture-pair'}); }
      catch (error) { return error.code; }
      return null;
    })()`);
    assert.equal(code,"INVALID_OPTIONS","New platforms must reject the legacy fixture resolver");
    assert.equal(await observation("observations",id),null);
    report.legacyFixtureRejected = true;
  }
  await page.evaluate(`${state}.credentials.clearCredentialFixture()`);
  const missing = await start("dns-valid");
  report.missingCredential = await finished(missing, "error", "CREDENTIAL_UNAVAILABLE");
  assert.equal(await observation("observations", missing), null);
  await page.evaluate(`${state}.credentials.prepareCredentialFixture()`);
  report.valid = {};
  for (const transport of ["https", "dns-valid"]) {
    const id = await start(transport);
    const value = await finished(id, "done");
    assert.deepEqual(value.events.filter(e => e.type === "chunk").map(e => JSON.parse(e.data).text), ["旅途1", "旅途2", "旅途3"]);
    const server = await observation("observations", id);
    assert.equal(server.authorized, true);
    if (transport === "dns-valid") {
      assert.equal(server.fixtureHost, "valid.p0-dns.invalid:18511");
      assert.equal(server.fixtureSni, "valid.p0-dns.invalid");
    }
    report.valid[transport] = {...value, server};
  }
  report.invalidCertificates = {};
  for (const transport of ["dns-untrusted", "dns-hostname", "dns-expired"]) {
    const id = await start(transport);
    report.invalidCertificates[transport] = await finished(id, "error", "TLS_FAILED");
    assert.equal(await observation("observations", id), null, "Invalid TLS peer received an HTTP request");
  }
  report.httpStatus = {};
  for (const mode of ["no-auth", "unauthorized", "redirect"]) {
    const id = await start("dns-valid", mode);
    report.httpStatus[mode] = await finished(id, "error", "HTTP_STATUS");
    assert.equal(report.httpStatus[mode].events.at(-1).httpStatus, mode === "redirect" ? 307 : 401);
    assert.equal(await observation("observations", `leak_${id}`), null);
  }
  const httpError = await start("dns-valid", "http-error");
  report.httpError = await finished(httpError, "error", "HTTP_STATUS");
  assert.equal(report.httpError.events.at(-1).httpStatus, 503);
  const dropped = await start("dns-valid", "drop");
  report.dropped = await finished(dropped, "error", "NETWORK_OR_PROTOCOL");
  assert.equal(report.dropped.events.filter(e => e.type === "chunk").length, 1);
  const resumed = await start("dns-valid", "normal", 1);
  report.resumed = await finished(resumed, "done");
  assert.deepEqual(report.resumed.events.filter(e => e.type === "chunk").map(e => JSON.parse(e.data).text), ["旅途2", "旅途3"]);
  assert.equal((await observation("observations", resumed)).after, 1);
  const drip = await start("dns-valid", "drip");
  report.deadlineReading = await finished(drip, "error", "DEADLINE");
  assert.ok(report.deadlineReading.events.at(-1).elapsedMs >= 2400 && report.deadlineReading.events.at(-1).elapsedMs < 3500);
  const previous = (await observation("handshakes")).at(-1)?.sequence ?? 0;
  const handshake = await start("handshake");
  await waitObservation("handshakes", "check", rows => rows.at(-1)?.sequence > previous && rows.at(-1).receivedBytes > 0);
  let cancelledAt = Date.now();
  await page.evaluate(`${state}.stream.cancel({requestId: ${JSON.stringify(handshake)}})`);
  report.handshakeCancelled = await finished(handshake, "cancelled");
  report.handshakeCancelMs = Date.now() - cancelledAt;
  assert.ok(report.handshakeCancelMs < 1000);
  await waitObservation("handshakes", "check", rows => rows.at(-1).outcome === "peer_closed");
  const stalled = await start("dns-valid", "stall");
  await page.until(`${state}.events[${JSON.stringify(stalled)}].some(e => e.type === 'chunk')`);
  const guards = await page.evaluate(`(async () => {
    const result = {};
    try { await ${state}.stream.start({requestId:'must_reject_concurrent'}); } catch(e) { result.concurrent = e.code; }
    try { await ${state}.stream.cancel({requestId:'must_reject_wrong_id'}); } catch(e) { result.wrongId = e.code; }
    return result;
  })()`);
  assert.deepEqual(guards, {concurrent: "STREAM_BUSY", wrongId: "NO_ACTIVE_STREAM"});
  report.guards = guards;
  cancelledAt = Date.now();
  await page.evaluate(`${state}.stream.cancel({requestId: ${JSON.stringify(stalled)}})`);
  report.readingCancelled = await finished(stalled, "cancelled");
  report.readingCancelMs = Date.now() - cancelledAt;
  assert.ok(report.readingCancelMs < 1000);
  await waitObservation("observations", stalled, row => row?.outcome === "peer_closed");
  const timeout = await start("dns-valid", "stall");
  report.readingTimeout = await finished(timeout, "error", "TIMEOUT");
  report.immediateCancellation = [];
  for (let i = 0; i < 3; i++) {
    const id = await start("http");
    const time = Date.now();
    await page.evaluate(`${state}.stream.cancel({requestId: ${JSON.stringify(id)}})`);
    const value = await finished(id, "cancelled");
    assert.ok(Date.now() - time < 1000);
    report.immediateCancellation.push(value);
  }
  const after = await page.evaluate(`${state}.store.read()`);
  assert.deepEqual(after, before, "TLS/resolver checks changed local records");
  report.local = {count: after.entries.length, cents: after.total_cents};
  await delay(200);
  assert.deepEqual(await page.evaluate(`${state}.events[${JSON.stringify(timeout)}]`), report.readingTimeout.events);
  console.log(JSON.stringify({fixtureAssertionsPassed: true, ...report}, null, 2));
} finally {
  await page.evaluate(`(async () => {
    if (${state}) {
      for (const id of Object.keys(${state}.events)) try { await ${state}.stream.cancel({requestId:id}); } catch {}
      await ${state}.listener.remove(); delete ${state};
    }
  })()`).catch(() => {});
  page.close();
}
