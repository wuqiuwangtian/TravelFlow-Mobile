// 固定虚构TLS/Keystore实验；必须由操作者先明确隔离设备与CDP转发。
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { connectProbe } from "./lib/android-probe-cdp.mjs";

const args = process.argv.slice(2);
if (![2, 3].includes(args.length) || args[0] !== "--port" ||
    (args.length === 3 && !["--expect-untrusted", "--cold-start", "--expect-credential-failure"].includes(args[2]))) {
  throw new Error("Usage: node scripts/check-android-tls.mjs --port FORWARDED_CDP_PORT [--expect-untrusted|--cold-start|--expect-credential-failure]");
}
const page = await connectProbe(args[1]);
const {evaluate, until, tap} = page;
const report = {};
const key = (id) => `window.__tlsCheck.events[${JSON.stringify(id)}]`;
async function start(transport, mode = "normal") {
  const requestId = `tls_${crypto.randomUUID()}`;
  await evaluate(`(async () => {
    ${key(requestId)} = [];
    await window.__tlsCheck.stream.start(${JSON.stringify({requestId, mode, transport})});
  })()`);
  return requestId;
}
async function finished(id, type, detail) {
  const events = await until(`(() => { const e = ${key(id)}; return e.some(x => x.type !== 'chunk') ? e : null; })()`);
  assert.equal(events.filter((event) => event.type !== "chunk").length, 1);
  assert.equal(events.at(-1).type, type);
  assert.equal(events.at(-1).data, detail);
  return events;
}
async function fixture(path, id = "check") {
  return (await fetch(`http://127.0.0.1:18510/${path}?requestId=${id}`)).json();
}
async function waitFixture(path, predicate, id) {
  for (let i = 0; i < 100; i++) {
    const result = await fixture(path, id);
    if (predicate(result)) return result;
    await delay(50);
  }
  throw new Error(`Fixture observation timed out: ${path}`);
}
async function transport(value) {
  await evaluate(`(() => {
    const select = document.getElementById('transport');
    if (select.disabled) throw Error('Transport control disabled');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change'));
  })()`);
}
try {
  await until(`document.getElementById('runtime').textContent === 'Android原生桥已就绪'`);
  await evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (!api.Capacitor.isNativePlatform()) throw Error('Not a native runtime');
    const stream = api.registerPlugin('ProbeStream');
    window.__tlsCheck = {stream, store: api.registerPlugin('ProbeStore'), events: {}};
    window.__tlsCheck.listener = await stream.addListener('stream', event => {
      const events = window.__tlsCheck.events[event.requestId];
      if (events) events.push(event);
    });
  })()`);
  report.initialLocal = await evaluate("window.__tlsCheck.store.read().then(s => ({count: s.entries.length, cents: s.total_cents}))");
  if (!["--cold-start", "--expect-credential-failure"].includes(args[2])) {
    await evaluate("window.__tlsCheck.stream.prepareCredentialFixture()");
  }
  if (args[2] === "--expect-untrusted") {
    const id = await start("https");
    report.systemTrust = await finished(id, "error", "TLS_FAILED");
    assert.equal(await fixture("observations", id), null, "No HTTP credential may reach a server with an untrusted certificate");
  } else if (args[2] === "--expect-credential-failure") {
    const id = await start("https");
    report.credentialFailure = await finished(id, "error", "CREDENTIAL_UNAVAILABLE");
    assert.equal(await fixture("observations", id), null);
    const after = await evaluate("window.__tlsCheck.store.read().then(s => s.total_cents)");
    assert.equal(after, report.initialLocal.cents);
  } else if (args[2] === "--cold-start") {
    report.coldRead = await finished(await start("https"), "done", "");
  } else {
    // 选择器脚本设值；新增凭据和网络按钮使用页面CDP真实触摸。
    await transport("https");
    await tap("credential-clear");
    await until(`document.getElementById('credential-status').textContent.includes('已移除')`);
    await tap("stream");
    await until(`document.getElementById('stream-status').textContent.includes('CREDENTIAL_UNAVAILABLE')`);
    await tap("credential-prepare");
    await until(`document.getElementById('credential-status').textContent.includes('已加密保存')`);
    await tap("stream");
    await until(`document.getElementById('stream-status').textContent.includes('终态：done')`);
    report.touchTls = await evaluate("document.getElementById('stream-events').textContent");
    for (const value of ["untrusted", "hostname", "expired"]) {
      await transport(value);
      await tap("stream");
      await until(`document.getElementById('stream-status').textContent.includes('TLS_FAILED')`);
    }
    await transport("https");
    for (const id of ["no-auth", "unauthorized", "redirect"]) {
      await tap(id);
      await until(`document.getElementById('stream-status').textContent.includes('HTTP_STATUS')`);
    }
    await tap("drip");
    await until(`document.getElementById('stream-status').textContent.includes('DEADLINE')`);
    await transport("handshake");
    await tap("stream");
    await until(`document.getElementById('stream-status').textContent.includes('CONNECT_TIMEOUT')`);
    await tap("stream");
    await delay(200);
    await tap("cancel");
    await until(`document.getElementById('stream-status').textContent.includes('终态：cancelled')`);
    await transport("http");

    const valid = await start("https");
    report.valid = await finished(valid, "done", "");
    assert.deepEqual(report.valid.filter(e => e.type === "chunk").map(e => JSON.parse(e.data).text), ["旅途1", "旅途2", "旅途3"]);
    report.validServer = await fixture("observations", valid);
    assert.equal(report.validServer.authorized, true);
    report.certificates = {};
    for (const value of ["untrusted", "hostname", "expired"]) {
      const id = await start(value);
      report.certificates[value] = await finished(id, "error", "TLS_FAILED");
      assert.equal(await fixture("observations", id), null);
    }
    report.authentication = {};
    for (const mode of ["no-auth", "unauthorized", "redirect"]) {
      const id = await start("https", mode);
      const events = await finished(id, "error", "HTTP_STATUS");
      assert.equal(events.at(-1).httpStatus, mode === "redirect" ? 307 : 401);
      report.authentication[mode] = {events, server: await fixture("observations", id)};
      if (mode !== "redirect") assert.equal(report.authentication[mode].server.authorized, false);
      assert.equal(await fixture("observations", "leak_" + id), null, "Redirect target must never receive credentials");
    }

    const before = (await fixture("handshakes")).at(-1)?.sequence ?? 0;
    const connecting = await start("handshake");
    await waitFixture("handshakes", rows => rows.at(-1)?.sequence > before && rows.at(-1).receivedBytes > 0);
    const cancelledAt = Date.now();
    await evaluate(`window.__tlsCheck.stream.cancel({requestId: ${JSON.stringify(connecting)}})`);
    report.local = await evaluate(`(async () => {
      const store = window.__tlsCheck.store;
      const before = await store.read();
      const id = 'tls_local_${crypto.randomUUID()}';
      const once = await store.append({id});
      const twice = await store.append({id});
      return {before: before.total_cents, once: once.total_cents, twice: twice.total_cents};
    })()`);
    assert.equal(report.local.once - report.local.before, 123);
    assert.equal(report.local.twice, report.local.once);
    report.connectCancelled = await finished(connecting, "cancelled", "");
    report.connectCancelLatencyMs = Date.now() - cancelledAt;
    report.connectCancelServer = (await waitFixture("handshakes", rows => rows.at(-1).outcome !== "accepted")).at(-1);
    report.connectTimeout = await finished(await start("handshake"), "error", "CONNECT_TIMEOUT");

    const drip = await start("https", "drip");
    report.deadline = await finished(drip, "error", "DEADLINE");
    assert.ok(report.deadline.filter(e => e.type === "chunk").length >= 2);
    assert.ok(report.deadline.at(-1).elapsedMs >= 2400 && report.deadline.at(-1).elapsedMs < 3500);
    report.deadlineServer = await waitFixture("observations", row => row && row.outcome !== "running", drip);
    assert.equal(report.deadlineServer.outcome, "peer_closed");

    await evaluate("window.__tlsCheck.stream.clearCredentialFixture()");
    const missing = await start("https");
    report.missingCredential = await finished(missing, "error", "CREDENTIAL_UNAVAILABLE");
    assert.equal(await fixture("observations", missing), null);
    await evaluate("window.__tlsCheck.stream.prepareCredentialFixture()");
    report.recovered = await finished(await start("https"), "done", "");
    report.finalLocal = await evaluate("window.__tlsCheck.store.read().then(s => ({count: s.entries.length, cents: s.total_cents}))");
    assert.equal(report.finalLocal.cents, report.local.once);
    // 不将等到连接超时才结束伪装成即时取消。保留完整报告后明确失败。
    report.connectCancellationPassed = report.connectCancelLatencyMs < 1000 &&
      report.connectCancelServer.outcome === "peer_closed" && report.connectCancelServer.elapsedMs < 1200;
  }
  assert.doesNotMatch(JSON.stringify(report), /fixture-(?:stream|wrong)-token/);
  console.log(JSON.stringify({passed: report.connectCancellationPassed !== false, ...report}, null, 2));
  assert.notEqual(report.connectCancellationPassed, false, "TLS connection-stage cancellation waited for timeout; transport needs review");
} finally {
  try {
    await evaluate(`(async () => {
      if (!window.__tlsCheck) return;
      for (const [requestId, events] of Object.entries(window.__tlsCheck.events)) {
        if (!events.some(x => x.type !== 'chunk')) {
          try { await window.__tlsCheck.stream.cancel({requestId}); } catch {}
        }
      }
      await window.__tlsCheck.listener.remove();
      delete window.__tlsCheck;
    })()`);
  } finally { page.close(); }
}
