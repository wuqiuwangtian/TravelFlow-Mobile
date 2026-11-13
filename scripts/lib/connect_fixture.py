"""仅回环UDP的受控DNS对端；挂起固定虚构名，释放时返回NXDOMAIN，绝不转发。"""

import re
import socket
import socketserver
import struct
import threading
import time


def question(packet):
    if len(packet) < 12:
        raise ValueError("Truncated DNS header")
    _, flags, count, _, _, _ = struct.unpack("!6H", packet[:12])
    if flags & 0xF800 or count != 1:
        raise ValueError("Expected one standard DNS question")
    offset, labels = 12, []
    while True:
        if offset >= len(packet):
            raise ValueError("Truncated DNS name")
        size = packet[offset]
        offset += 1
        if size == 0:
            break
        if size > 63 or offset + size > len(packet):
            raise ValueError("Invalid DNS label")
        labels.append(packet[offset:offset + size].decode("ascii").lower())
        offset += size
    if offset + 4 > len(packet):
        raise ValueError("Truncated DNS question")
    kind, cls = struct.unpack("!2H", packet[offset:offset + 4])
    if cls != 1:
        raise ValueError("Expected IN class")
    return ".".join(labels), kind, packet[12:offset + 4]


def negative_reply(packet):
    _, _, query = question(packet)
    return packet[:2] + struct.pack("!5H", 0x8183, 1, 0, 0, 0) + query


def positive_reply(packet):
    _, kind, query = question(packet)
    answer = b"\xc0\x0c" + struct.pack("!2HIH", 1, 1, 0, 4) + b"\x0a\x00\x02\x02" if kind == 1 else b""
    return packet[:2] + struct.pack("!5H", 0x8180, 1, int(bool(answer)), 0, 0) + query + answer


class HeldDns:
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = []
        self.queries = []
        self.hold = True

    def handle(self, packet, address, sock):
        try:
            name, kind, _ = question(packet)
            reply = negative_reply(packet)
        except (ValueError, UnicodeError, struct.error):
            return
        controlled = re.fullmatch(r"tf[0-9a-f]{32}\.p0-dns\.invalid", name) and kind in (1, 28)
        positive = name == "valid.p0-dns.invalid" and kind in (1, 28)
        with self.lock:
            if controlled or positive:
                self.queries.append({"type": kind, "name": name})
                if controlled and self.hold:
                    self.pending.append((sock, address, reply, name))
                    return
        sock.sendto(positive_reply(packet) if positive else reply, address)

    def release(self):
        with self.lock:
            self.hold = False
            pending, self.pending = self.pending, []
        for sock, address, reply, _ in pending:
            sock.sendto(reply, address)

    def reset(self):
        with self.lock:
            if self.pending:
                raise ValueError("Cannot discard pending DNS questions")
            self.queries = []
            self.hold = True

    def snapshot(self):
        with self.lock:
            return {"queries": list(self.queries), "held": len(self.pending), "heldNames": [row[3] for row in self.pending], "released": not self.hold}


class DnsServer(socketserver.ThreadingUDPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, state, port=18516):
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                packet, sock = self.request
                state.handle(packet, self.client_address, sock)
        super().__init__(("127.0.0.1", port), Handler)


def dns_name(name):
    return b"".join(bytes([len(part)]) + part.encode("ascii") for part in name.split(".")) + b"\0"


