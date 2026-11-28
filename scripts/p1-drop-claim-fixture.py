"""Fixture for the archived Windows test server: disconnect one successful claim before HTTP headers."""
import os
from pathlib import Path
import sys

if "desktop.lan_pairing" in sys.orig_argv and "serve" in sys.orig_argv:
    from http.server import BaseHTTPRequestHandler

    marker = Path(os.environ["TRAVELFLOW_TEST_CLAIM_DROP"])
    original = BaseHTTPRequestHandler.send_response

    def send_response(handler, code, message=None):
        if handler.path == "/pair/complete" and code == 200 and marker.exists():
            marker.unlink()
            handler.close_connection = True
            # The pinned server has committed its one-shot claim at this point.
            # Avoid reading, recording or returning the token-bearing response.
            raise ConnectionAbortedError("isolated claim-reply-loss fixture")
        return original(handler, code, message)

    BaseHTTPRequestHandler.send_response = send_response
