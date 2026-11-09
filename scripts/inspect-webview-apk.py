"""只读提取候选APK的版本、平台要求、库依赖及签名摘要；不安装或判断完整兼容。"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def inspect(apk, aapt2, apksigner, sdk):
    def run(*args):
        return subprocess.run([str(arg) for arg in args], check=True, capture_output=True,
                              text=True, timeout=60).stdout

    badging = run(aapt2, "dump", "badging", apk)
    manifest = run(aapt2, "dump", "xmltree", apk, "--file", "AndroidManifest.xml")
    certificates = run(apksigner, "verify", "--print-certs", apk)
    package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    minimum = re.search(r"^(?:minSdkVersion|sdkVersion):'([0-9]+)'", badging, re.M)
    maximum = re.search(r"^maxSdkVersion:'([0-9]+)'", badging, re.M)
    target = re.search(r"^targetSdkVersion:'([0-9]+)'", badging, re.M)
    if not package or not minimum:
        raise ValueError("APK package/minSdk metadata could not be established")
    native = []
    for line in badging.splitlines():
        if line.startswith(("native-code:", "alt-native-code:")):
            native.extend(re.findall(r"'([^']+)'", line))
    report = {
        "scope": "apk_metadata_only",
        "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
        "package": package.group(1),
        "versionCode": package.group(2),
        "versionName": package.group(3),
        "minSdk": int(minimum.group(1)),
        "maxSdk": int(maximum.group(1)) if maximum else None,
        "targetSdk": int(target.group(1)) if target else None,
        "examinedSdk": sdk,
        "minimumSdkMet": int(minimum.group(1)) <= sdk,
        "declaresWebViewLibrary": "com.android.webview.WebViewLibrary" in manifest,
        "nativeAbis": native,
        "staticLibraries": [line for line in badging.splitlines() if line.startswith("uses-static-library:")],
        "signerCertificateSha256": re.findall(r"Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-f]+)", certificates),
    }
    if not report["signerCertificateSha256"]:
        raise ValueError("Verified APK signer certificate could not be established")
    return report


def check_candidate(candidate, reference, expected_package, abi):
    # 严格匹配同包当前签名集合；不把密钥轮换或站点声称自动视为可信。
    checks = {
        "packageMatches": candidate["package"] == reference["package"] == expected_package,
        "signersMatch": sorted(candidate["signerCertificateSha256"]) == sorted(reference["signerCertificateSha256"]),
        "minimumSdkMet": candidate["minimumSdkMet"],
        "maximumSdkMet": candidate["maxSdk"] is None or candidate["examinedSdk"] <= candidate["maxSdk"],
        "abiPresent": abi in candidate["nativeAbis"],
        "webViewLibraryDeclared": candidate["declaresWebViewLibrary"],
        "noUnresolvedStaticLibraries": not candidate["staticLibraries"],
    }
    return {
        "scope": "webview_candidate_metadata_only",
        "referenceSha256": reference["sha256"],
        "expectedPackage": expected_package,
        "requiredAbi": abi,
        "checks": checks,
        "passed": all(checks.values()),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["apk", "aapt2", "apksigner"]:
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--sdk", required=True, type=int)
    parser.add_argument("--reference-apk", type=Path, help="Trusted same-package APK obtained independently from an official image")
    parser.add_argument("--expect-package")
    parser.add_argument("--require-abi")
    args = parser.parse_args()
    guards = [args.reference_apk, args.expect_package, args.require_abi]
    if any(guards) and not all(guards):
        parser.error("--reference-apk, --expect-package and --require-abi must be supplied together")
    report = inspect(args.apk, args.aapt2, args.apksigner, args.sdk)
    if all(guards):
        reference = inspect(args.reference_apk, args.aapt2, args.apksigner, args.sdk)
        report["candidateCheck"] = check_candidate(report, reference, args.expect_package, args.require_abi)
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if not all(guards) or report["candidateCheck"]["passed"] else 1)
