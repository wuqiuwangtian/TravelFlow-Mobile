"""仅由已验证专用AVD的控制器注入shell；本模块不发现设备。"""
import re
import time


class RadioFixture:
    def __init__(self, shell):
        self.shell = shell
        self.original = None

    def settings(self):
        rows = dict(row.split("=", 1) for row in self.shell("settings", "list", "global").splitlines() if "=" in row)
        return {key: value for key, value in rows.items() if key in ("wifi_on", "airplane_mode_on") or re.fullmatch(r"mobile_data[0-9]*", key)}

    def offline(self):
        if self.original is not None:
            raise RuntimeError("Radio fixture already active")
        values = self.settings()
        if values.get("airplane_mode_on") != "0" or any(values.get(key) not in ("0", "1") for key in ("wifi_on", "mobile_data")):
            raise RuntimeError("Expected explicit radio states and airplane mode off")
        self.original = values  # 首次写入之前记录，部分失败也必须能恢复。
        self.shell("svc", "wifi", "disable")
        self.shell("svc", "data", "disable")
        return self.settings()

    def restore(self):
        if self.original is None:
            return
        for service, key in (("data", "mobile_data"), ("wifi", "wifi_on")):
            self.shell("svc", service, "enable" if self.original[key] == "1" else "disable")
        # svc可能按订阅建立mobile_dataN键；恢复值及键的存在性。
        current = self.settings()
        for key in sorted(set(current) | set(self.original)):
            if key == "airplane_mode_on" or current.get(key) == self.original.get(key):
                continue
            if key in self.original:
                self.shell("settings", "put", "global", key, self.original[key])
            else:
                self.shell("settings", "delete", "global", key)
        end = time.monotonic() + 3
        while self.settings() != self.original:
            if time.monotonic() >= end:
                raise RuntimeError("Radio settings did not restore exactly")
            time.sleep(0.05)
        self.original = None


class PrivateDnsFixture:
    """只允许固定本地DoT引导名；保留键的原值及存在性，不接收用户提供的地址。"""
    KEYS = ("private_dns_mode", "private_dns_specifier")

    def __init__(self, shell):
        self.shell = shell
        self.original = None

    def settings(self):
        rows = dict(row.split("=", 1) for row in self.shell("settings", "list", "global").splitlines() if "=" in row)
        return {key: rows[key] for key in self.KEYS if key in rows}

    def preflight(self):
        values = self.settings()
        if values.get("private_dns_mode") not in (None, "off", "opportunistic") or values.get("private_dns_specifier") not in (None, ""):
            raise RuntimeError("Do not replace an existing strict Private DNS configuration")
        return values

    def strict(self):
        if self.original is not None:
            raise RuntimeError("Private DNS fixture already active")
        self.original = self.preflight()
        self.shell("settings", "put", "global", "private_dns_specifier", "dot.p0-dns.invalid")
        self.shell("settings", "put", "global", "private_dns_mode", "hostname")

    def status(self):
        values = self.settings()
        return {"mode": values.get("private_dns_mode"), "specifierPresent": "private_dns_specifier" in values,
                "specifierConfigured": bool(values.get("private_dns_specifier")), "fixtureActive": self.original is not None}

    def restore(self):
        if self.original is None:
            return
        # 先结束严格模式，避免清理名称时仍以严格策略尝试解析。
        self.shell("settings", "put", "global", "private_dns_mode", "off")
        for key in ("private_dns_specifier", "private_dns_mode"):
            if key in self.original:
                self.shell("settings", "put", "global", key, self.original[key])
            else:
                self.shell("settings", "delete", "global", key)
        if self.settings() != self.original:
            raise RuntimeError("Private DNS settings did not restore exactly")
        self.original = None
