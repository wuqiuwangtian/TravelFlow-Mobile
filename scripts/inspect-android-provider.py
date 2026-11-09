"""只读核对明确隔离模拟器的系统与当前WebView；不安装、不切换提供方。"""

import argparse
import json
from pathlib import Path
import re
import subprocess


def inspect(adb, serial, expected_sdk):
    if not re.fullmatch(r"emulator-[0-9]+", serial):
        raise ValueError("An explicit isolated emulator serial is required")

    def shell(*args):
        return subprocess.run([str(adb), "-s", serial, "shell", *args], check=True,
                              capture_output=True, text=True, timeout=15).stdout.strip()

    emulator = shell("getprop", "ro.kernel.qemu") == "1" or shell("getprop", "ro.boot.qemu") == "1"
    if not emulator:
        raise ValueError("Target does not identify as an emulator")
    sdk = int(shell("getprop", "ro.build.version.sdk"))
    if sdk != expected_sdk:
        raise ValueError(f"Expected SDK {expected_sdk}, found {sdk}; verify the target before continuing")
    booted = shell("getprop", "sys.boot_completed") == "1"
    dump = shell("dumpsys", "webviewupdate")
    current = re.search(r"Current WebView package \(name, version\):\s*\(([^,]+),\s*([^)]+)\)", dump)
    provider = {"package": current.group(1).strip(), "version": current.group(2).strip()} if current else None
    selection_inspectable = current is not None or "Current WebView package is null" in dump
    configured = shell("settings", "get", "global", "webview_provider")
    report = {
        "scope": "android_webview_provider_only",
        "serial": serial,
        "sdk": sdk,
        "release": shell("getprop", "ro.build.version.release"),
        "abis": shell("getprop", "ro.product.cpu.abilist").split(","),
        "bootCompleted": booted,
        "currentProvider": provider,
        "selectionInspectable": selection_inspectable,
        "configuredProvider": configured if configured not in {"", "null"} else None,
        # API24的此dumpsys接口可能为空：未知不能写成“没有提供方”。
        "providerSelected": booted and provider is not None if selection_inspectable else None,
        "webViewService": dump,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report["providerSelected"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", required=True, type=Path)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--expect-sdk", required=True, type=int)
    args = parser.parse_args()
    selected = inspect(args.adb, args.serial, args.expect_sdk)
    # 0=已观察到提供方；1=明确未就绪；2=此接口无法判定。
    raise SystemExit(2 if selected is None else 0 if selected else 1)