class CodecDns(HeldDns):
    """封闭的协议边界对端；仅两个固定正例域名，不递归、不转发。"""
    MODES = ("direct", "cname", "tcp", "tcp-hold", "loop", "ipv6", "wrong-id", "wrong-question", "truncated-tcp", "nxdomain", "malformed", "drop", "servfail", "refused", "tcp-delay", "a-delay-aaaa-drop", "cname-slow", "wrong-id-stream")

    def __init__(self):
        super().__init__()
        self.mode = "direct"
        self.tcp_active = 0
        self.tcp_closed = 0
        self.tcp_connections = set()
        self.retired_connections = set()
        self.fixture_closed = 0

    def retire_tcp(self):
        """仅清理本对端持有的半开连接；不伪称客户端关闭。"""
        with self.lock:
            pending = list(self.tcp_connections - self.retired_connections)
            self.retired_connections.update(pending)
            self.fixture_closed += len(pending)
        for connection in pending:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def reset(self, mode="direct"):
        if mode not in self.MODES:
            raise ValueError("Unknown DNS fixture mode")
        with self.lock:
            if self.tcp_active:
                raise ValueError("TCP DNS still active")
        super().reset()
        with self.lock:
            self.mode = mode
            self.tcp_closed = 0
            self.fixture_closed = 0

    def snapshot(self):
        result = super().snapshot()
        with self.lock:
            result.update(mode=self.mode, tcpActive=self.tcp_active, tcpPeerClosed=self.tcp_closed, tcpFixtureClosed=self.fixture_closed)
        return result

    def handle(self, packet, address, sock, tcp=False):
        try:
            name, kind, query = question(packet)
        except (ValueError, UnicodeError, struct.error):
            return
        if name not in ("valid.p0-dns.invalid", "answer.p0-dns.invalid") or kind not in (1, 28):
            return super().handle(packet, address, sock)
        with self.lock:
            mode = self.mode
            self.queries.append({"name": name, "type": kind, "protocol": "tcp" if tcp else "udp", "receivedMs": int(time.monotonic() * 1000)})
        if mode == "drop" or (mode == "a-delay-aaaa-drop" and kind == 28):
            return
        if mode == "a-delay-aaaa-drop" or mode == "cname-slow":
            time.sleep(0.5)
        if mode == "tcp-delay" and not tcp:
            time.sleep(0.2)
        if mode in ("servfail", "refused"):
            reply = packet[:2] + struct.pack("!5H", 0x8182 if mode == "servfail" else 0x8185, 1, 0, 0, 0) + query
        elif mode == "nxdomain":
            reply = negative_reply(packet)
        elif mode in ("tcp", "tcp-hold", "truncated-tcp", "tcp-delay") and not tcp:
            reply = packet[:2] + struct.pack("!5H", 0x8380, 1, 0, 0, 0) + query
        elif mode in ("cname", "loop", "cname-slow") and (name == "valid.p0-dns.invalid" or mode == "loop"):
            target = "answer.p0-dns.invalid" if name == "valid.p0-dns.invalid" else "valid.p0-dns.invalid"
            data = dns_name(target)
            answer = b"\xc0\x0c" + struct.pack("!2HIH", 5, 1, 0, len(data)) + data
            reply = packet[:2] + struct.pack("!5H", 0x8180, 1, 1, 0, 0) + query + answer
        elif mode == "ipv6" and kind == 28:
            import ipaddress
            answer = b"\xc0\x0c" + struct.pack("!2HIH", 28, 1, 0, 16) + ipaddress.IPv6Address("2001:db8::1").packed
            reply = packet[:2] + struct.pack("!5H", 0x8180, 1, 1, 0, 0) + query + answer
        else:
            reply = positive_reply(packet)
        if mode in ("wrong-id", "wrong-question", "malformed"):
            bad = bytes([reply[0] ^ 1]) + reply[1:] if mode == "wrong-id" else (reply[:13] + b"x" + reply[14:] if mode == "wrong-question" else b"bad")
            if kind == 1 and len(bad) >= 16 and mode != "malformed":
                bad = bad[:-1] + b"\x63"  # 错误响应带污染地址，若被采纳，结果断言必定失败。
            sock.sendto(bad, address)
            # 给客户端辨识错误响应的机会，再提供正确响应；错误数据不可污染结果。
            time.sleep(0.03)
        if mode == "wrong-id-stream":
            bad = bytes([reply[0] ^ 1]) + reply[1:]
            for _ in range(32):
                sock.sendto(bad, address)
                time.sleep(0.03)
            return
        sock.sendto(reply, address)


class TcpDnsServer(socketserver.ThreadingTCPServer):
    # 允许上一轮TIME_WAIT后的重启；没有SO_REUSEPORT，仍拒绝已有监听器。
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, state, port):
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(12)

                def read_exactly(count):
                    data = b""
                    while len(data) < count:
                        part = self.request.recv(count - len(data))
                        if not part:
                            raise EOFError()
                        data += part
                    return data

                try:
                    size = struct.unpack("!H", read_exactly(2))[0]
                    packet = read_exactly(size)
                    name, _, _ = question(packet)
                    if name not in ("valid.p0-dns.invalid", "answer.p0-dns.invalid"):
                        return
                    with state.lock:
                        state.tcp_active += 1
                        state.tcp_connections.add(self.request)
                        mode = state.mode
                    try:
                        if mode in ("tcp-hold", "tcp-delay"):
                            with state.lock:
                                state.queries.append({"name": name, "type": question(packet)[1], "protocol": "tcp"})
                            if self.request.recv(1) == b"":
                                with state.lock:
                                    if self.request not in state.retired_connections:
                                        state.tcp_closed += 1
                        elif mode == "truncated-tcp":
                            self.request.sendall(b"\x00\x20bad")
                        else:
                            connection = self.request
                            class FramedSocket:
                                def sendto(self, reply, _):
                                    connection.sendall(struct.pack("!H", len(reply)) + reply)
                            state.handle(packet, self.client_address, FramedSocket(), tcp=True)
                    finally:
                        with state.lock:
                            state.tcp_connections.discard(self.request)
                            state.retired_connections.discard(self.request)
                            state.tcp_active -= 1
                except (OSError, EOFError, ValueError, struct.error):
                    pass
        super().__init__(("127.0.0.1", port), Handler)
