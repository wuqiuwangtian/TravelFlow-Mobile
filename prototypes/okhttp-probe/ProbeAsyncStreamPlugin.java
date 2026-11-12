package org.travelflow.p0;

import android.annotation.TargetApi;
import android.net.DnsResolver;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.ConnectionPool;
import okhttp3.Dns;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** 可选debug机制对照；旧系统UDP仅识别固定实验协议，不是正式DNS解析器。 */
@CapacitorPlugin(name = "ProbeAsyncStream")
public class ProbeAsyncStreamPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService closer = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final AtomicReference<Job> active = new AtomicReference<>();
    private final AtomicInteger workers = new AtomicInteger();
    private final AtomicInteger resolutions = new AtomicInteger();
    private final AtomicInteger dnsSockets = new AtomicInteger();
    private final OkHttpClient base = new OkHttpClient.Builder()
        .connectionPool(new ConnectionPool(0, 1, TimeUnit.SECONDS))
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(1500, TimeUnit.MILLISECONDS).readTimeout(1500, TimeUnit.MILLISECONDS).build();

    private interface Lookup {
        List<InetAddress> lookup(String host) throws UnknownHostException;
        void cancel();
    }

    private static class Job {
        final String id;
        final long started = SystemClock.elapsedRealtime();
        final AtomicReference<String> reason = new AtomicReference<>();
        volatile Call call;
        volatile Lookup lookup;
        volatile String stage = "connecting";
        volatile int status;
        volatile String dnsHost = "";
        ScheduledFuture<?> deadline;
        Job(String id) { this.id = id; }
    }

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("requestId", "");
        String transport = call.getString("transport", "http");
        String mode = call.getString("mode", "normal");
        String resolver = call.getString("resolver", "auto");
        int after = call.getInt("after", 0);
        if (!"10.0.2.2".equals(ProbeEndpoint.HOST) || !id.matches("[a-zA-Z0-9_-]{1,80}") ||
            !Set.of("http", "https", "dns", "dns-valid", "dns-hostname", "dns-untrusted", "dns-expired", "hostname", "untrusted", "expired", "handshake").contains(transport) ||
            !Set.of("normal", "stall", "drop", "http-error", "drip", "no-auth", "unauthorized", "redirect").contains(mode) ||
            !Set.of("auto", "system").contains(resolver) || after < 0 || after > 3) {
            call.reject("Invalid experimental options", "INVALID_OPTIONS"); return;
        }
        Job job = new Job(id);
        if (!active.compareAndSet(null, job)) { call.reject("A stream is still running", "STREAM_BUSY"); return; }
        call.resolve();
        job.deadline = timer.schedule(() -> stop(job, "DEADLINE"), "drip".equals(mode) ? 2500 : 6000, TimeUnit.MILLISECONDS);
        worker.execute(() -> run(job, transport, mode, resolver, after));
    }

    private void stop(Job job, String reason) {
        if (active.get() == job && job.reason.compareAndSet(null, reason)) {
            closer.execute(() -> {
                Lookup lookup = job.lookup;
                if (lookup != null) lookup.cancel();
                Call call = job.call;
                if (call != null) call.cancel();
            });
        }
    }

    private void emit(Job job, String type, String data, String eventId) {
        JSObject event = new JSObject();
        event.put("requestId", job.id); event.put("type", type); event.put("data", data); event.put("eventId", eventId);
        event.put("elapsedMs", SystemClock.elapsedRealtime() - job.started); event.put("stage", job.stage); event.put("httpStatus", job.status);
        notifyListeners("stream", event);
    }

    private List<InetAddress> resolve(Job job, String host, String resolver) throws UnknownHostException {
        if (!(host.equals("valid.p0-dns.invalid") || host.matches("tf[0-9a-f]{32}\\.p0-dns\\.invalid"))) {
            throw new UnknownHostException("Unexpected fixture name");
        }
        Lookup lookup;
        if ("system".equals(resolver)) {
            lookup = new Lookup() {
                public List<InetAddress> lookup(String name) throws UnknownHostException { return Dns.SYSTEM.lookup(name); }
                public void cancel() { /* 保留阻塞式系统解析，作为仅更换HTTP库的对照。 */ }
            };
        } else if (Build.VERSION.SDK_INT >= 29) {
            lookup = new PlatformLookup();
        } else {
            lookup = new FixtureLookup();
        }
        resolutions.incrementAndGet();
        job.lookup = lookup;
        try {
            if (job.reason.get() != null) lookup.cancel();
            List<InetAddress> addresses = lookup.lookup(host);
            if (job.reason.get() != null) throw new UnknownHostException("Cancelled");
            if (addresses.isEmpty() || addresses.stream().anyMatch(address -> !address.getHostAddress().equals("10.0.2.2"))) {
                throw new UnknownHostException("Unexpected fixture address");
            }
            return addresses;
        } finally {
            lookup.cancel();
            job.lookup = null;
            resolutions.decrementAndGet();
        }
    }

    private void run(Job job, String transport, String mode, String resolver, int after) {
        workers.incrementAndGet();
        String type = "error", detail = "UNEXPECTED_EOF";
        try {
            String host = "dns".equals(transport) ? "tf" + UUID.randomUUID().toString().replace("-", "") + ".p0-dns.invalid" :
                transport.startsWith("dns-") ? "valid.p0-dns.invalid" : ProbeEndpoint.HOST;
            if (host.endsWith(".p0-dns.invalid")) job.dnsHost = host;
            int port = switch (transport) { case "untrusted", "dns-untrusted" -> 18512; case "hostname", "dns-hostname" -> 18513; case "expired", "dns-expired" -> 18514;
                case "handshake" -> 18515; case "http" -> 18510; default -> 18511; };
            Request.Builder request = new Request.Builder().url(("http".equals(transport) ? "http" : "https") + "://" + host + ":" + port +
                "/stream?mode=" + mode + "&requestId=" + job.id).header("Accept", "text/event-stream").header("Last-Event-ID", Integer.toString(after));
            if (!Set.of("http", "dns").contains(transport) && !"no-auth".equals(mode)) {
                String credential;
                try { credential = "unauthorized".equals(mode) ? "fixture-wrong-token" : ProbeCredentials.read(getContext()); }
                catch (Exception failure) { throw new IOException("CREDENTIAL_UNAVAILABLE"); }
                request.header("Authorization", "Bearer " + credential);
            }
            OkHttpClient client = base.newBuilder().dns(name -> resolve(job, name, resolver)).build();
            job.call = client.newCall(request.build());
            if (job.reason.get() != null) return;
            try (Response response = job.call.execute()) {
                job.status = response.code();
                if (job.status != 200) throw new IOException("HTTP_STATUS");
                job.stage = "reading";
                if (!"text/event-stream".equals(response.header("Content-Type"))) throw new IOException("CONTENT_TYPE");
                StringBuilder data = new StringBuilder(); String eventId = ""; int total = 0;
                String line;
                while (job.reason.get() == null && (line = response.body().source().readUtf8Line()) != null) {
                    total += line.length();
                    if (total > 65536) throw new IOException("STREAM_LIMIT");
                    if (line.isEmpty()) {
                        if (data.length() > 0) {
                            String payload = data.substring(0, data.length() - 1);
                            if ("[DONE]".equals(payload)) { type = "done"; detail = ""; break; }
                            if (job.reason.get() == null) emit(job, "chunk", payload, eventId);
                        }
                        data.setLength(0);
                    } else if (line.startsWith("data:")) {
                        String value = line.substring(5); data.append(value.startsWith(" ") ? value.substring(1) : value).append('\n');
                    } else if (line.startsWith("id:")) eventId = line.substring(3).trim();
                }
            }
        } catch (SSLException error) { detail = "TLS_FAILED";
        } catch (UnknownHostException error) { detail = "DNS_FAILED";
        } catch (InterruptedIOException error) { detail = "TIMEOUT";
        } catch (IOException error) { detail = Set.of("HTTP_STATUS", "CONTENT_TYPE", "STREAM_LIMIT", "CREDENTIAL_UNAVAILABLE").contains(error.getMessage() == null ? "" : error.getMessage()) ? error.getMessage() : "NETWORK_OR_PROTOCOL";
        } catch (Exception error) { detail = "UNEXPECTED_FAILURE";
        } finally {
            job.deadline.cancel(false);
            if (job.lookup != null) job.lookup.cancel();
            base.connectionPool().evictAll();
            workers.decrementAndGet(); active.compareAndSet(job, null);
            String reason = job.reason.get();
            emit(job, "CANCELLED".equals(reason) ? "cancelled" : reason == null ? type : "error",
                "CANCELLED".equals(reason) ? "" : reason == null ? detail : reason, "");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Job job = active.get();
        if (job == null || !job.id.equals(call.getString("requestId", ""))) { call.reject("No matching request", "NO_ACTIVE_STREAM"); return; }
        stop(job, "CANCELLED"); call.resolve();
    }

    @PluginMethod
    public void resources(PluginCall call) {
        JSObject value = new JSObject(); value.put("active", active.get() != null); value.put("workers", workers.get());
        Job job = active.get(); value.put("dnsHost", job == null ? "" : job.dnsHost);
        value.put("resolutions", resolutions.get()); value.put("dnsSockets", dnsSockets.get());
        value.put("httpCalls", base.dispatcher().runningCallsCount()); value.put("connections", base.connectionPool().connectionCount());
        value.put("resolver", Build.VERSION.SDK_INT >= 29 ? "android-dnsresolver" : "synthetic-udp-only"); call.resolve(value);
    }

    @TargetApi(29)
    private static final class PlatformLookup implements Lookup {
        final CancellationSignal signal = new CancellationSignal();
        boolean done;
        List<InetAddress> result;
        UnknownHostException error;
        public List<InetAddress> lookup(String host) throws UnknownHostException {
            if (signal.isCanceled()) throw new UnknownHostException("Cancelled");
            DnsResolver.getInstance().query(null, host, DnsResolver.FLAG_EMPTY,
                Runnable::run, signal, new DnsResolver.Callback<List<InetAddress>>() {
                    public void onAnswer(List<InetAddress> answer, int code) { finish(answer, code == 0 ? null : new UnknownHostException("DNS response failed")); }
                    public void onError(DnsResolver.DnsException failure) { finish(null, new UnknownHostException("DNS query failed")); }
                });
            synchronized (this) {
                while (!done) try { wait(); } catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new UnknownHostException("Interrupted"); }
                if (error != null) throw error;
                return result;
            }
        }
        synchronized void finish(List<InetAddress> answer, UnknownHostException failure) {
            if (done) return;
            result = answer; error = failure; done = true; notifyAll();
        }
        public void cancel() {
            signal.cancel();
            finish(null, new UnknownHostException("Cancelled"));
        }
    }

    /** 仅固定模拟器对端的A记录协议；不实现公共DNS、CNAME、搜索域、TCP或网络切换。 */
    private final class FixtureLookup implements Lookup {
        DatagramSocket socket;
        boolean cancelled;
        synchronized void closeSocket() { if (socket != null) { socket.close(); socket = null; dnsSockets.decrementAndGet(); } }
        public synchronized void cancel() { cancelled = true; closeSocket(); }
        public List<InetAddress> lookup(String host) throws UnknownHostException {
            DatagramSocket current;
            try {
                synchronized (this) {
                    if (cancelled) throw new UnknownHostException("Cancelled");
                    current = socket = new DatagramSocket(); dnsSockets.incrementAndGet();
                }
                current.connect(InetAddress.getByAddress(new byte[]{10, 0, 2, 3}), 53);
                current.setSoTimeout(10000);
                int transaction = UUID.randomUUID().hashCode() & 0xffff;
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream query = new DataOutputStream(bytes);
                query.writeShort(transaction); query.writeShort(0x0100); query.writeShort(1); query.writeShort(0); query.writeShort(0); query.writeShort(0);
                for (String label : host.split("\\.")) { byte[] value = label.getBytes(StandardCharsets.US_ASCII); query.writeByte(value.length); query.write(value); }
                query.writeByte(0); query.writeShort(1); query.writeShort(1);
                byte[] packet = bytes.toByteArray(); current.send(new DatagramPacket(packet, packet.length));
                byte[] response = new byte[512]; DatagramPacket reply = new DatagramPacket(response, response.length); current.receive(reply);
                int offset = packet.length;
                if (reply.getLength() != offset + 16 || unsigned(response, 0) != transaction || unsigned(response, 2) != 0x8180 ||
                    unsigned(response, 4) != 1 || unsigned(response, 6) != 1 || unsigned(response, 8) != 0 || unsigned(response, 10) != 0 ||
                    !Arrays.equals(Arrays.copyOfRange(packet, 12, offset), Arrays.copyOfRange(response, 12, offset)) ||
                    unsigned(response, offset) != 0xc00c || unsigned(response, offset + 2) != 1 || unsigned(response, offset + 4) != 1 ||
                    unsigned(response, offset + 10) != 4) throw new UnknownHostException("Not a fixed fixture A response");
                return List.of(InetAddress.getByAddress(Arrays.copyOfRange(response, offset + 12, offset + 16)));
            } catch (IOException failure) {
                UnknownHostException error = new UnknownHostException("Fixture DNS unavailable"); error.initCause(failure); throw error;
            } finally { closeSocket(); }
        }
    }

    private static int unsigned(byte[] bytes, int offset) { return ((bytes[offset] & 255) << 8) | (bytes[offset + 1] & 255); }

    @Override protected void handleOnDestroy() {
        Job job = active.get(); if (job != null) stop(job, "CANCELLED");
        worker.shutdown(); closer.shutdown(); timer.shutdownNow(); base.connectionPool().evictAll();
        base.dispatcher().executorService().shutdown(); super.handleOnDestroy();
    }
}
