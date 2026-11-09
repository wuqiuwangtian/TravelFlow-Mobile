"""检查实际打包的debug/release网络策略与测试CA隔离，不安装或签名APK。"""

import argparse
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile


def policy_node(name, attrs=None, children=None, text=None):
    return {"name": name, "attrs": attrs or {}, "children": children or [], "text": text or []}


def parse_policy(dump):
    """读取固定aapt2 XML树的层级，不能仅凭字符串存在判断CA信任范围。"""
    stack = []
    root = None
    for line in dump.splitlines():
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        while stack and stack[-1][0] >= indent:
            stack.pop()
        element = re.fullmatch(r"\s*E: ([^ ]+)(?: \(line=[0-9]+\))?", line)
        if element:
            node = policy_node(element.group(1))
            if stack:
                stack[-1][1]["children"].append(node)
            else:
                assert root is None, "Multiple network policy roots"
                root = node
            stack.append((indent, node))
            continue
        assert stack, "Network policy attribute/text without element"
        attribute = re.fullmatch(r"\s*A: ([^= ]+)=(.+)", line)
        text = re.fullmatch(r"\s*T: '([^']*)'", line)
        if attribute:
            key, value = attribute.groups()
            value = value.split(" (Raw:", 1)[0]
            value = json.loads(value) if value.startswith('"') else value
            assert key not in stack[-1][1]["attrs"], "Duplicate network policy attribute"
            stack[-1][1]["attrs"][key] = value
        elif text:
            stack[-1][1]["text"].append(text.group(1))
        else:
            raise AssertionError("Unrecognized aapt2 network policy output")
    return root


def check(aapt2, debug, release, fixtures, target="emulator"):
    ca = (fixtures / "ca.pem").read_bytes()
    host = {"emulator": "10.0.2.2", "usb": "127.0.0.1"}[target]

    def dump(apk, kind, file=None):
        args = [str(aapt2), "dump", kind, str(apk)]
        if file:
            args += ["--file", file]
        return subprocess.run(args, check=True, capture_output=True, text=True).stdout

    report = {}
    for name, apk in [("debug", debug), ("release", release)]:
        resources = dump(apk, "resources")
        policy = re.search(r"resource (0x[0-9a-f]+) xml/p0_network_security\s+\(\) \(file\) (\S+)", resources)
        if not policy:
            raise AssertionError(f"{name}: no packaged network policy")
        config_id, config_file = policy.groups()
        manifest = dump(apk, "xmltree", "AndroidManifest.xml")
        assert re.search(r"networkSecurityConfig[^\n]*=@" + config_id, manifest), f"{name}: policy not attached"
        assert re.search(r"allowBackup[^\n]*=false", manifest), f"{name}: backup enabled"
        config = dump(apk, "xmltree", config_file)
        actual_policy = parse_policy(config)
        system = policy_node("certificates", {"src": "system"})
        base = policy_node("base-config", {"cleartextTrafficPermitted": "false"})
        with ZipFile(apk) as archive:
            endpoint = archive.read("assets/public/probe-endpoint.js").decode()
            assert endpoint == f"export const probeHost = {json.dumps(host)};\n", f"{name}: unexpected endpoint asset"
            ca_files = []
            native_libraries = [entry.filename for entry in archive.infolist() if entry.filename.startswith("lib/") and entry.filename.endswith(".so")]
            for entry in archive.infolist():
                data = archive.read(entry)
                assert not re.search(rb"-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----", data), f"{name}: private key packaged"
                assert not entry.filename.endswith((".key", ".csr")), f"{name}: TLS private artifact packaged"
                if data == ca:
                    ca_files.append(entry.filename)
        if name == "debug":
            assert len(ca_files) == 1, "debug must contain exactly one synthetic CA"
            ca_resource = re.search(r"resource (0x[0-9a-f]+) raw/p0_test_ca\s+\(\) \(file\) (\S+)", resources)
            assert ca_resource, "Missing packaged CA resource"
            assert ca_files == [ca_resource.group(2)], "Expected CA bytes must be the actual trust-anchor resource"
            anchors = policy_node("trust-anchors", children=[system, policy_node("certificates", {"src": "@" + ca_resource.group(1)})])
            domain = policy_node("domain", {"includeSubdomains": "false"}, text=[host])
            expected_policy = policy_node("network-security-config", children=[base,
                policy_node("domain-config", {"cleartextTrafficPermitted": "true"}, children=[domain, anchors])])
        else:
            assert not ca_files and "p0_test_ca" not in resources, "test CA leaked into release"
            assert "domain-config" not in config and "cleartextTrafficPermitted=true" not in config, "debug network exception leaked into release"
            assert not re.search(r"debuggable[^\n]*=true", manifest), "release is debuggable"
            base["children"] = [policy_node("trust-anchors", children=[system])]
            expected_policy = policy_node("network-security-config", children=[base])
        assert actual_policy == expected_policy, f"{name}: network policy broad or mismatched: {actual_policy}"
        report[name] = {"testCaFiles": len(ca_files), "backupAllowed": False,
                        "testHostCleartextAllowed": name == "debug", "nativeLibraries": native_libraries}
    print(json.dumps({"passed": True, "target": target, "probeHost": host, **report}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["aapt2", "debug", "release", "tls-fixtures"]:
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--target", choices=["emulator", "usb"], default="emulator")
    args = parser.parse_args()
    check(args.aapt2, args.debug, args.release, args.tls_fixtures, args.target)
