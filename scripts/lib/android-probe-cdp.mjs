// 只连接操作者已明确转发的Android P0 WebView，不发现或选择ADB设备。
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function connectProbe(port) {
  assert.ok(/^\d{4,5}$/.test(String(port)) && Number(port) <= 65535, "Invalid forwarded CDP port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((item) => item.title === "TravelFlow Android P0");
  assert.ok(target, "Expected isolated P0 WebView");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({data}) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, {resolve, reject, timer});
      ws.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression) {
    const response = await call("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function until(expression, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await evaluate(expression);
      if (result) return result;
      await delay(50);
    }
    throw new Error(`Condition timed out: ${expression}`);
  }
  async function tap(id) {
    const point = await evaluate(`(() => {
      const button = document.getElementById(${JSON.stringify(id)});
      if (button.disabled) throw Error('Button disabled');
      button.scrollIntoView({block: 'center'});
      const box = button.getBoundingClientRect();
      return {x: box.x + box.width / 2, y: box.y + box.height / 2};
    })()`);
    await call("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [point]});
    await call("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
  }
  return {evaluate, until, tap, close: () => ws.close()};
}
