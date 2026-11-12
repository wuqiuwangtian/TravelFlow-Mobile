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
