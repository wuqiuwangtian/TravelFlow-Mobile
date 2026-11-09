// 向已有的本机ADB服务请求固定P0端口的回环监听；不启动服务、不选择默认设备。
import net from "node:net";
import { once } from "node:events";

const options = new Map();
const args = process.argv.slice(2);
const usage = "Usage: manage-probe-reverse.mjs --server-port PORT --serial EXPLICIT_SERIAL --action add|remove [--probe-port 18510..18515]";
for (let i = 0; i < args.length; i += 2) {
  if (!["--server-port", "--serial", "--action", "--probe-port"].includes(args[i]) || options.has(args[i]) || !args[i + 1]) throw Error(usage);
  options.set(args[i], args[i + 1]);
}
const serverPort = Number(options.get("--server-port"));
const serial = options.get("--serial");
const action = options.get("--action");
const probePorts = options.has("--probe-port") ? [Number(options.get("--probe-port"))] : [18510, 18511, 18512, 18513, 18514, 18515];
if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535 ||
    !serial || !/^[A-Za-z0-9._:-]{1,128}$/.test(serial) || !["add", "remove"].includes(action) ||
    !probePorts.every(port => Number.isInteger(port) && port >= 18510 && port <= 18515)) throw Error(usage);

async function request(service) {
  const socket = net.createConnection({host: "127.0.0.1", port: serverPort});
  socket.on("error", () => {});
  socket.setTimeout(5000, () => socket.destroy(Error("ADB protocol timed out")));
  const iterator = socket[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  async function read(length) {
    while (buffered.length < length) {
      const item = await iterator.next();
      if (item.done) throw Error("Unexpected ADB EOF");
      buffered = Buffer.concat([buffered, item.value]);
    }
    const result = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return result;
  }
  function send(value) {
    const data = Buffer.from(value);
    socket.write(Buffer.concat([Buffer.from(data.length.toString(16).padStart(4, "0")), data]));
  }
  async function status() {
    const value = (await read(4)).toString();
    if (value === "OKAY") return;
    if (value !== "FAIL") throw Error("Invalid ADB status");
    const size = (await read(4)).toString();
    if (!/^[0-9a-fA-F]{4}$/.test(size)) throw Error("Invalid ADB failure length");
    throw Error(`ADB rejected request: ${(await read(parseInt(size, 16))).toString()}`);
  }
  try {
    await once(socket, "connect");
    send(`host:transport:${serial}`);
    await status();
    send(`reverse:${service}`);
    // ADB服务接受连接后，仍须确认设备端操作成功，不能只读取第一层OKAY。
    await status();
    await status();
  } finally { socket.destroy(); }
}
const source = port => `tcp:localhost:${port}`;
// adbd虽按localhost绑定，但在reverse列表中将名称规范化为tcp:PORT。
const registeredSource = port => `tcp:${port}`;
const completed = [];
try {
  for (const port of probePorts) {
    await request(action === "add" ? `forward:norebind:${source(port)};tcp:${port}` : `killforward:${registeredSource(port)}`);
    completed.push(port);
  }
} catch (error) {
  const cleanupFailures = [];
  if (action === "add") {
    for (const port of completed.reverse()) {
      try { await request(`killforward:${registeredSource(port)}`); } catch { cleanupFailures.push(port); }
    }
  }
  if (cleanupFailures.length) throw Error(`${error.message}; could not roll back ports: ${cleanupFailures.join(",")}`);
  throw error;
}
console.log(JSON.stringify({passed: true, action, serverPort, deviceBind: "localhost", probePorts: completed}));
