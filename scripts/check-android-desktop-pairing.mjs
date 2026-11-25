// Pair an isolated API 35 AVD to the foreground desktop service via the displayed IPv4 address.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { networkInterfaces, release, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { adb, assertIsolatedAvd, buildApk, forceStopAndReopen, getAirplaneMode, launchAndAttach,
  PACKAGE, setAirplaneMode, setInputValue } from "./check-p1-offline-entry-android.mjs";

const { values } = parseArgs({ options: { serial: { type: "string" }, "desktop-repo": { type: "string" },
  "desktop-python": { type: "string" }, bind: { type: "string" } } });
const serial = values.serial, port = 19242;
assert.equal(serial, "emulator-5580");
assertIsolatedAvd(serial);
assert.ok(!adb(serial, ["forward", "--list"]).stdout.split(/\s+/).includes("tcp:" + port));
const bind = values.bind;
assert.ok(Object.values(networkInterfaces()).flat().some(i => !i.internal && i.family === "IPv4" && i.address === bind),
  "Provide an IPv4 address of this desktop host with --bind");
const python = path.resolve(values["desktop-python"]);
const ref = "768043340f3bb681bd1904cc2b873e7632070982";
const work = mkdtempSync(path.join(tmpdir(), "travel-pair-"));
const desktop = path.join(work, "desktop-src");
const state = path.join(work, "private");
const args = ["-m", "desktop.lan_pairing"];
const control = (action, ...params) => JSON.parse(execFileSync(python,
  [...args, action, "--state-dir", state, ...params], { cwd: desktop, timeout: 10000, encoding: "utf8" }));
const airplane = getAirplaneMode(serial);
let built, installed, server, exited, session;
try {
  mkdirSync(desktop);
  const archive = path.join(work, "desktop.tar");
  execFileSync("git", ["-C", values["desktop-repo"], "archive", "-o", archive, ref, "desktop"]);
  execFileSync("tar", ["-xf", archive, "-C", desktop]);
  built = buildApk();
  adb(serial, ["install", "-t", built.apk]);
  installed = true;
  setAirplaneMode(serial, false);
  session = await launchAndAttach(serial, port);
  server = spawn(python, [...args, "serve", "--state-dir", state, "--bind", bind, "--port", "0", "--open-pairing"],
    { cwd: desktop, stdio: ["ignore", "pipe", "inherit"] });
  exited = once(server, "exit");
  const lines = createInterface({ input: server.stdout });
  const [line] = await Promise.race([once(lines, "line"), exited.then(() => { throw Error("Desktop startup failed"); })]);
  lines.close();
  const info = JSON.parse(line);
  assert.equal(info.lan_host, bind);
  const route = adb(serial, ["shell", "ip", "route", "get", bind]).stdout.trim();
  async function tap(id, expected) {
    await session.cdp.tap(id);
    for (let i = 0; i < 100; i++) {
      const ready = await session.cdp.evaluate("!document.querySelector('#pair-read').disabled");
      if (ready) {
        const msg = await session.cdp.evaluate("document.querySelector('#pair-status').textContent");
        assert.match(msg, expected);
        return msg;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error("Timed out waiting for " + id);
  }
  const begin = async (display, expected) => {
    await setInputValue(session.cdp, "pair-display", JSON.stringify(display));
    return tap("pair-begin", expected);
  };
  const wrong = structuredClone(info);
  wrong.cert_sha256 = (info.cert_sha256[0] === "0" ? "1" : "0") + info.cert_sha256.slice(1);
  wrong.pairing_session.cert_sha256 = wrong.cert_sha256;
  await begin(wrong, /pin_mismatch/);
  assert.equal(control("status").pending_requests.length, 0);
  const sas = (await begin(info, /核对 [0-9]{6}$/)).slice(-6);
  const pending = control("status").pending_requests;
  assert.equal(pending.length, 1);
  assert.ok(sas === pending[0].sas_code, "Desktop and Android SAS must match");
  await tap("pair-confirm", /HTTP_409_awaiting_desktop_confirm/);
  await tap("pair-read", /not_paired/);
  assert.ok(control("approve", "--request-id", pending[0].request_id, "--sas-code", sas).ok);
  await tap("pair-read", /not_paired/);
  await tap("pair-confirm", /配对已完成/);
  const trip = await tap("pair-read", /92ba6a148a17.*86\.35/);
  const pid = session.pid;
  session.cdp.close();
  session = await forceStopAndReopen(serial, port, pid);
  assert.equal(await tap("pair-read", /92ba6a148a17.*86\.35/), trip);
  assert.ok(control("revoke", "--device-id", pending[0].device_id).revoked);
  const revoked = await tap("pair-read", /HTTP_403_device_revoked/);
  assert.ok(!revoked.includes("92ba6a148a17"));
  assert.equal(control("status").devices[0].status, "revoked");
  console.log(JSON.stringify({ desktopCommit: ref, kernel: release(), bind, port: info.lan_port, route,
    pinMismatchRequests: 0, desktopConfirmationRequired: true, independentSasMatched: true,
    trip, pid, coldPid: session.pid, revoked: "403 device_revoked" }, null, 2));
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await exited;
  }
  session?.cdp.close();
  if (installed) {
    adb(serial, ["forward", "--remove", "tcp:" + port], { allowFailure: true });
    setAirplaneMode(serial, airplane === "1");
    adb(serial, ["uninstall", PACKAGE]);
  }
  if (built) rmSync(built.tempRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
