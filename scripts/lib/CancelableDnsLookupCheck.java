package org.travelflow.p0;

import java.io.IOException;
import java.net.*;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** 运行真实回环I/O；不替换解析器或socket，不连接Android或公共DNS。 */
public final class CancelableDnsLookupCheck {
    public static void main(String[] args) throws Exception {
        String mode = args[1];
        AtomicInteger active = new AtomicInteger();
        CountDownLatch bound = new CountDownLatch(1);
        CancelableDnsLookup lookup = new CancelableDnsLookup(List.of(new InetSocketAddress(InetAddress.getLoopbackAddress(), Integer.parseInt(args[0]))), new CancelableDnsLookup.Binding() {
            public void bind(DatagramSocket socket) { if (mode.equals("udp-cancel")) bound.countDown(); }
            public void bind(Socket socket) { bound.countDown(); }
            public void opened() { active.incrementAndGet(); }
            public void closed() { if (active.decrementAndGet() < 0) throw new AssertionError("Double close"); }
        });
        if (mode.endsWith("cancel")) {
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                Future<?> task = worker.submit(() -> {
                    try { lookup.lookup(mode.equals("udp-cancel") ? "tf" + "a".repeat(32) + ".p0-dns.invalid" : "valid.p0-dns.invalid"); throw new AssertionError("Cancelled lookup succeeded"); }
                    catch (IOException expected) { /* 必须退出真正的I/O，不只改变Future状态。 */ }
                });
                if (!bound.await(2, TimeUnit.SECONDS)) throw new AssertionError("Socket not bound");
                Thread.sleep(200);
                long started = System.nanoTime();
                lookup.cancel(); task.get(1, TimeUnit.SECONDS);
                long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
                if (active.get() != 0) throw new AssertionError("Socket leaked");
                System.out.println("{\"cancelMs\":" + elapsed + ",\"sockets\":0}");
            } finally { lookup.cancel(); worker.shutdownNow(); }
        } else {
            boolean shouldFail = List.of("loop", "nxdomain", "truncated-tcp").contains(mode);
            try {
                List<InetAddress> addresses = lookup.lookup("valid.p0-dns.invalid");
                if (shouldFail) throw new AssertionError("Expected DNS failure");
                if (addresses.size() != (mode.equals("ipv6") ? 2 : 1) || !addresses.get(0).getHostAddress().equals("10.0.2.2")) throw new AssertionError("Wrong addresses: " + addresses);
                if (mode.equals("ipv6") && !addresses.get(1).equals(InetAddress.getByAddress(new byte[]{0x20,1,0x0d,(byte)0xb8,0,0,0,0,0,0,0,0,0,0,0,1}))) throw new AssertionError("Wrong AAAA");
            } catch (IOException failure) { if (!shouldFail) throw failure; }
            finally { lookup.cancel(); }
            if (active.get() != 0) throw new AssertionError("Socket leaked");
            System.out.println("{\"passed\":true,\"sockets\":0}");
        }
    }
}
