// 只连接操作者明确转发的P0 WebView；不发现设备、不安装APK、不改变网络。
import assert from "node:assert/strict";
import { connectProbe } from "./lib/android-probe-cdp.mjs";

const args = process.argv.slice(2);
if (![2, 5].includes(args.length) || args[0] !== "--port" ||
    (args.length === 5 && (args[2] !== "--expect-local" || !args.slice(3).every(value => /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)))))) {
  throw new Error("Usage: check-android-local.mjs --port PORT [--expect-local COUNT CENTS (read-only)]");
}
const page = await connectProbe(args[1]);
const summarize = snapshot => ({count: snapshot.entries.length, cents: snapshot.total_cents});
async function read() {
  return await page.evaluate(`(async () => {
    const api = await import('./capacitor-core.js');
    if (!api.Capacitor.isNativePlatform() || api.Capacitor.getPlatform() !== 'android') throw Error('Not native Android');
    return await api.registerPlugin('ProbeStore').read();
  })()`);
}
try {
  await page.until("document.getElementById('runtime').textContent === 'Android原生桥已就绪'");
  const before = await read();
  if (args.length === 5) {
    const expected = {count: Number(args[3]), cents: Number(args[4])};
    assert.deepEqual(summarize(before), expected, "Expected persisted prototype records");
    console.log(JSON.stringify({passed: true, scope: "current_native_android_only", mode: "read-only", local: expected}, null, 2));
  } else {
    await page.tap("append");
    await page.until("!document.getElementById('append').disabled && !document.getElementById('retry').disabled");
    assert.equal(await page.evaluate("document.getElementById('error').textContent"), "");
    const once = await read();
    assert.equal(once.entries.length, before.entries.length + 1);
    assert.equal(once.total_cents - before.total_cents, 123);
    const existing = new Map(once.entries.map(entry => [entry.id, entry]));
    for (const entry of before.entries) assert.deepEqual(existing.get(entry.id), entry, "Existing record changed");
    await page.tap("retry");
    await page.until("!document.getElementById('append').disabled && !document.getElementById('retry').disabled");
    assert.equal(await page.evaluate("document.getElementById('error').textContent"), "");
    const replay = await read();
    assert.deepEqual(replay, once, "Replaying the same operation must not change records");
    console.log(JSON.stringify({passed: true, scope: "current_native_android_only", mode: "touch-append-and-replay",
      local: {before: summarize(before), once: summarize(once), replay: summarize(replay)}}, null, 2));
  }
} finally { page.close(); }
