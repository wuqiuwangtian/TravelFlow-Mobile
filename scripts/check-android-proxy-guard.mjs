// 专用AVD已临时配置封闭回环代理；验证实验客户端明确拒绝，且没有HTTP或账本副作用。
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {connectProbe} from "./lib/android-probe-cdp.mjs";
assert.ok(process.argv.length === 4 && process.argv[2] === "--port", "Usage: check-android-proxy-guard.mjs --port PORT");
const page = await connectProbe(process.argv[3]);
const id = `proxy_guard_${crypto.randomUUID()}`;
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  // Settings观察器异步更新；真正的通过条件仍是原生明确拒绝，不能凭设置值判通过。
  await delay(500);
  await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    window.__proxyCheck = {stream:api.registerPlugin('ProbeAsyncStream'),store:api.registerPlugin('ProbeStore'),events:[]};
    window.__proxyCheck.listener = await window.__proxyCheck.stream.addListener('stream', event => {
      if (event.requestId === ${JSON.stringify(id)}) window.__proxyCheck.events.push(event);
    });
  })()`);
  const before = await page.evaluate("window.__proxyCheck.store.read()");
  await page.evaluate(`window.__proxyCheck.stream.start({requestId:${JSON.stringify(id)},transport:'http'})`);
  const events = await page.until("window.__proxyCheck.events.length ? window.__proxyCheck.events : null");
  assert.equal(events.length, 1); assert.equal(events[0].type, "error"); assert.equal(events[0].data, "PROXY_UNVERIFIED");
  const resources = await page.evaluate("window.__proxyCheck.stream.resources()");
  assert.equal(resources.active, false);
  for (const key of ["workers", "resolutions", "dnsSockets", "httpCalls", "connections"]) assert.equal(resources[key], 0, key);
  const server = await (await fetch(`http://127.0.0.1:18510/observations?requestId=${id}`, {signal:AbortSignal.timeout(3000)})).json();
  assert.equal(server, null);
  assert.deepEqual(await page.evaluate("window.__proxyCheck.store.read()"), before);
  console.log(JSON.stringify({fixtureAssertionsPassed:true,scenario:"proxy-guard",events,resources,ledger:{count:before.entries.length,cents:before.total_cents}}, null, 2));
} finally {
  await page.evaluate("(async () => { if (window.__proxyCheck?.listener) await window.__proxyCheck.listener.remove(); })()");
  page.close();
}
