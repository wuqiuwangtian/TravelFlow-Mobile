import { Capacitor, registerPlugin, CapacitorHttp } from "./capacitor-core.js";
import { summarizeLedger } from "./ledger-core.js";

const store = registerPlugin("ProbeStore");
const stream = registerPlugin("ProbeStream");
const byId = (id) => document.getElementById(id);
let previousId = null;
let streamId = null;
let lastEventId = 0;
const streamButtons = ["stream", "stall", "drop", "resume", "drip", "no-auth", "unauthorized", "redirect"];
let credentialBusy = false;

function streamControls(running) {
  for (const id of streamButtons) byId(id).disabled = running || credentialBusy || (id === "resume" && !(lastEventId > 0 && lastEventId < 3));
  byId("cancel").disabled = !running;
  byId("transport").disabled = running || credentialBusy;
  for (const id of ["credential-prepare", "credential-clear"]) byId(id).disabled = running || credentialBusy;
}

for (const [id, method, message] of [
  ["credential-prepare", "prepareCredentialFixture", "虚构凭据已加密保存，可测试HTTPS。"],
  ["credential-clear", "clearCredentialFixture", "虚构凭据已移除，HTTPS应明确报错。"],
]) {
  byId(id).onclick = async () => {
    credentialBusy = true;
    streamControls(false);
    try {
      await stream[method]();
      byId("credential-status").textContent = message;
    } catch (error) {
      byId("credential-status").textContent = String(error);
    } finally {
      credentialBusy = false;
      streamControls(false);
    }
  };
}

byId("transport").onchange = () => { lastEventId = 0; streamControls(false); };

async function startStream(mode, after = 0) {
  streamId = crypto.randomUUID();
  if (!after) lastEventId = 0;
  byId("stream-events").textContent = "";
  byId("stream-status").textContent = "原生请求进行中";
  streamControls(true);
  try {
    await stream.start({requestId: streamId, mode, after, transport: byId("transport").value});
  } catch (error) {
    byId("stream-status").textContent = String(error);
    streamId = null;
    streamControls(false);
  }
}

byId("stream").onclick = () => void startStream("normal");
byId("stall").onclick = () => void startStream("stall");
byId("drop").onclick = () => void startStream("drop");
byId("resume").onclick = () => void startStream("normal", lastEventId);
for (const mode of ["drip", "no-auth", "unauthorized", "redirect"]) {
  byId(mode).onclick = () => void startStream(mode);
}
byId("cancel").onclick = async () => {
  byId("cancel").disabled = true;
  try {
    await stream.cancel({requestId: streamId});
    // 工作线程终态事件才确认取消完成。
  } catch (error) {
    byId("stream-status").textContent = String(error);
  }
};

function render(snapshot) {
  const summary = summarizeLedger({expenses: snapshot.entries, adjustments: []});
  if (summary.paid_cents !== snapshot.total_cents) throw new Error("Native/JS ledger mismatch");
  byId("ledger").textContent = `原生记录 ${snapshot.entries.length} 条 · 合计 ¥${(summary.paid_cents / 100).toFixed(2)}`;
}

async function save(id) {
  byId("append").disabled = true;
  byId("retry").disabled = true;
  try {
    byId("error").textContent = "";
    render(await store.append({id}));
    previousId = id;
  } catch (error) {
    byId("error").textContent = String(error);
  } finally {
    byId("append").disabled = false;
    byId("retry").disabled = !previousId;
  }
}

byId("append").onclick = () => save(crypto.randomUUID());
byId("retry").onclick = () => { if (previousId) void save(previousId); };
byId("http").onclick = async () => {
  byId("http").disabled = true;
  byId("network").textContent = "正在调用测试服务…";
  try {
    const result = await CapacitorHttp.request({
      url: "http://10.0.2.2:18510/echo",
      method: "POST",
      headers: {"Content-Type": "application/json", "X-P0-Token": "fixture-token"},
      data: {message: "synthetic-p0"},
      connectTimeout: 3000,
      readTimeout: 3000,
      disableRedirects: true,
    });
    if (result.status !== 200 || result.data?.probe !== "ok") throw new Error("Unexpected test response");
    byId("network").textContent = "原生HTTP测试通过（非真实模型调用）";
  } catch (error) {
    byId("network").textContent = `测试请求失败，本地记录仍可用：${String(error)}`;
  } finally {
    byId("http").disabled = false;
  }
};

try {
  if (!Capacitor.isNativePlatform()) throw new Error("This probe requires Android native runtime");
  await stream.addListener("stream", (event) => {
    if (event.requestId !== streamId) return;
    byId("stream-events").textContent += `${event.elapsedMs}ms ${event.type} ${event.data}\n`;
    if (event.type === "chunk") {
      lastEventId = Number(event.eventId);
    } else {
      byId("stream-status").textContent = `原生请求终态：${event.type} ${event.data}`;
      streamId = null;
      streamControls(false);
    }
  });
  render(await store.read());
  byId("runtime").textContent = "Android原生桥已就绪";
  byId("append").disabled = false;
  byId("http").disabled = false;
  streamControls(false);
} catch (error) {
  byId("runtime").textContent = "原生能力未就绪";
  byId("error").textContent = String(error);
}
