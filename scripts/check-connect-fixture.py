"""本机回环协议和设备拒绝测试；不连接ADB或Android设备。"""

import argparse
import importlib.util
from pathlib import Path
import socket
import struct
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

from lib.connect_fixture import DnsServer, HeldDns, CodecDns, TcpDnsServer, positive_reply
from lib.network_fixture import RadioFixture


def query(name, kind=1):
    labels = b"".join(bytes([len(part)]) + part.encode() for part in name.split(".")) + b"\0"
    return struct.pack("!6H", 0x1234, 0x0100, 1, 0, 0, 0) + labels + struct.pack("!2H", kind, 1)


class DnsProtocol(unittest.TestCase):
    def test_fixed_positive_a_and_aaaa_nodata(self):
        for kind in (1, 28):
            packet = query("valid.p0-dns.invalid", kind)
            reply = positive_reply(packet)
            self.assertEqual(struct.unpack("!6H", reply[:12]), (0x1234, 0x8180, 1, int(kind == 1), 0, 0))
            self.assertEqual(reply[12:len(packet)], packet[12:])
            if kind == 1:
                self.assertEqual(reply[len(packet):], b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x00\x00\x04\x0a\x00\x02\x02")
            else:
                self.assertEqual(len(reply), len(packet))

    def test_wire_hold_release_and_refusal(self):
        state = HeldDns()
        with DnsServer(state, port=0) as server, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            client.settimeout(0.15)
            try:
                for kind in (1, 28):
                    packet = query("tf" + "a" * 32 + ".p0-dns.invalid", kind)
                    client.sendto(packet, server.server_address)
                    end = time.monotonic() + 2
                    while state.snapshot()["held"] != 1:
                        self.assertLess(time.monotonic(), end, "DNS question was not received")
                        time.sleep(0.005)
                    with self.assertRaises(socket.timeout):
                        client.recv(4096)
                    self.assertEqual(state.snapshot()["held"], 1)
                    with self.assertRaisesRegex(ValueError, "pending"):
                        state.reset()
                    state.release()
                    client.settimeout(2)
                    reply = client.recv(4096)
                    self.assertEqual(struct.unpack("!6H", reply[:12]), (0x1234, 0x8183, 1, 0, 0, 0))
                    self.assertEqual(reply[12:], packet[12:])
                    state.reset()
                    client.settimeout(0.15)
                # 非实验域名立即否定，不挂起、不记录、不转发到真实DNS。
                packet = query("unrelated.invalid")
                client.settimeout(2)
                client.sendto(packet, server.server_address)
                self.assertEqual(client.recv(4096)[12:], packet[12:])
                self.assertEqual(state.snapshot()["queries"], [])
                client.settimeout(0.15)
                client.sendto(b"invalid", server.server_address)
                with self.assertRaises(socket.timeout):
                    client.recv(4096)
                self.assertEqual(state.snapshot()["held"], 0)
            finally:
                state.release()
                server.shutdown()
                worker.join(2)


class TcpLifecycle(unittest.TestCase):
    def test_loopback_peer_close_restart_and_exclusive_listener(self):
        state, port = CodecDns(), 0
        for _ in range(2):
            with TcpDnsServer(state, port) as server:
                port = server.server_address[1]
                with self.assertRaises(OSError):
                    TcpDnsServer(state, port)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    with socket.create_connection(server.server_address, timeout=2) as client:
                        packet = query("valid.p0-dns.invalid")
                        client.sendall(struct.pack("!H", len(packet)) + packet)
                        reply = b""
                        while True:
                            part = client.recv(4096)
                            if not part:
                                break
                            reply += part
                        self.assertEqual(struct.unpack("!H", reply[:2])[0], len(reply) - 2)
                        self.assertEqual(reply[2:], positive_reply(packet))
                finally:
                    server.shutdown()
                    worker.join(2)

    def test_fixture_retirement_is_not_peer_close(self):
        state = CodecDns()
        state.reset("tcp-hold")
        with TcpDnsServer(state, 0) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with socket.create_connection(server.server_address, timeout=2) as client:
                    packet = query("valid.p0-dns.invalid")
                    client.sendall(struct.pack("!H", len(packet)) + packet)
                    end = time.monotonic() + 2
                    while state.snapshot()["tcpActive"] != 1:
                        self.assertLess(time.monotonic(), end)
                        time.sleep(0.01)
                    state.retire_tcp()
                    while state.snapshot()["tcpActive"]:
                        self.assertLess(time.monotonic(), end)
                        time.sleep(0.01)
                    self.assertEqual(state.snapshot()["tcpPeerClosed"], 0)
                    self.assertEqual(state.snapshot()["tcpFixtureClosed"], 1)
            finally:
                state.retire_tcp()
                server.shutdown()
                worker.join(2)


class RadioRecovery(unittest.TestCase):
    def fixture(self, wifi="1", fail=False, airplane="0"):
        values = {"wifi_on": wifi, "mobile_data": "1", "airplane_mode_on": airplane}
        original, writes = dict(values), []

        def shell(*command):
            nonlocal fail
            if command == ("settings", "list", "global"):
                return "\n".join(f"{key}={value}" for key, value in values.items())
            writes.append(command)
            if command[0] == "svc":
                key = "wifi_on" if command[1] == "wifi" else "mobile_data"
                values[key] = "1" if command[2] == "enable" else "0"
                if command[1] == "data":
                    values["mobile_data1"] = values[key]
                    if fail and command[2] == "disable":
                        fail = False
                        raise RuntimeError("Injected failure after write")
            elif command[:2] == ("settings", "delete"):
                values.pop(command[3], None)
            elif command[:2] == ("settings", "put"):
                values[command[3]] = command[4]
            else:
                raise AssertionError("Unexpected mutation")
            return ""
        return RadioFixture(shell), values, original, writes

    def test_restore_original_values_and_absent_subscription_key(self):
        for wifi in ("0", "1"):
            fixture, values, original, writes = self.fixture(wifi=wifi)
            fixture.offline()
            self.assertEqual(values["mobile_data"], "0")
            self.assertEqual(values["wifi_on"], "0")
            fixture.restore()
            self.assertEqual(values, original)
            length = len(writes)
            fixture.restore()
            self.assertEqual(len(writes), length, "Clean restore must not mutate again")

    def test_partial_failure_can_restore(self):
        fixture, values, original, _ = self.fixture(fail=True)
        with self.assertRaisesRegex(RuntimeError, "Injected failure"):
            fixture.offline()
        fixture.restore()
        self.assertEqual(values, original)

    def test_airplane_mode_rejected_before_any_write(self):
        fixture, values, original, writes = self.fixture(airplane="1")
        with self.assertRaisesRegex(RuntimeError, "airplane mode off"):
            fixture.offline()
        self.assertEqual(writes, [])
        self.assertEqual(values, original)


spec = importlib.util.spec_from_file_location("connect_runner", Path(__file__).with_name("run-android-connect.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class DeviceGuards(unittest.TestCase):
    def options(self, **changes):
        values = dict(adb=Path("/never/call/adb"), serial="emulator-5558", expect_avd="travelflow_p0_connect35", expect_sdk=35, port=19238, client="platform", case="all")
        return argparse.Namespace(**(values | changes))

    def test_real_serial_rejected_without_running_any_command(self):
        with patch.object(runner.subprocess, "run") as process:
            for scenario in ("all", "network"):
                with self.assertRaisesRegex(RuntimeError, "emulator serial"):
                    runner.run(self.options(serial="physical-device", client="okhttp", case=scenario))
            process.assert_not_called()

    def test_wrong_avd_and_non_root_rejected_before_any_write(self):
        replies = {
            ("getprop", "ro.kernel.qemu"): "1",
            ("getprop", "ro.boot.qemu.avd_name"): "travelflow_p0_connect35",
            ("getprop", "ro.build.version.sdk"): "35",
            ("getprop", "sys.boot_completed"): "1",
            ("am", "get-current-user"): "0",
            ("id", "-u"): "2000",
        }

        def read_only(command, **_):
            self.assertEqual(command[3], "shell")
            request = tuple(command[4:])
            self.assertIn(request, replies, "A mutating or unexpected command was attempted")
            return subprocess.CompletedProcess(command, 0, replies[request] + "\n", "")

        with patch.object(runner.subprocess, "run", side_effect=read_only):
            with self.assertRaisesRegex(RuntimeError, "Wrong AVD"):
                runner.run(self.options(expect_avd="travelflow_p0_connect_other"))
            with self.assertRaisesRegex(RuntimeError, "root only its adbd"):
                runner.run(self.options())


if __name__ == "__main__":
    unittest.main()
