// 仅测试本机模拟ADB协议对端，不连接设备或已有ADB服务。
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./manage-probe-reverse.mjs", import.meta.url));
async function fixture(initial = []) {
  const listeners = new Set(initial);
  const seen = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let selected = false;
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = parseInt(buffer.subarray(0, 4).toString(), 16);
        if (buffer.length < 4 + length) return;
        const service = buffer.subarray(4, 4 + length).toString();
        buffer = buffer.subarray(4 + length);
        if (!selected) {
          assert.equal(service, "host:transport:isolated-fixture");
          selected = true;
          socket.write("O");
          setTimeout(() => socket.write("KAY"), 1);
          continue;
        }
        seen.push(service);
        const add = /^reverse:forward:norebind:tcp:localhost:(1851[0-5]);tcp:\1$/.exec(service);
        const remove = /^reverse:killforward:tcp:(1851[0-5])$/.exec(service);
        assert.ok(add || remove, `Unexpected ADB operation: ${service}`);
        const port = Number((add || remove)[1]);
        const failed = add ? listeners.has(port) : !listeners.has(port);
        if (!failed) add ? listeners.add(port) : listeners.delete(port);
        socket.write("OKAY");
        setTimeout(() => {
          if (failed) {
            const error = "fixture rejected operation";
            socket.end("FAIL" + error.length.toString(16).padStart(4, "0") + error);
          } else {
            socket.end("OKAY0005" + port);
          }
        }, 1);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  async function run(...args) {
    const child = spawn(process.execPath, [script, "--server-port", String(server.address().port), "--serial", "isolated-fixture", ...args]);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const [code] = await once(child, "close");
    return {code, stdout, stderr};
  }
  return {listeners, seen, run, close: async () => {
    for (const socket of sockets) socket.destroy();
    server.close(); await once(server, "close");
  }};
}
let test = await fixture();
try {
  let result = await test.run("--action", "add");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([...test.listeners], [18510, 18511, 18512, 18513, 18514, 18515]);
  assert.equal(JSON.parse(result.stdout).deviceBind, "localhost");
  result = await test.run("--action", "remove");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(test.listeners.size, 0);
  const seen = test.seen.length;
  result = await test.run("--action", "add", "--probe-port", "80");
  assert.notEqual(result.code, 0);
  assert.equal(test.seen.length, seen);
} finally { await test.close(); }
test = await fixture([18511]);
try {
  const result = await test.run("--action", "add");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ADB rejected request/);
  assert.deepEqual([...test.listeners], [18511], "Preserve existing mapping and roll back only newly created ports");
  assert.equal(test.seen.length, 3);
} finally { await test.close(); }
console.log("Probe reverse checks passed: fragmented replies, device rejection, no rebind, scoped rollback and fixed ports.");
