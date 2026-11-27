"""Run the pinned server with a test observer that records paths and optional fixture operation IDs / byte hashes, without retaining bodies or credentials."""
from hashlib import sha256
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import sys

trace = Path(sys.argv.pop(1))
trace.touch()
sys.path.insert(0, str(Path.cwd()))
from desktop.lan_pairing import _DropReplyAfterCommit, _TripExchangeBridge, main

if sys.argv[1] == "--drop-second-create":
    sys.argv.pop(1)
    wire_trace = Path(sys.argv.pop(1))
    wire_trace.touch()
    create_count = 0
    receive = _TripExchangeBridge.receive_expense_create
    lookup = _TripExchangeBridge.lookup_receipt

    def observe_command(path, data):
        operation = json.loads(data)["operation"]["operation_id"]
        with wire_trace.open("a", encoding="utf-8") as output:
            print(json.dumps({"path": path, "operation": operation, "sha256": sha256(data).hexdigest()}), file=output)

    def observe_create(bridge, data, grant):
        global create_count
        observe_command("create", data)
        create_count += 1
        if create_count == 2:
            bridge.arm_fault_once("after_commit_before_reply")
        try:
            return receive(bridge, data, grant)
        except _DropReplyAfterCommit:
            observe_command("dropped", data)
            raise

    def observe_lookup(bridge, data, grant):
        observe_command("lookup", data)
        return lookup(bridge, data, grant)

    _TripExchangeBridge.receive_expense_create = observe_create
    _TripExchangeBridge.lookup_receipt = observe_lookup

parse_request = BaseHTTPRequestHandler.parse_request


def observe_request(handler):
    parsed = parse_request(handler)
    if parsed and handler.path.startswith("/exchange/"):
        with trace.open("a", encoding="utf-8") as output:
            print(handler.path, file=output)
    return parsed


BaseHTTPRequestHandler.parse_request = observe_request
raise SystemExit(main())
