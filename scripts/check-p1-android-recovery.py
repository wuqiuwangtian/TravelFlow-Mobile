"""Build a test-only native fixture and exercise it on an explicitly selected project AVD."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

SOURCE = Path(__file__).resolve().parents[1] / "prototypes/p1-android-recovery"
PACKAGE = "org.travelflow.p1recovery"
AVD = "travelflow_p0_api35"
SCENARIOS = ("staged", "ready", "revision", "expense", "receipt", "outbox", "committed", "full")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, timeout=120):
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    require(proc.returncode == 0, f"{Path(args[0]).name} failed: {proc.stdout}")
    return proc.stdout.strip()


def build(tmp, sdk, java):
    tools = sdk / "build-tools/35.0.0"
    jar = sdk / "platforms/android-36/android.jar"
    classes = tmp / "classes"
    classes.mkdir()
    run(java / "javac", "--release", "8", "-classpath", jar, "-d", classes, *sorted(SOURCE.glob("*.java")))
    run(tools / "d8", "--min-api", "28", "--lib", jar, "--output", tmp, *classes.rglob("*.class"))
    unsigned = tmp / "unsigned.apk"
    run(tools / "aapt2", "link", "-o", unsigned, "-I", jar, "--manifest", SOURCE / "AndroidManifest.xml")
    with zipfile.ZipFile(unsigned, "a") as apk:
        apk.write(tmp / "classes.dex", "classes.dex")
    aligned = tmp / "aligned.apk"
    run(tools / "zipalign", "4", unsigned, aligned)
    key = tmp / "fixture.p12"
    run(java / "keytool", "-genkeypair", "-keystore", key, "-storepass", "fixture-only",
        "-alias", "fixture", "-keyalg", "RSA", "-validity", "2", "-dname", "CN=Temporary Recovery Fixture")
    apk = tmp / "fixture.apk"
    run(tools / "apksigner", "sign", "--ks", key, "--ks-pass", "pass:fixture-only", "--out", apk, aligned)
    run(tools / "apksigner", "verify", apk)
    return apk


def exercise(adb):
    def action(name, case):
        log = adb("shell", "am", "instrument", "-w", "-r", "-e", "action", name, "-e", "scenario", case,
                  PACKAGE + "/.RecoveryFixture")
        if name == "race":
            evidence = re.search(r"^INSTRUMENTATION_STATUS: observation=(\{.*\})$", log, re.M)
            require(evidence and "Process crashed" in log and "INSTRUMENTATION_RESULT: fixture=" not in log, log)
            return json.loads(evidence[1])
        if name == "fault" and case != "full":
            require("INSTRUMENTATION_STATUS: checkpoint=" + case in log and
                    "Process crashed" in log and "INSTRUMENTATION_RESULT: fixture=" not in log, log)
            return
        result = re.search(r"^INSTRUMENTATION_RESULT: fixture=(\{.*\})$", log, re.M)
        require(result and "INSTRUMENTATION_CODE: -1" in log, log)
        return json.loads(result[1])

    def inspect(case, head, staged, ticket):
        actual = action("inspect", case)
        expected = dict(head=head, cents=700 if head == 0 else 756, history=head + 1, receipt=head, outbox=head,
                        seed_intact=1, edit_chain=int(head >= 1), detached_chain=int(head == 2), space_probe=0,
                        staged=staged, ticket=ticket, ticket_intact=ticket, unmanaged_intact=True)
        require({k: actual[k] for k in expected} == expected, f"{case}: expected {expected}, got {actual}")
        return actual

    for case in SCENARIOS:
        action("init", case)
        result = action("fault", case)
        if case == "full":
            require(result == {"outcome": "sqlite_full"}, str(result))
        committed = case == "committed"
        receipt = action("lookup", case)
        require(receipt == {"revision": 1 if committed else None}, f"{case} receipt: {receipt}")
        inspect(case, int(committed), case == "staged", case != "staged")
        action("recover", case)
        inspect(case, int(committed), False, committed)
        expected = "replayed-1" if committed else "committed-1"
        require(action("retry", case)["outcome"] == expected, f"{case} retry")
        state = inspect(case, 1, False, True)
        print(f"{case}: recovered, {expected}; SQLite {state['sqlite']} ({state['journal']})", flush=True)
    case = "committed"
    require(action("detach", case)["outcome"] == "committed-2", "detach")
    action("recover", case)
    action("recover", case)
    require(action("lookup", case) == {"revision": 1}, "lookup after detach")
    require(action("conflict", case)["outcome"] == "intent_conflict", "conflict")
    require(action("retry", case)["outcome"] == "replayed-1", "historical receipt")
    inspect(case, 2, False, True)
    print("Historical attachment, original receipt and intent conflict verified.")
    def check_caller_rows(data, edit, raw, revision):
        expected = dict(head=revision, cents=edit["amount_cents"] if revision else 700, history=revision + 1,
                        receipt=revision, outbox=revision, committed_intent=raw if revision else None)
        require(all(data[k] == v for k, v in expected.items()), f"expected {expected}, got {data}")

    for case in ("lock-commit", "lock-rollback"):
        action("init", case)
        raw = action("prepare", case)["pending"]
        edit = json.loads(raw)
        race = action("race", case)
        require(race["state"] == "pending_busy" and race["plain_receipts"] == 0 and race["pending"] == raw
                and race["caller_pid"] != race["writer_pid"], str(race))
        reopened = action("snapshot", case)
        require(reopened["caller_pid"] != race["caller_pid"] and reopened["pending"] == raw
                and reopened["confirmed_op"] is None, str(reopened))
        committed = int(case == "lock-commit")
        check_caller_rows(reopened, edit, raw, committed)
        lookup = action("reconcile", case)
        if not committed:
            require(lookup["state"] == "no_receipt" and lookup["pending"] == raw and lookup["confirmed_op"] is None,
                    str(lookup))
            check_caller_rows(lookup, edit, raw, 0)
            lookup = action("resubmit", case)
            require(lookup["submission"] == "committed-1", str(lookup))
        require(lookup["state"] == "confirmed" and lookup["pending"] is None
                and lookup["confirmed_op"] == edit["operation_id"] and lookup["confirmed_rev"] == 1, str(lookup))
        again = action("resubmit", case)
        require(again["state"] == "confirmed" and "submission" not in again and again["pending"] is None
                and again["confirmed_op"] == edit["operation_id"] and again["confirmed_rev"] == 1, str(again))
        check_caller_rows(again, edit, raw, 1)
        print(f"{case}: busy lookup kept original intent across caller death; one confirmed revision.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build-only", action="store_true")
    mode.add_argument("--serial", help="Running emulator serial for " + AVD)
    args = parser.parse_args()
    sdk = Path(os.environ["ANDROID_HOME"])
    java = Path(os.environ["JAVA_HOME"]) / "bin"
    with tempfile.TemporaryDirectory(prefix="travelflow-p1-recovery-") as tmp:
        apk = build(Path(tmp), sdk, java)
        if args.build_only:
            print("Native recovery fixture APK built and signature verified.")
            return
        require(re.fullmatch(r"emulator-[0-9]+", args.serial), "Expected an explicit emulator serial")

        def adb(*parts):
            return run(sdk / "platform-tools/adb", "-s", args.serial, *parts)

        require(adb("shell", "getprop", "ro.boot.qemu.avd_name") == AVD, "Unexpected AVD")
        require(adb("shell", "getprop", "ro.build.version.sdk") == "35", "Expected API 35")
        require(adb("shell", "getprop", "sys.boot_completed") == "1", "AVD is still booting")
        existing = adb("shell", "pm", "list", "packages", "-u", PACKAGE)
        require("package:" + PACKAGE not in existing.splitlines(), "Existing fixture package; refusing replacement")
        require("Success" in adb("install", "-t", apk), "Fixture install failed")
        try:
            exercise(adb)
        finally:
            require("Success" in adb("uninstall", PACKAGE), "Fixture uninstall failed")


if __name__ == "__main__":
    main()
