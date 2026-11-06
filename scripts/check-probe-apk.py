"""检查实际打包的debug/release网络策略与测试CA隔离，不安装或签名APK。"""

import argparse
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile


def check(aapt2, debug, release, fixtures):
    ca = (fixtures / "ca.pem").read_bytes()

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
        assert "cleartextTrafficPermitted=false" in config
        assert 'src="system"' in config
        with ZipFile(apk) as archive:
            ca_files = []
            for entry in archive.infolist():
                data = archive.read(entry)
                assert not re.search(rb"-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----", data), f"{name}: private key packaged"
                assert not entry.filename.endswith((".key", ".csr")), f"{name}: TLS private artifact packaged"
                if data == ca:
                    ca_files.append(entry.filename)
        if name == "debug":
            assert len(ca_files) == 1, "debug must contain exactly one synthetic CA"
            assert "domain-config" in config and "10.0.2.2" in config
            assert "cleartextTrafficPermitted=true" in config
        else:
            assert not ca_files and "p0_test_ca" not in resources, "test CA leaked into release"
            assert "domain-config" not in config and "cleartextTrafficPermitted=true" not in config, "debug network exception leaked into release"
            assert not re.search(r"debuggable[^\n]*=true", manifest), "release is debuggable"
        report[name] = {"testCaFiles": len(ca_files), "backupAllowed": False,
                        "testHostCleartextAllowed": name == "debug"}
    print(json.dumps({"passed": True, **report}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["aapt2", "debug", "release", "tls-fixtures"]:
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    check(args.aapt2, args.debug, args.release, args.tls_fixtures)
