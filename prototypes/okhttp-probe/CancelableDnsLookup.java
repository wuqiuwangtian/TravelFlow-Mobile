package org.travelflow.p0;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.minidns.dnsmessage.DnsMessage;
import org.minidns.dnsmessage.Question;
import org.minidns.dnsname.DnsName;
import org.minidns.record.A;
import org.minidns.record.AAAA;
import org.minidns.record.CNAME;
import org.minidns.record.Data;
import org.minidns.record.Record;
import org.minidns.record.Record.TYPE;

/** P0兼容层：MiniDNS负责报文；本类持有I/O，关闭资源后取消。尚无缓存或搜索域。 */
final class CancelableDnsLookup {
    interface Binding {
        void bind(DatagramSocket socket) throws IOException;
        void bind(Socket socket) throws IOException;
        void opened();
        void closed();
    }

    private final List<InetSocketAddress> servers;
    private final Binding binding;
    static final class DeadlineExceeded extends SocketTimeoutException {
        DeadlineExceeded() { super("DNS absolute deadline"); }
    }

    private final long end;
    private final long retrySliceNanos;
    private Closeable owned;
    private boolean cancelled;

    CancelableDnsLookup(List<InetSocketAddress> servers, Binding binding) {
        this(servers, binding, System.nanoTime() + 10_000_000_000L, 1000);
    }

    CancelableDnsLookup(List<InetSocketAddress> servers, Binding binding, long absoluteDeadlineNanos, int retrySliceMillis) {
        if (servers.isEmpty() || servers.stream().anyMatch(server -> server.isUnresolved())) {
            throw new IllegalArgumentException("Explicit resolved network DNS servers required");
        }
        if (retrySliceMillis < 1 || retrySliceMillis > 10000) throw new IllegalArgumentException("Invalid retry slice");
        this.end = absoluteDeadlineNanos;
        this.retrySliceNanos = retrySliceMillis * 1_000_000L;
        this.servers = new ArrayList<>(servers);
        this.binding = binding;
    }

    synchronized void cancel() { cancelled = true; closeOwned(); }

    private synchronized void install(Closeable socket) throws IOException {
        binding.opened();
        if (cancelled) {
            try { socket.close(); } finally { binding.closed(); }
            throw new IOException("DNS cancelled");
        }
        if (owned != null) {
            try { socket.close(); } finally { binding.closed(); }
            throw new IllegalStateException("Overlapping DNS sockets");
        }
        owned = socket;
    }

    private synchronized void closeOwned() {
        if (owned == null) return;
        try { owned.close(); } catch (IOException ignored) { /* 再次关闭不隐藏主错误。 */ }
        finally { owned = null; binding.closed(); }
    }

    private synchronized void check() throws IOException {
        if (cancelled) throw new IOException("DNS cancelled");
        if (end - System.nanoTime() <= 0) throw new DeadlineExceeded();
    }

    private int remaining(long attemptEnd) throws IOException {
        check();
        long nanos = Math.min(end, attemptEnd) - System.nanoTime();
        if (nanos <= 0) throw new SocketTimeoutException("DNS I/O timeout");
        return (int) Math.max(1, Math.min(10000, (nanos + 999999) / 1000000));
    }

    List<InetAddress> lookup(String host) throws IOException {
        List<InetAddress> addresses = new ArrayList<>();
        addresses.addAll(resolveType(DnsName.from(host), TYPE.A));
        addresses.addAll(resolveType(DnsName.from(host), TYPE.AAAA));
        check();
        if (addresses.isEmpty()) throw new UnknownHostException("DNS has no address records");
        return addresses;
    }

    private List<InetAddress> resolveType(DnsName initial, TYPE type) throws IOException {
        DnsName current = initial;
        Set<DnsName> visited = new HashSet<>();
        for (int hop = 0; hop < 8; hop++) {
            check();
            if (!visited.add(current)) throw new IOException("DNS CNAME cycle");
            DnsMessage query = DnsMessage.builder().setId(UUID.randomUUID().hashCode() & 0xffff)
                .setRecursionDesired(true).setQuestion(new Question(current, type)).build();
            DnsMessage answer = exchange(query);
            if (answer.responseCode == DnsMessage.RESPONSE_CODE.NX_DOMAIN) throw new UnknownHostException("DNS NXDOMAIN");
            if (answer.responseCode != DnsMessage.RESPONSE_CODE.NO_ERROR) throw new IOException("DNS response failed");
            List<InetAddress> found = new ArrayList<>();
            DnsName target = null;
            for (Record<? extends Data> record : answer.answerSection) {
                if (!record.name.equals(current) || record.clazz != Record.CLASS.IN) continue;
                if (type == TYPE.A && record.payloadData instanceof A) found.add(((A) record.payloadData).getInetAddress());
                if (type == TYPE.AAAA && record.payloadData instanceof AAAA) found.add(((AAAA) record.payloadData).getInetAddress());
                if (record.payloadData instanceof CNAME) {
                    DnsName next = ((CNAME) record.payloadData).target;
                    if (target != null && !target.equals(next)) throw new IOException("Conflicting CNAME records");
                    target = next;
                }
            }
            if (!found.isEmpty()) {
                if (target != null) throw new IOException("Conflicting DNS address and CNAME");
                return found;
            }
            if (target == null) return found;
            current = target;
        }
        throw new IOException("DNS CNAME limit");
    }

