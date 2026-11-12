"""MiniDNS core＋自有可取消I/O的主机JVM协议验收；只使用临时回环端口。"""
import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from lib.connect_fixture import CodecDns, DnsServer, TcpDnsServer


def main(jar):
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="travelflow-dns-check-") as classes, ExitStack() as stack:
        subprocess.run(["javac", "-cp", str(jar), "-d", classes,
                        str(root / "prototypes/okhttp-probe/CancelableDnsLookup.java"),
                        str(root / "scripts/lib/CancelableDnsLookupCheck.java")], check=True)
        state = CodecDns()
        udp = stack.enter_context(DnsServer(state, port=0))
        tcp = stack.enter_context(TcpDnsServer(state, udp.server_address[1]))
        for server in (udp, tcp):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            stack.callback(server.shutdown)
        stack.callback(state.release)
        results = {}
        for mode in ("direct", "cname", "tcp", "ipv6", "wrong-id", "wrong-question", "malformed", "loop", "nxdomain", "truncated-tcp", "udp-cancel", "tcp-cancel"):
            state.reset("tcp-hold" if mode == "tcp-cancel" else "direct" if mode == "udp-cancel" else mode)
            result = subprocess.run(["java", "-cp", classes + ":" + str(jar), "org.travelflow.p0.CancelableDnsLookupCheck", str(udp.server_address[1]), mode], capture_output=True, text=True, timeout=15)
            if result.returncode:
                raise RuntimeError(mode + ": " + result.stdout + result.stderr)
            end = time.monotonic() + 2
            while state.snapshot()["tcpActive"] and time.monotonic() < end:
                time.sleep(0.01)
            snapshot = state.snapshot()
            if mode == "tcp-cancel" and (snapshot["tcpPeerClosed"] != 1 or snapshot["tcpActive"]):
                raise RuntimeError("TCP peer did not observe closure")
            if mode == "tcp" and not any(q.get("protocol") == "tcp" for q in snapshot["queries"]):
                raise RuntimeError("No TCP fallback")
            if mode == "cname" and not any(q["name"] == "answer.p0-dns.invalid" for q in snapshot["queries"]):
                raise RuntimeError("CNAME not followed")
            if mode == "udp-cancel" and snapshot["held"] != 1:
                raise RuntimeError("UDP wait not observed")
            results[mode] = json.loads(result.stdout) | {"fixture": snapshot}
            state.release()
        print(json.dumps({"passed": True, "scope": "host_jvm_loopback_not_android_or_public_dns", "cases": results}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", required=True, type=Path)
    main(parser.parse_args().jar.resolve())
