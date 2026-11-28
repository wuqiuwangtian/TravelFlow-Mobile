"""Drive the pinned Windows management page in an isolated Edge profile for the Android test."""
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path.cwd()))
from desktop.console import close_console, console_request, open_console


class ManagerPage:
    def __init__(self, browser, folder):
        self.folder = folder
        self.page = browser.new_page()
        self.page.set_default_timeout(45000)
        self.record = None
        if folder.exists() and any(folder.iterdir()):
            raise ValueError("Expected an empty test manager directory")

    def open(self):
        self.record = open_console(self.folder, browser=False)
        self.pid = console_request(self.record)["pid"]
        self.page.goto(f"http://127.0.0.1:{self.record['port']}/#{self.record['token']}")
        expect(self.page.locator("#sync-start")).to_be_enabled(timeout=45000)

    def stop(self):
        if self.record:
            self.page.goto("about:blank")
            close_console(self.folder)
            self.record = None

    def start_service(self):
        self.page.locator("#sync-start").click()
        expect(self.page.locator("#sync-state")).to_contain_text("同步服务运行中", timeout=60000)
        return self.status()

    def status(self):
        endpoint = urlsplit(self.page.locator("#sync-endpoint").inner_text())
        ledger = self.page.locator("#sync-ledger").inner_text()
        match = re.search(r"(\d+) 笔消费.*?（(\d+) 分） · 分支头 (\S+)", ledger)
        if not endpoint.port or not match:
            raise ValueError("Expected live manager endpoint and ledger summary")
        devices, grants = [], []
        for card in self.page.locator("#sync-devices-list [data-device-id]").all():
            ident = card.get_attribute("data-device-id")
            label = card.inner_text()
            devices.append({"device_id": ident, "status": "revoked" if "已撤销" in label else "active"})
            grant = re.search(r"已授权业务来源 ID（source_device_id）：(\S+)", label)
            if grant:
                grants.append({"device_id": ident, "source_device_id": grant[1]})
        return dict(running=True, host=endpoint.hostname, port=endpoint.port,
                    pin=self.page.locator("#sync-cert").inner_text(), expenseCount=int(match[1]),
                    paidCents=int(match[2]), head=match[3], devices=devices, grants=grants, pid=self.pid)

    def run(self, request):
        action = request["action"]
        page = self.page
        if action == "start":
            self.open()
            page.locator("#sync-bind-host").fill(request["bind"])
            page.locator("#sync-port").fill(str(request.get("port", 0)))
            return self.start_service()
        if action == "restart":
            before = self.status()
            self.stop()
            self.open()
            assert before["pid"] != self.pid
            assert page.locator("#sync-port").input_value() == str(before["port"])
            assert page.locator("#sync-bind-host").input_value() == before["host"]
            return self.start_service()
        if action == "pairing":
            if request.get("fresh"):
                before = page.locator("#sync-pair-session").text_content()
                page.locator("#sync-open-pairing").click()
                expect(page.locator("#sync-pair-session")).not_to_have_text(before or "")
            elif not page.locator("#sync-pairing-box").is_visible():
                page.locator("#sync-open-pairing").click()
            page.locator("#sync-pairing-json").wait_for()
            return {"display": json.loads(page.locator("#sync-pairing-json").input_value())}
        pending = page.locator("#sync-pending-list [data-request-id]")
        if action in ("pending", "approve") and request.get("sas"):
            pending = pending.filter(has=page.locator(".sas-code").filter(has_text=request["sas"]))
        if action == "pending":
            pending.wait_for()
            label = pending.locator(".sync-card-title").inner_text()
            return dict(deviceId=re.search(r"配对设备 ID：([^）]+)", label)[1],
                        sas=pending.locator(".sas-code").inner_text())
        if action == "approve":
            assert pending.locator(".sas-code").inner_text() == request["sas"]
            pending.locator('[data-action="sync-approve"]').click()
            expect(pending).to_contain_text("已批准")
            return {}
        card = page.locator("#sync-devices-list [data-device-id]")
        if action == "grant":
            field = card.locator("[data-source-input]")
            if request.get("reauthorize"):
                # The page may remember the text previously typed for this same device ID.
                expect(card).to_contain_text("活跃 · 未授权旅行")
                assert field.input_value() in ("", request["source"])
            else:
                expect(field).to_have_value("")
            field.fill(request["source"])
            card.locator('[data-action="sync-authorize"]').click()
            expect(card).to_contain_text("已授权业务来源 ID")
            return self.status()
        if action == "revoke":
            card.locator('[data-action="sync-revoke"]').click()
            expect(card).to_contain_text("已撤销")
            return self.status()
        if action == "status":
            return self.status()
        if action == "close":
            self.stop()
            return {}
        raise ValueError("Unknown manager action")


def main():
    if sys.platform != "win32":
        raise RuntimeError("Requires Windows Python")
    os.environ["TRAVELFLOW_SYNC_PYTHON"] = sys.executable
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        manager = ManagerPage(browser, Path(sys.argv[1]))
        try:
            for line in sys.stdin:
                request = json.loads(line)
                try:
                    response = dict(ok=True, **manager.run(request))
                except Exception as error:
                    # Browser diagnostics can include a credential-bearing console launch URL.
                    response = dict(ok=False, error=f"{request['action']}: {type(error).__name__}")
                    if manager.record and manager.page.locator("#error").count():
                        response["pageError"] = manager.page.locator("#error").text_content()
                print(json.dumps(response), flush=True)
                if request["action"] == "close" or not response["ok"]:
                    break
        finally:
            manager.stop()
            browser.close()


if __name__ == "__main__":
    main()