    private DnsMessage parse(byte[] packet, DnsMessage query) throws IOException {
        try {
            DnsMessage answer = new DnsMessage(packet);
            if (answer.id != query.id || !answer.qr || answer.opcode != query.opcode ||
                answer.questions.size() != 1 || !answer.questions.get(0).equals(query.questions.get(0))) {
                throw new IOException("DNS response identity mismatch");
            }
            return answer;
        } catch (RuntimeException failure) { throw new IOException("Malformed DNS response", failure); }
    }

    private DnsMessage exchange(DnsMessage query) throws IOException {
        IOException last = null;
        for (int index = 0; index < servers.size(); index++) {
            check();
            long now = System.nanoTime();
            int left = servers.size() - index;
            // 有备用服务器时保留余量；最后一个服务器沿用剩余总预算，绝不重置期限。
            long attemptEnd = now + (left == 1 ? end - now : Math.min(retrySliceNanos, (end - now) / left));
            InetSocketAddress server = servers.get(index);
            try {
                remaining(attemptEnd);
                DnsMessage answer = udp(server, query, attemptEnd);
                if (answer.truncated) answer = tcp(server, query, attemptEnd);
                remaining(attemptEnd);
                if (answer.responseCode == DnsMessage.RESPONSE_CODE.SERVER_FAIL || answer.responseCode == DnsMessage.RESPONSE_CODE.REFUSED) {
                    throw new IOException("Retryable DNS server response");
                }
                return answer;
            } catch (IOException failure) { last = failure; }
        }
        check();
        throw last == null ? new IOException("No DNS response") : last;
    }

    private DnsMessage udp(InetSocketAddress server, DnsMessage query, long attemptEnd) throws IOException {
        DatagramSocket socket = new DatagramSocket(null);
        install(socket);
        try {
            binding.bind(socket); socket.connect(server);
            byte[] bytes = query.toArray(); socket.send(new DatagramPacket(bytes, bytes.length));
            while (true) {
                socket.setSoTimeout(remaining(attemptEnd));
                byte[] buffer = new byte[4096]; DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                byte[] data = java.util.Arrays.copyOf(buffer, packet.getLength());
                // 错误ID／问题／畸形包不延长本次I/O预算。
                try { return parse(data, query); } catch (IOException ignored) { check(); }
            }
        } finally { closeOwned(); }
    }

    private byte[] readExactly(Socket socket, InputStream input, int count, long attemptEnd) throws IOException {
        byte[] bytes = new byte[count]; int offset = 0;
        while (offset < count) {
            socket.setSoTimeout(remaining(attemptEnd));
            int read = input.read(bytes, offset, count - offset);
            if (read < 0) throw new IOException("Truncated DNS TCP frame");
            offset += read;
        }
        return bytes;
    }

    private DnsMessage tcp(InetSocketAddress server, DnsMessage query, long attemptEnd) throws IOException {
        Socket socket = new Socket();
        install(socket);
        try {
            binding.bind(socket); socket.connect(server, Math.min(1500, remaining(attemptEnd)));
            byte[] bytes = query.toArray();
            socket.getOutputStream().write(bytes.length >>> 8); socket.getOutputStream().write(bytes.length & 255);
            socket.getOutputStream().write(bytes); socket.getOutputStream().flush();
            InputStream input = socket.getInputStream();
            byte[] header = readExactly(socket, input, 2, attemptEnd);
            int length = ((header[0] & 255) << 8) | (header[1] & 255);
            if (length < 12) throw new IOException("Invalid DNS TCP frame");
            DnsMessage answer = parse(readExactly(socket, input, length, attemptEnd), query);
            if (answer.truncated) throw new IOException("Truncated DNS TCP response");
            return answer;
        } finally { closeOwned(); }
    }
}
