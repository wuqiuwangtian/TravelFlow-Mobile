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
        backup = CodecDns()
        backup_udp = stack.enter_context(DnsServer(backup, port=0))
        backup_tcp = stack.enter_context(TcpDnsServer(backup, backup_udp.server_address[1]))
        for server in (udp, tcp, backup_udp, backup_tcp):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            stack.callback(server.shutdown)
        stack.callback(state.release)
        stack.callback(state.retire_tcp)
        stack.callback(backup.release)
        stack.callback(backup.retire_tcp)
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
        budget_cases = {
            "budget-drop": ("drop", "direct"),
            "budget-servfail": ("servfail", "direct"),
            "budget-both-error": ("servfail", "refused"),
            "budget-wrong-stream": ("wrong-id-stream", "direct"),
            "budget-refused": ("refused", "direct"),
            "budget-tcp": ("tcp-delay", "direct"),
            "budget-all-drop": ("drop", "drop"),
            "budget-nxdomain": ("nxdomain", "direct"),
            "budget-aaaa": ("a-delay-aaaa-drop", "direct"),
            "budget-cname": ("cname-slow", "direct"),
            "budget-tcp-deadline": ("tcp-delay", "direct"),
            "budget-expired": ("direct", "direct"),
            "budget-late-result": ("direct", "direct"),
            "budget-cancel": ("drop", "tcp-hold"),
        }
        for mode, (primary_mode, backup_mode) in budget_cases.items():
            state.reset(primary_mode)
            backup.reset(backup_mode)
            result = subprocess.run(["java", "-cp", classes + ":" + str(jar), "org.travelflow.p0.CancelableDnsLookupCheck",
                                     str(udp.server_address[1]), mode, str(backup_udp.server_address[1])],
                                    capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise RuntimeError(mode + ": " + result.stdout + result.stderr)
            end = time.monotonic() + 2
            while (state.snapshot()["tcpActive"] or backup.snapshot()["tcpActive"]) and time.monotonic() < end:
                time.sleep(0.01)
            first, second = state.snapshot(), backup.snapshot()
            if first["tcpActive"] or second["tcpActive"]:
                raise RuntimeError(mode + ": TCP fixture connection leaked")
            if mode in ("budget-drop", "budget-servfail", "budget-refused", "budget-tcp", "budget-wrong-stream"):
                for snapshot in (first, second):
                    if not all(any(q["type"] == kind for q in snapshot["queries"]) for kind in (1, 28)):
                        raise RuntimeError(mode + ": did not reach both DNS servers for A/AAAA")
            if mode == "budget-tcp" and (not any(q.get("protocol") == "tcp" for q in first["queries"]) or not first["tcpPeerClosed"]):
                raise RuntimeError("TCP did not share the UDP attempt budget or close")
            if mode == "budget-nxdomain" and second["queries"]:
                raise RuntimeError("NXDOMAIN incorrectly retried against backup")
            if mode == "budget-all-drop" and (not first["queries"] or not second["queries"]):
                raise RuntimeError("Total deadline did not allow a backup attempt")
            if mode == "budget-aaaa" and not all(any(q["type"] == kind for q in first["queries"]) for kind in (1, 28)):
                raise RuntimeError("A/AAAA budget scenario was not exercised")
            if mode == "budget-cname" and not any(q["name"] == "answer.p0-dns.invalid" for q in first["queries"]):
                raise RuntimeError("CNAME deadline scenario did not follow the alias")
            if mode == "budget-expired" and (first["queries"] or second["queries"]):
                raise RuntimeError("Expired lookup sent DNS packets")
            if mode == "budget-cancel" and second["tcpPeerClosed"] != 1:
                raise RuntimeError("Backup TCP cancellation did not close the real socket")
            value = json.loads(result.stdout)
            if mode in ("budget-all-drop", "budget-aaaa", "budget-cname", "budget-tcp-deadline", "budget-expired", "budget-late-result") and not value["deadline"]:
                raise RuntimeError("Absolute deadline was not classified")
            results[mode] = value | {"primary": first, "backup": second}
            state.release()
            backup.release()
        print(json.dumps({"passed": True, "scope": "host_jvm_loopback_not_android_or_public_dns", "cases": results}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", required=True, type=Path)
    main(parser.parse_args().jar.resolve())
