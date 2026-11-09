// 连接已明确转发的隔离Android WebView；不启动浏览器、不选择或操作ADB设备。
// 仅向P0虚构数据库追加记录，不清库。Node22+，无需额外依赖。
import assert from "node:assert/strict";
import { connectProbe } from "./lib/android-probe-cdp.mjs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (![2, 3].includes(args.length) || args[0] !== "--port" || !/^\d{4,5}$/.test(args[1]) ||
    (args.length === 3 && args[2] !== "--offline")) {
  throw new Error("Usage: node scripts/check-android-stream.mjs --port FORWARDED_CDP_PORT [--offline]");
}
const page = await connectProbe(args[1]);
const {evaluate, until, tap} = page;
const events = (id) => `window.__streamCheck.events[${JSON.stringify(id)}]`;
async function start(mode, after = 0) {
  const id = `check_${crypto.randomUUID()}`;
  await evaluate(`(async () => {
    window.__streamCheck.events[${JSON.stringify(id)}] = [];
    await window.__streamCheck.stream.start(${JSON.stringify({requestId: id, mode, after})});
  })()`);
  return id;
}
async function finished(id, type, detail) {
  const list = await until(`(() => { const e = ${events(id)}; return e.some(x => x.type !== 'chunk') ? e : null; })()`);
  assert.equal(list.filter((event) => event.type !== "chunk").length, 1);
  assert.equal(list.at(-1).type, type);
  if (detail !== undefined) assert.equal(list.at(-1).data, detail);
  return list;
}
async function observation(id) {
  for (let i = 0; i < 50; i++) {
    const result = await (await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`)).json();
    if (result && result.outcome !== "running") return result;
    await delay(50);
  }
  throw new Error("Fixture observation timed out");
}
const report = {};
try {
  await until(`document.getElementById('runtime').textContent === 'Android原生桥已就绪'`);
  await evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    const {probeHost} = await import('./probe-endpoint.js');
    if (!api.Capacitor.isNativePlatform()) throw Error('Not a native runtime');
    if (!['10.0.2.2', '127.0.0.1'].includes(probeHost)) throw Error('Unknown fixed probe target');
    const stream = api.registerPlugin('ProbeStream');
    window.__streamCheck = {stream, store: api.registerPlugin('ProbeStore'), http: api.CapacitorHttp, probeHost, events: {}};
    window.__streamCheck.listener = await stream.addListener('stream', event => {
      const list = window.__streamCheck.events[event.requestId];
      if (list) list.push(event);
    });
  })()`);

  if (args[2] === "--offline") {
    // 网络隔离须由操作者对明确模拟器执行；此模式不会自行改变设备网络。
    report.networkFailure = await finished(await start("normal"), "error");
    report.local = await evaluate(`(async () => {
      const store = window.__streamCheck.store;
      const before = await store.read();
      const id = 'offline_${crypto.randomUUID()}';
      const once = await store.append({id});
      const twice = await store.append({id});
      return {before: before.total_cents, once: once.total_cents, twice: twice.total_cents};
    })()`);
    assert.equal(report.local.once - report.local.before, 123);
    assert.equal(report.local.twice, report.local.once);
    console.log(JSON.stringify({passed: true, mode: "offline-or-service-down", ...report}, null, 2));
  } else {
    // 原生触摸验证页面按钮、监听和终态恢复。
    await tap("stream");
    await until(`document.getElementById('stream-status').textContent.includes('终态：done')`);
    report.touch = await evaluate(`document.getElementById('stream-events').textContent`);
    assert.match(report.touch, /chunk.*旅途1/);
    assert.match(report.touch, /chunk.*旅途3/);
    await tap("stall");
    await until(`document.getElementById('stream-events').textContent.includes('chunk')`);
    await tap("cancel");
    await until(`document.getElementById('stream-status').textContent.includes('终态：cancelled')`);
    await tap("stall");
    await until(`document.getElementById('stream-status').textContent.includes('TIMEOUT')`);
    await tap("drop");
    await until(`document.getElementById('stream-status').textContent.includes('终态：error')`);
    await tap("resume");
    await until(`document.getElementById('stream-status').textContent.includes('终态：done')`);
    report.touchResume = await evaluate(`document.getElementById('stream-events').textContent`);
    assert.doesNotMatch(report.touchResume, /旅途1/);
    assert.match(report.touchResume, /旅途2/);
    assert.match(report.touchResume, /旅途3/);

    const normal = await start("normal");
    report.normal = await finished(normal, "done", "");
    const chunks = report.normal.filter((event) => event.type === "chunk");
    assert.deepEqual(chunks.map((event) => Number(event.eventId)), [1, 2, 3]);
    assert.deepEqual(chunks.map((event) => JSON.parse(event.data).text), ["旅途1", "旅途2", "旅途3"]);
    assert.ok(chunks[0].elapsedMs < 1000, "First event must arrive before full response");
    assert.ok(report.normal.at(-1).elapsedMs - chunks[0].elapsedMs > 1500);
    assert.ok(chunks[1].elapsedMs - chunks[0].elapsedMs > 300);

    // 同一服务下内置HTTP对照：只在整个响应结束后返回。
    report.bufferedHttp = await evaluate(`(async () => {
      const started = performance.now();
      const response = await window.__streamCheck.http.get({
        url: 'http://' + window.__streamCheck.probeHost + ':18510/stream?requestId=buffered_${crypto.randomUUID()}', responseType: 'text', readTimeout: 4000
      });
      return {elapsedMs: Math.round(performance.now() - started), status: response.status, data: response.data};
    })()`);
    assert.equal(report.bufferedHttp.status, 200);
    assert.ok(report.bufferedHttp.elapsedMs > 2400);
    assert.match(report.bufferedHttp.data, /\[DONE\]/);

    const cancelled = await start("stall");
    await until(`${events(cancelled)}.some(x => x.type === 'chunk')`);
    // 并发请求应明确拒绝，错误ID不能取消当前请求。
    report.guards = await evaluate(`(async () => {
      const rejected = [];
      for (const [method, options] of [
        ['start', {requestId: 'overlap', mode: 'normal'}],
        ['cancel', {requestId: 'wrong_request'}]
      ]) {
        try { await window.__streamCheck.stream[method](options); } catch (e) { rejected.push(e.code); }
      }
      return rejected;
    })()`);
    assert.deepEqual(report.guards, ["STREAM_BUSY", "NO_ACTIVE_STREAM"]);
    const cancelStarted = Date.now();
    await evaluate(`window.__streamCheck.stream.cancel({requestId: ${JSON.stringify(cancelled)}})`);
    // 取消正在关闭连接时，本地事务仍必须能提交且重放不翻倍。
    report.local = await evaluate(`(async () => {
      const store = window.__streamCheck.store;
      const before = await store.read();
      const id = 'stream_${crypto.randomUUID()}';
      const once = await store.append({id});
      const twice = await store.append({id});
      return {before: before.total_cents, once: once.total_cents, twice: twice.total_cents};
    })()`);
    assert.equal(report.local.once - report.local.before, 123);
    assert.equal(report.local.twice, report.local.once);
    report.cancelled = await finished(cancelled, "cancelled", "");
    report.cancelLatencyMs = Date.now() - cancelStarted;
    report.cancelServer = await observation(cancelled);
    assert.ok(report.cancelLatencyMs < 1000, "Cancellation must stop the blocked read promptly");
    assert.equal(report.cancelServer.outcome, "peer_closed");
    assert.equal(report.cancelServer.sent.length, 1);
    assert.ok(report.cancelServer.elapsedMs < 1200, "Peer must close before read timeout");
    report.earlyCancellation = [];
    for (let i = 0; i < 3; i++) {
      const id = await start("stall");
      await evaluate(`window.__streamCheck.stream.cancel({requestId: ${JSON.stringify(id)}})`);
      report.earlyCancellation.push(await finished(id, "cancelled", ""));
    }

    const stalled = await start("stall");
    report.timeout = await finished(stalled, "error", "TIMEOUT");
    report.timeoutServer = await observation(stalled);
    assert.ok(report.timeout.at(-1).elapsedMs >= 1400 && report.timeout.at(-1).elapsedMs < 3500);
    assert.equal(report.timeoutServer.outcome, "peer_closed");

    const dropped = await start("drop");
    report.drop = await finished(dropped, "error");
    assert.equal(report.drop.filter((event) => event.type === "chunk").length, 1);
    const after = Number(report.drop[0].eventId);
    const resumed = await start("normal", after);
    report.resume = await finished(resumed, "done", "");
    assert.deepEqual(report.resume.filter((event) => event.type === "chunk").map((event) => Number(event.eventId)), [2, 3]);
    report.resumeServer = await observation(resumed);
    assert.equal(report.resumeServer.after, 1);

    report.httpError = await finished(await start("http-error"), "error", "HTTP_STATUS");
    report.finalLocal = await evaluate("window.__streamCheck.store.read().then(s => ({count: s.entries.length, total_cents: s.total_cents}))");
    assert.equal(report.finalLocal.total_cents, report.local.once);
    // 稍等确认旧请求没有多次终态或取消后分块；使用完整监听记录而非只看UI。
    await delay(300);
    assert.deepEqual(await evaluate(events(cancelled)), report.cancelled);
    console.log(JSON.stringify({passed: true, ...report}, null, 2));
  }
} finally {
  try {
    await evaluate(`(async () => {
      if (!window.__streamCheck) return;
      for (const [requestId, list] of Object.entries(window.__streamCheck.events)) {
        if (!list.some(x => x.type !== 'chunk')) {
          try { await window.__streamCheck.stream.cancel({requestId}); } catch {}
        }
      }
      await window.__streamCheck.listener.remove();
      delete window.__streamCheck;
    })()`);
  } finally {
    page.close();
  }
}
