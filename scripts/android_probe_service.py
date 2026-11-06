"""虚构P0回显与分块测试服务，不是TravelFlow后端，不读取任何配置。"""

import json
import re
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


# 只保存最多64次虚构请求的观测，供取消/恢复验收；不记录headers、token或业务内容。
observations = {}
observation_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        request_id = query.get("requestId", [""])[0]
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", request_id):
            self.send_error(400)
            return
        if url.path == "/observations":
            with observation_lock:
                body = json.dumps(observations.get(request_id)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        mode = query.get("mode", ["normal"])[0]
        after = self.headers.get("Last-Event-ID", "0")
        if url.path != "/stream" or mode not in {"normal", "stall", "drop", "http-error"} or after not in {"0", "1", "2", "3"}:
            self.send_error(400)
            return
        if mode == "http-error":
            self.send_error(503)
            return
        started = time.monotonic()
        record = {"mode": mode, "after": int(after), "sent": [], "outcome": "running"}
        with observation_lock:
            if len(observations) >= 64:
                observations.pop(next(iter(observations)))
            observations[request_id] = record
        self.close_connection = True
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
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        raise ConnectionAbortedError("synthetic peer closed")

        try:
            for number in range(int(after) + 1, 4):
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
                pause(5 if mode == "stall" else 0.8)
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


if __name__ == "__main__":
    print("P0 synthetic HTTP fixture on 127.0.0.1:18510", flush=True)
    with ThreadingHTTPServer(("127.0.0.1", 18510), Handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
