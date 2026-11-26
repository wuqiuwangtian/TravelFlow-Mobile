import assert from "node:assert/strict";
import { test } from "node:test";
import { createForegroundSync } from "../prototypes/p1-bridge-receipt/web/foreground-sync.ts";

test("foreground wakes share one exchange; hidden and blocked sessions stop polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = true;
  let calls = 0;
  let resolveExchange;
  const presented = [];
  const sync = createForegroundSync({
    available: () => visible,
    exchange: () => {
      calls++;
      return new Promise((resolve) => { resolveExchange = resolve; });
    },
    present: async (result) => { presented.push(result.state); },
  });
  const pass = sync.wake();
  await Promise.all([sync.wake(), sync.wake()]);
  assert.equal(calls, 1);
  visible = false;
  resolveExchange({ state: "idle" });
  await pass;
  t.mock.timers.tick(60000);
  assert.equal(calls, 1);

  visible = true;
  const resumed = sync.wake();
  resolveExchange({ state: "blocked", reason: "HTTP_403_device_revoked" });
  await resumed;
  t.mock.timers.tick(60000);
  await sync.wake();
  assert.equal(calls, 2);

  sync.paired();
  assert.equal(calls, 3);
  resolveExchange({ state: "idle" });
  await new Promise(setImmediate);
  assert.deepEqual(presented, ["idle", "blocked", "idle"]);
  sync.cancelTimer();
});

test("awaiting a trip grant keeps polling; transient failure backs off and recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = ["unpaired", "retry", "retry", "retry", "synced", "idle"];
  let calls = 0;
  const sync = createForegroundSync({
    available: () => true,
    exchange: async () => ({ state: states[calls++], reason: "HTTP_403_exchange_not_authorized" }),
    present: async () => {},
  });
  await sync.wake();
  for (const delay of [5000, 10000, 20000, 30000, 5000]) {
    const before = calls;
    t.mock.timers.tick(delay - 1);
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(calls, before + 1);
  }
  sync.cancelTimer();
});
