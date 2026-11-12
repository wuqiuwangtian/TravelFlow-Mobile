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

from lib.connect_fixture import DnsServer, HeldDns, positive_reply


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


spec = importlib.util.spec_from_file_location("connect_runner", Path(__file__).with_name("run-android-connect.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class DeviceGuards(unittest.TestCase):
    def options(self, **changes):
        values = dict(adb=Path("/never/call/adb"), serial="emulator-5558", expect_avd="travelflow_p0_connect35", expect_sdk=35, port=19238, client="platform", case="all")
        return argparse.Namespace(**(values | changes))

    def test_real_serial_rejected_without_running_any_command(self):
        with patch.object(runner.subprocess, "run") as process:
            with self.assertRaisesRegex(RuntimeError, "emulator serial"):
                runner.run(self.options(serial="physical-device"))
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
