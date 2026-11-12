"""仅在明确的专用隔离AVD内制造SYN/DNS停顿；不修改宿主网络或操作真机。"""

import argparse
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shlex
import subprocess
import threading
import time
import urllib.request

from lib.connect_fixture import DnsServer, CodecDns, TcpDnsServer
from lib.network_fixture import RadioFixture


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args):
    require(args.case == "all" or args.client == "okhttp", "Focused checks require the optional client")
    def adb(*command, check=True):
        result = subprocess.run([str(args.adb), "-s", args.serial, *command], check=False,
                                capture_output=True, text=True, timeout=20)
        if check and result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "ADB command failed")
        return result

    def shell(*command, check=True):
        return adb("shell", *(shlex.quote(part) for part in command), check=check).stdout.strip()

    # 所有写入之前先验证设备类型、确切AVD归属及SDK；不会执行root或重启全局ADB服务。
    require(re.fullmatch(r"emulator-[0-9]+", args.serial), "An explicit emulator serial is required")
    require(args.expect_avd.startswith("travelflow_p0_connect"), "Use a dedicated connection-test AVD")
    require(shell("getprop", "ro.kernel.qemu") == "1", "Not an emulator")
    avd = shell("getprop", "ro.boot.qemu.avd_name") or shell("getprop", "ro.kernel.qemu.avd_name")
    require(avd == args.expect_avd, "Wrong AVD")
    require(shell("getprop", "ro.build.version.sdk") == str(args.expect_sdk), "Wrong SDK")
    require(shell("getprop", "sys.boot_completed") == "1", "AVD has not booted")
    require(shell("am", "get-current-user") == "0", "Only dedicated AVD user 0 is supported")
    require(shell("id", "-u") == "0", "After verifying the AVD, root only its adbd before this test")
    packages = shell("dumpsys", "package", "org.travelflow.p0")
    match = re.search(r"^\s*(?:userId|appId)=([0-9]+)\s*$", packages, re.M)
    require(match and "DEBUGGABLE" in packages, "Install the reviewed debug probe first")
    uid = match.group(1)
    require(int(uid) >= 10000, "Probe must retain its normal application UID")
    forwards = [row.split() for row in adb("forward", "--list").stdout.splitlines() if row.strip()]
    require(all(len(row) == 3 for row in forwards), "Unrecognized ADB forward list")
    require(not any(row[1] == f"tcp:{args.port}" for row in forwards), "CDP port already owned")
    with urllib.request.urlopen("http://127.0.0.1:18510/observations?requestId=connect_preflight", timeout=3) as response:
        require(response.status == 200, "Start the existing synthetic HTTP service first")
    for table, chain in [("filter", "P0_SYN_PROBE"), ("nat", "P0_DNS_PROBE")]:
        require(adb("shell", "iptables", "-t", table, "-S", chain, check=False).returncode != 0, "Fixture chain already exists")

    require(args.case != "codec" or args.expect_sdk < 29, "Codec-specific checks require the legacy branch")
    state = CodecDns()
    created = []
    jumps = []
    forwarded = False
    proxy_original = None
    reports = []
    radios = RadioFixture(shell)

    def iptables(table, *parts):
        return shell("iptables", "-t", table, *parts)

    def remove_rules():
        # 不flush内置链；只删除本轮确实成功创建的跳转和专用链。
        while jumps:
            table, rule = jumps[-1]
            iptables(table, "-D", "OUTPUT", *rule)
            jumps.pop()
        while created:
            table, chain = created[-1]
            iptables(table, "-F", chain)
            iptables(table, "-X", chain)
            created.pop()

    def make_rule(table, chain, rule, action):
        iptables(table, "-N", chain)
        created.append((table, chain))
        iptables(table, "-A", chain, *action)
        iptables(table, "-I", "OUTPUT", "1", *rule)
        jumps.append((table, rule))

    proxy_keys = ("http_proxy", "global_http_proxy_host", "global_http_proxy_port", "global_http_proxy_exclusion_list", "global_proxy_pac_url")

    def proxy_settings():
        rows = dict(row.split("=", 1) for row in shell("settings", "list", "global").splitlines() if "=" in row)
        return {key: rows.get(key) for key in proxy_keys}

    def restore_proxy():
        nonlocal proxy_original
        if proxy_original is None:
            return
        # Android将旧键转换为global_*配置；先让系统清除实际代理，再恢复全部设置。
        shell("settings", "put", "global", "http_proxy", ":0")
        end = time.monotonic() + 3
        while proxy_settings()["global_http_proxy_host"] not in (None, ""):
            require(time.monotonic() < end, "Temporary proxy remained active")
            time.sleep(0.05)
        for key in (*proxy_keys[1:], "http_proxy"):
            value = proxy_original[key]
            if value is None:
                shell("settings", "delete", "global", key)
            else:
                shell("settings", "put", "global", key, value)
        require(proxy_settings() == proxy_original, "Proxy settings were not restored exactly")
        proxy_original = None

    def fault_snapshot():
        packets = 0
        if ("filter", "P0_SYN_PROBE") in created:
            listing = iptables("filter", "-nvx", "-L", "P0_SYN_PROBE")
            counter = re.search(r"^\s*([0-9]+)\s+[0-9]+\s+DROP\b", listing, re.M)
            require(counter, "SYN packet counter unavailable")
            packets = int(counter.group(1))
        sockets = 0
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            for row in shell("cat", path).splitlines()[1:]:
                fields = row.split()
                if len(fields) > 7 and fields[2].endswith(f"0202000A:{18510:04X}") and fields[3] == "02" and fields[7] == uid:
                    sockets += 1
        owned_sockets = 0
        for protocol in ("tcp", "tcp6", "udp", "udp6"):
            for row in shell("cat", "/proc/net/" + protocol).splitlines()[1:]:
                fields = row.split()
                if len(fields) <= 9 or fields[7] != uid or fields[9] == "0":
                    continue
                remote = fields[2]
                if remote.endswith("0302000A:0035") or any(remote.endswith(f"0202000A:{port:04X}") for port in range(18510, 18516)):
                    owned_sockets += 1
        return {"synPackets": packets, "synSockets": sockets, "dns": state.snapshot(), "probeOwnedSockets": owned_sockets}

    class ControlHandler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, payload):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != "/state":
                self.send_error(404)
                return
            self.respond(fault_snapshot())

        def do_POST(self):
            if self.headers.get("Content-Length", "0") != "0":
                self.send_error(404)
                return
            if args.case == "network" and self.path == "/network/retire-dns-peer":
                state.retire_tcp()
                self.respond(state.snapshot())
                return
            if args.case == "network" and self.path in ("/network/off", "/network/restore"):
                if self.path == "/network/off":
                    radios.offline()
                else:
                    radios.restore()
                self.respond({"radioSettings": radios.settings()})
                return
            if self.path == "/release":
                state.release()
            elif self.path.removeprefix("/mode/") in state.MODES:
                state.reset(self.path.removeprefix("/mode/"))
            else:
                self.send_error(404)
                return
            self.respond(state.snapshot())

    try:
        with ExitStack() as stack:
            dns = stack.enter_context(DnsServer(state))
            tcp_dns = stack.enter_context(TcpDnsServer(state, 18516))
            control = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 18517), ControlHandler))
            for server in (dns, tcp_dns, control):
                threading.Thread(target=server.serve_forever, daemon=True).start()
                stack.callback(server.shutdown)
            stack.callback(state.release)
            stack.callback(state.retire_tcp)
            scenarios = ("baseline", "syn", "dns-system", "dns", "dns-deadline", "dns-codec", "dns-tls", "baseline") if args.client == "okhttp" else ("baseline", "syn", "dns", "dns-deadline", "baseline")
            if args.expect_sdk >= 29:
                scenarios = tuple(item for item in scenarios if item != "dns-codec")
            if args.case in ("tls", "codec"):
                scenarios = ("dns-tls" if args.case == "tls" else "dns-codec",)
            if args.case == "proxy":
                scenarios = ("proxy-guard", "baseline")
            if args.case == "network":
                scenarios = ("dns-network", "network-offline-cold", "baseline")
            for scenario in scenarios:
                state.reset()
                if scenario == "proxy-guard":
                    original = proxy_settings()
                    require(original["http_proxy"] in (None, ":0", "") and
                            original["global_http_proxy_host"] in (None, "") and
                            original["global_proxy_pac_url"] in (None, ""), "Do not replace an existing proxy")
                    proxy_original = original
                    shell("settings", "put", "global", "http_proxy", "127.0.0.1:18510")
                elif scenario == "network-offline-cold":
                    radios.offline()
                elif scenario == "syn":
                    make_rule("filter", "P0_SYN_PROBE",
                              ["-p", "tcp", "-d", "10.0.2.2", "--dport", "18510", "--syn", "-m", "owner", "--uid-owner", uid, "-j", "P0_SYN_PROBE"],
                              ["-j", "DROP"])
                elif scenario.startswith("dns"):
                    # -dns-server只配置此AVD；UDP与TCP53均仅送到固定回环对端。
                    make_rule("nat", "P0_DNS_PROBE",
                              ["-p", "udp", "-d", "10.0.2.3", "--dport", "53", "-j", "P0_DNS_PROBE"],
                              ["-p", "udp", "-j", "DNAT", "--to-destination", "10.0.2.2:18516"])
                    iptables("nat", "-A", "P0_DNS_PROBE", "-p", "tcp", "-j", "DNAT", "--to-destination", "10.0.2.2:18516")
                    tcp_rule = ["-p", "tcp", "-d", "10.0.2.3", "--dport", "53", "-j", "P0_DNS_PROBE"]
                    iptables("nat", "-I", "OUTPUT", "1", *tcp_rule)
                    jumps.append(("nat", tcp_rule))
                adb("shell", "am", "force-stop", "--user", "0", "org.travelflow.p0")
                adb("shell", "am", "start", "--user", "0", "-n", "org.travelflow.p0/.MainActivity")
                end = time.monotonic() + 8
                while True:
                    pid = shell("pidof", "org.travelflow.p0", check=False)
                    if re.fullmatch(r"[0-9]+", pid):
                        break
                    require(time.monotonic() < end, "Probe process did not start")
                    time.sleep(0.05)
                adb("forward", *([] if forwarded else ["--no-rebind"]), f"tcp:{args.port}", f"localabstract:webview_devtools_remote_{pid}")
                forwarded = True
                end = time.monotonic() + 10
                while True:
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/json", timeout=1) as response:
                            if any(target.get("title") == "TravelFlow Android P0" for target in json.load(response)):
                                break
                    except (OSError, ValueError):
                        pass
                    require(time.monotonic() < end, "Probe WebView did not become available")
                    time.sleep(0.05)
                special = {"dns-codec": "check-android-dns-codec.mjs", "dns-tls": "check-android-async.mjs", "proxy-guard": "check-android-proxy-guard.mjs", "dns-network": "check-android-network.mjs", "network-offline-cold": "check-android-network.mjs"}
                command = ["node", str(Path(__file__).with_name(special[scenario])), "--port", str(args.port)] if scenario in special else [
                    "node", str(Path(__file__).with_name("check-android-connect.mjs")), "--port", str(args.port), "--case", scenario, "--client", args.client]
                if scenario == "network-offline-cold":
                    command.append("--offline")
                result = subprocess.run(command, text=True, capture_output=True, timeout=150 if scenario == "dns-network" else 100 if scenario in ("dns-tls", "dns-codec") else 40)
                require(result.returncode == 0, result.stderr or result.stdout)
                report = json.loads(result.stdout)
                if scenario == "network-offline-cold":
                    require(report["before"] == reports[-1]["local"], "Offline cold start changed existing records")
                reports.append(report)
                remove_rules()
                restore_proxy()
                radios.restore()
    except Exception:
        print(json.dumps({"fixtureAssertionsPassed": False, "experiments": reports}, indent=2))
        raise
    finally:
        try:
            state.release()
        finally:
            try:
                adb("shell", "am", "force-stop", "--user", "0", "org.travelflow.p0", check=False)
                remove_rules()
            finally:
                try:
                    try:
                        restore_proxy()
                    finally:
                        radios.restore()
                finally:
                    if forwarded:
                        adb("forward", "--remove", f"tcp:{args.port}")

    print(json.dumps({"fixtureAssertionsPassed": True, "sdk": args.expect_sdk, "avd": args.expect_avd, "client": args.client,
                      "scope": "isolated_emulator_fixed_synthetic_endpoints", "experiments": reports}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", type=Path, required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--expect-avd", required=True)
    parser.add_argument("--expect-sdk", type=int, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--client", choices=["platform", "okhttp"], default="platform")
    parser.add_argument("--case", choices=["all", "tls", "codec", "proxy", "network"], default="all")
    options = parser.parse_args()
    require(1024 <= options.port <= 65535 and options.port not in range(18510, 18518), "Choose a separate CDP port")
    run(options)
