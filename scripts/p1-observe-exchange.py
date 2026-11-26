"""Run the pinned server with a test observer that records exchange paths, never payloads or credentials."""
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import sys

trace = Path(sys.argv.pop(1))
trace.touch()
sys.path.insert(0, str(Path.cwd()))
from desktop.lan_pairing import main

parse_request = BaseHTTPRequestHandler.parse_request


def observe_request(handler):
    parsed = parse_request(handler)
    if parsed and handler.path.startswith("/exchange/"):
        with trace.open("a", encoding="utf-8") as output:
            print(handler.path, file=output)
    return parsed


BaseHTTPRequestHandler.parse_request = observe_request
raise SystemExit(main())
