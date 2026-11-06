package org.travelflow.p0;

import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLException;

/** 仅用于固定虚构服务的P0传输实验，不接收任意URL、凭据或业务数据。 */
@CapacitorPlugin(name = "ProbeStream")
public class ProbeStreamPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService closer = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final AtomicReference<Job> active = new AtomicReference<>();

    private static class Job {
        final String id;
        final long started = SystemClock.elapsedRealtime();
        final AtomicReference<String> stopReason = new AtomicReference<>();
        volatile String stage = "connecting";
        volatile int httpStatus;
        ScheduledFuture<?> deadline;
        volatile HttpURLConnection connection;
        Job(String id) { this.id = id; }
    }

    private void emit(Job job, String type, String data, String eventId) {
        JSObject event = new JSObject();
        event.put("requestId", job.id);
        event.put("type", type);
        event.put("elapsedMs", SystemClock.elapsedRealtime() - job.started);
        event.put("data", data);
        event.put("eventId", eventId);
        event.put("stage", job.stage);
        event.put("httpStatus", job.httpStatus);
        notifyListeners("stream", event);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("requestId", "");
        String mode = call.getString("mode", "normal");
        String transport = call.getString("transport", "http");
        int after = call.getInt("after", 0);
        if (!id.matches("[a-zA-Z0-9_-]{1,80}") || after < 0 || after > 3 ||
            !Set.of("normal", "stall", "drop", "http-error", "drip", "no-auth", "unauthorized", "redirect").contains(mode) ||
            !Set.of("http", "https", "untrusted", "hostname", "expired", "handshake").contains(transport)) {
            call.reject("Invalid synthetic stream options", "INVALID_OPTIONS");
            return;
        }
        Job job = new Job(id);
        if (!active.compareAndSet(null, job)) {
            call.reject("A stream is still running", "STREAM_BUSY");
            return;
        }
        // 先确认请求已登记；结果通过监听事件返回。取消确认不等于网络已停止。
        call.resolve();
        job.deadline = deadlines.schedule(() -> stop(job, "DEADLINE"), "drip".equals(mode) ? 2500 : 6000, TimeUnit.MILLISECONDS);
        worker.execute(() -> run(job, mode, transport, after));
    }

    private void stop(Job job, String reason) {
        if (active.get() == job && job.stopReason.compareAndSet(null, reason)) {
            closer.execute(() -> { if (job.connection != null) job.connection.disconnect(); });
        }
    }

    private void run(Job job, String mode, String transport, int after) {
        String terminal = "error";
        String detail = "UNEXPECTED_EOF";
        try {
            int port = switch (transport) {
                case "https" -> 18511;
                case "untrusted" -> 18512;
                case "hostname" -> 18513;
                case "expired" -> 18514;
                case "handshake" -> 18515;
                default -> 18510;
            };
            String scheme = "http".equals(transport) ? "http" : "https";
            HttpURLConnection connection = (HttpURLConnection) new URL(
                scheme + "://10.0.2.2:" + port + "/stream?mode=" + mode + "&requestId=" + job.id
            ).openConnection();
            job.connection = connection;
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("Last-Event-ID", Integer.toString(after));
            // 虚构凭据在原生Keystore实验中解密，只加入HTTPS请求，不通过桥返回。
            if (!"http".equals(transport) && !"no-auth".equals(mode)) {
                String credential;
                try {
                    credential = "unauthorized".equals(mode) ? "fixture-wrong-token" : ProbeCredentials.read(getContext());
                } catch (Exception error) {
                    throw new IOException("CREDENTIAL_UNAVAILABLE");
                }
                connection.setRequestProperty("Authorization", "Bearer " + credential);
            }
            if (job.stopReason.get() != null) return;
            job.httpStatus = connection.getResponseCode();
            if (job.httpStatus != 200) throw new IOException("HTTP_STATUS");
            job.stage = "reading";
            if (!"text/event-stream".equals(connection.getContentType())) throw new IOException("CONTENT_TYPE");
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                connection.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder data = new StringBuilder();
                String eventId = "";
                int total = 0;
                String line;
                // 此解析器只验收受控SSE样例；不是通用供应商协议适配器。
                while (job.stopReason.get() == null && (line = reader.readLine()) != null) {
                    total += line.length();
                    if (total > 65536) throw new IOException("STREAM_LIMIT");
                    if (line.isEmpty()) {
                        if (data.length() > 0) {
                            String payload = data.substring(0, data.length() - 1);
                            if ("[DONE]".equals(payload)) {
                                terminal = "done";
                                detail = "";
                                break;
                            }
                            if (job.stopReason.get() == null) emit(job, "chunk", payload, eventId);
                        }
                        data.setLength(0);
                    } else if (line.startsWith("data:")) {
                        String value = line.substring(5);
                        data.append(value.startsWith(" ") ? value.substring(1) : value).append('\n');
                    } else if (line.startsWith("id:")) {
                        eventId = line.substring(3).trim();
                    }
                }
            }
        } catch (SocketTimeoutException error) {
            detail = "connecting".equals(job.stage) ? "CONNECT_TIMEOUT" : "TIMEOUT";
        } catch (SSLException error) {
            detail = "TLS_FAILED";
        } catch (IOException error) {
            detail = Set.of("HTTP_STATUS", "CREDENTIAL_UNAVAILABLE").contains(error.getMessage() == null ? "" : error.getMessage())
                ? error.getMessage() : "NETWORK_OR_PROTOCOL";
        } finally {
            job.deadline.cancel(false);
            if (job.connection != null) job.connection.disconnect();
            active.compareAndSet(job, null);
            // 仅工作线程退出且连接已关闭后发终态，每个请求只发一个终态。
            String reason = job.stopReason.get();
            emit(job, "CANCELLED".equals(reason) ? "cancelled" : reason == null ? terminal : "error",
                "CANCELLED".equals(reason) ? "" : reason == null ? detail : reason, "");
        }
    }

    @PluginMethod
    public void prepareCredentialFixture(PluginCall call) {
        if (active.get() != null) { call.reject("A stream is still running", "STREAM_BUSY"); return; }
        try {
            ProbeCredentials.prepare(getContext());
            call.resolve();
        } catch (Exception error) {
            call.reject("Synthetic credential could not be stored", "CREDENTIAL_STORE_FAILED");
        }
    }

    @PluginMethod
    public void clearCredentialFixture(PluginCall call) {
        if (active.get() != null) { call.reject("A stream is still running", "STREAM_BUSY"); return; }
        try {
            ProbeCredentials.clear(getContext());
            call.resolve();
        } catch (Exception error) {
            call.reject("Synthetic credential could not be removed", "CREDENTIAL_CLEAR_FAILED");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Job job = active.get();
        if (job == null || !job.id.equals(call.getString("requestId", ""))) {
            call.reject("No matching active stream", "NO_ACTIVE_STREAM");
            return;
        }
        // disconnect不能阻塞桥线程，否则离线本地写入也会被网络拖住。
        stop(job, "CANCELLED");
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        Job job = active.get();
        if (job != null) stop(job, "CANCELLED");
        worker.shutdown();
        deadlines.shutdownNow();
        closer.shutdown();
        super.handleOnDestroy();
    }
}
