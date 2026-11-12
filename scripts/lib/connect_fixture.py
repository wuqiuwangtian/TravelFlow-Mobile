"""仅回环UDP的受控DNS对端；挂起固定虚构名，释放时返回NXDOMAIN，绝不转发。"""

import re
import socketserver
import struct
import threading


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
        with self.lock:
            if controlled:
                self.queries.append({"type": kind})
                if self.hold:
                    self.pending.append((sock, address, reply))
                    return
        sock.sendto(reply, address)

    def release(self):
        with self.lock:
            self.hold = False
            pending, self.pending = self.pending, []
        for sock, address, reply in pending:
            sock.sendto(reply, address)

    def reset(self):
        with self.lock:
            if self.pending:
                raise ValueError("Cannot discard pending DNS questions")
            self.queries = []
            self.hold = True

    def snapshot(self):
        with self.lock:
            return {"queries": list(self.queries), "held": len(self.pending), "released": not self.hold}


class DnsServer(socketserver.ThreadingUDPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, state, port=18516):
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                packet, sock = self.request
                state.handle(packet, self.client_address, sock)
        super().__init__(("127.0.0.1", port), Handler)
