"""虚构P0回显与分块测试服务，不是TravelFlow后端，不读取任何配置。"""

import json
import argparse
from contextlib import ExitStack
from pathlib import Path
import re
import select
import socket
import socketserver
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


# 只保存最多64次虚构请求的观测，供取消/恢复验收；不记录headers、token或业务内容。
observations = {}
observation_lock = threading.Lock()
handshakes = []
handshake_serial = 0


def remember(request_id, record):
    with observation_lock:
        if len(observations) >= 64:
            observations.pop(next(iter(observations)))
        observations[request_id] = record


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        request_id = query.get("requestId", [""])[0]
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", request_id):
            self.send_error(400)
            return
        if url.path in {"/observations", "/handshakes"}:
            with observation_lock:
                body = json.dumps(handshakes if url.path == "/handshakes" else observations.get(request_id)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/leak":
            remember("leak_" + request_id, {"authorizationPresent": bool(self.headers.get("Authorization"))})
            self.send_error(418)
            return
        mode = query.get("mode", ["normal"])[0]
        after = self.headers.get("Last-Event-ID", "0")
        if url.path != "/stream" or mode not in {"normal", "stall", "drop", "http-error", "drip", "no-auth", "unauthorized", "redirect"} or after not in {"0", "1", "2", "3"}:
            self.send_error(400)
            return
        started = time.monotonic()
        authorized = self.headers.get("Authorization") == "Bearer fixture-stream-token"
        record = {"mode": mode, "after": int(after), "sent": [], "outcome": "running",
                  "authorizationPresent": bool(self.headers.get("Authorization")), "authorized": authorized,
                  "fixtureHost": self.headers.get("Host") if self.headers.get("Host", "").split(":")[0] in {self.server.probe_host, "valid.p0-dns.invalid"} else "unexpected",
                  "fixtureSni": getattr(self.connection, "fixture_sni", None)}
        remember(request_id, record)
        self.close_connection = True
        if isinstance(self.connection, ssl.SSLSocket) and not authorized:
            record["outcome"] = "http_401"
            self.send_error(401)
            return
        if mode == "http-error":
            record["outcome"] = "http_503"
            self.send_error(503)
            return
        if mode == "redirect":
            record["outcome"] = "redirect"
            self.send_response(307)
            self.send_header("Location", f"http://{self.server.probe_host}:18510/leak?requestId=" + request_id)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        # 无CORS；必须经过Android原生传输。
        self.end_headers()

        def chunk(body):
            self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n")
            self.wfile.flush()

        def pause(seconds):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if select.select([self.connection], [], [], min(0.05, max(0, until - time.monotonic())))[0]:
                    if isinstance(self.connection, ssl.SSLSocket):
                        self.connection.settimeout(0.1)
                        try:
                            if not self.connection.recv(1):
                                raise ConnectionAbortedError("synthetic TLS peer closed")
                        except TimeoutError:
                            pass
                    elif not self.connection.recv(1, socket.MSG_PEEK):
                        raise ConnectionAbortedError("synthetic peer closed")

        try:
            for number in range(int(after) + 1, 21 if mode == "drip" else 4):
                body = f'id: {number}\r\ndata: {{"part":{number},"text":"旅途{number}"}}\r\n\r\n'.encode()
                # 故意在中文UTF-8字节中间切断，不能把TCP分片当作完整文本/事件。
                cut = body.index("旅".encode()) + 1
                chunk(body[:cut])
                pause(0.1)
                chunk(body[cut:])
                with observation_lock:
                    record["sent"].append({"id": number, "elapsedMs": round((time.monotonic() - started) * 1000)})
                if mode == "drop":
                    # 不写HTTP结束块或SSE完成标记，模拟响应中断。
                    with observation_lock:
                        record["outcome"] = "dropped"
                    return
                pause(5 if mode == "stall" else 0.4 if mode == "drip" else 0.8)
            chunk(b"data: [DONE]\r\n\r\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            with observation_lock:
                record["outcome"] = "done"
        except (ConnectionError, OSError):
            with observation_lock:
                record["outcome"] = "peer_closed"
        finally:
            with observation_lock:
                record["elapsedMs"] = round((time.monotonic() - started) * 1000)

    def do_POST(self):
        if self.path != "/echo":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024:
                raise ValueError("invalid length")
            data = json.loads(self.rfile.read(size))
            if self.headers.get("X-P0-Token") != "fixture-token":
                raise ValueError("invalid fixture token")
            if data != {"message": "synthetic-p0"}:
                raise ValueError("unexpected synthetic request")
        except (ValueError, UnicodeError):
            self.send_error(400)
            return
        body = b'{"probe":"ok"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # 故意不设置CORS：原生HTTP应独立执行，不依赖浏览器代理绕过。
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # 不记录请求体或任何凭据。


class HandshakeSink(socketserver.BaseRequestHandler):
    """接收ClientHello但不回复：TLS连接阶段停顿，不冒充TCP SYN超时。"""

    def handle(self):
        global handshake_serial
        started = time.monotonic()
        record = {"outcome": "accepted", "receivedBytes": 0}
        with observation_lock:
            handshake_serial += 1
            record["sequence"] = handshake_serial
            handshakes.append(record)
            del handshakes[:-16]
        self.request.settimeout(8)
        try:
            while data := self.request.recv(4096):
                with observation_lock:
                    record["receivedBytes"] += len(data)
            record["outcome"] = "peer_closed"
        except OSError:
            record["outcome"] = "socket_error"
        finally:
            record["elapsedMs"] = round((time.monotonic() - started) * 1000)


class HandshakeServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TLSFixtureServer(ThreadingHTTPServer):
    # 握手在有超时的请求线程中进行，未完成握手不能堵住accept或服务退出。
    def process_request_thread(self, request, address):
        try:
            request.settimeout(4)
            request = self.tls_context.wrap_socket(request, server_side=True)
            super().process_request_thread(request, address)
        except OSError:
            request.close()


def serve(fixtures=None, target="emulator"):
    host = {"emulator": "10.0.2.2", "usb": "127.0.0.1"}[target]
    if fixtures:
        fixtures = fixtures.resolve()
        manifest = json.loads((fixtures / "fixture.json").read_text())
        if manifest.get("kind") != "travelflow-synthetic-tls-v1" or manifest.get("host", "10.0.2.2") != host:
            raise ValueError("Invalid synthetic TLS fixture or target mismatch")
    print("P0 synthetic HTTP fixture on 127.0.0.1:18510", flush=True)
    with ExitStack() as stack:
        server = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 18510), Handler))
        server.probe_host = host
        extra = []
        if fixtures:
            for port, name in [(18511, "valid"), (18512, "untrusted"), (18513, "hostname"), (18514, "expired")]:
                tls = stack.enter_context(TLSFixtureServer(("127.0.0.1", port), Handler))
                tls.probe_host = host
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.load_cert_chain(fixtures / f"{name}.pem", fixtures / f"{name}.key")
                context.set_servername_callback(lambda sock, server_name, _: setattr(sock, "fixture_sni", server_name if server_name == "valid.p0-dns.invalid" else "unexpected"))
                tls.tls_context = context
                extra.append(tls)
            extra.append(stack.enter_context(HandshakeServer(("127.0.0.1", 18515), HandshakeSink)))
            for listener in extra:
                threading.Thread(target=listener.serve_forever, daemon=True).start()
            print("Synthetic TLS fixtures on 127.0.0.1:18511-18515", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            for listener in extra:
                listener.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tls-fixtures", type=Path)
    parser.add_argument("--target", choices=["emulator", "usb"], default="emulator")
    args = parser.parse_args()
    serve(args.tls_fixtures, args.target)
