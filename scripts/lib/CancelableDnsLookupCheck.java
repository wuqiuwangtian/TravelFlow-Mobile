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
        if (mode.startsWith("budget-")) { budget(args); return; }
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

    private static void budget(String[] args) throws Exception {
        String mode = args[1];
        int totalMillis = mode.equals("budget-cancel") ? 3000 : 800;
        int sliceMillis = mode.equals("budget-tcp") ? 300 : 120;
        AtomicInteger active = new AtomicInteger(), peak = new AtomicInteger();
        CountDownLatch tcpBound = new CountDownLatch(1);
        long started = System.nanoTime();
        List<InetSocketAddress> servers = new java.util.ArrayList<>();
        servers.add(new InetSocketAddress(InetAddress.getLoopbackAddress(), Integer.parseInt(args[0])));
        if (!List.of("budget-aaaa", "budget-cname", "budget-tcp-deadline", "budget-expired", "budget-late-result").contains(mode)) {
            servers.add(new InetSocketAddress(InetAddress.getLoopbackAddress(), Integer.parseInt(args[2])));
        }
        CancelableDnsLookup lookup = new CancelableDnsLookup(servers, new CancelableDnsLookup.Binding() {
            public void bind(DatagramSocket socket) {}
            public void bind(Socket socket) { tcpBound.countDown(); }
            public void opened() { peak.accumulateAndGet(active.incrementAndGet(), Math::max); }
            public void closed() {
                if (active.decrementAndGet() < 0) throw new AssertionError("Double close");
                if (mode.equals("budget-late-result")) try { Thread.sleep(450); }
                catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new AssertionError(failure); }
            }
        }, started + (mode.equals("budget-expired") ? -1 : totalMillis * 1_000_000L), sliceMillis);
        boolean deadline = false;
        long cancelMs = -1;
        if (mode.equals("budget-cancel")) {
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                Future<?> task = worker.submit(() -> {
                    try { lookup.lookup("valid.p0-dns.invalid"); throw new AssertionError("Cancelled failover succeeded"); }
                    catch (IOException expected) { }
                });
                if (!tcpBound.await(2, TimeUnit.SECONDS)) throw new AssertionError("Backup TCP not reached");
                Thread.sleep(200);
                long stopped = System.nanoTime();
                lookup.cancel(); task.get(1, TimeUnit.SECONDS);
                cancelMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - stopped);
            } finally { lookup.cancel(); worker.shutdownNow(); }
        } else {
            boolean expectedFailure = List.of("budget-all-drop", "budget-aaaa", "budget-cname", "budget-tcp-deadline", "budget-expired", "budget-nxdomain", "budget-both-error", "budget-late-result").contains(mode);
            try {
                List<InetAddress> addresses = lookup.lookup("valid.p0-dns.invalid");
                if (expectedFailure) throw new AssertionError("DNS failure expected");
                if (addresses.size() != 1 || !addresses.get(0).getHostAddress().equals("10.0.2.2")) throw new AssertionError("Wrong failover address");
            } catch (CancelableDnsLookup.DeadlineExceeded failure) {
                deadline = true;
                if (!expectedFailure || mode.equals("budget-nxdomain") || mode.equals("budget-both-error")) throw failure;
            } catch (UnknownHostException failure) {
                if (!mode.equals("budget-nxdomain")) throw failure;
            } catch (IOException failure) {
                if (!mode.equals("budget-both-error")) throw failure;
            } finally { lookup.cancel(); }
        }
        long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        if (active.get() != 0 || peak.get() > 1) throw new AssertionError("DNS resource overlap or leak");
        if (!mode.equals("budget-cancel") && elapsed > (mode.equals("budget-late-result") ? 1600 : 1100)) throw new AssertionError("Absolute budget was reset: " + elapsed);
        if (mode.equals("budget-expired") && peak.get() != 0) throw new AssertionError("Expired lookup opened a socket");
        System.out.println("{\"passed\":true,\"elapsedMs\":" + elapsed + ",\"deadline\":" + deadline + ",\"cancelMs\":" + cancelMs + ",\"sockets\":0,\"peakSockets\":" + peak.get() + "}");
    }

}
