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
import java.util.concurrent.atomic.AtomicReference;

/** 仅用于固定虚构服务的P0传输实验，不接收任意URL、凭据或业务数据。 */
@CapacitorPlugin(name = "ProbeStream")
public class ProbeStreamPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService closer = Executors.newSingleThreadExecutor();
    private final AtomicReference<Job> active = new AtomicReference<>();

    private static class Job {
        final String id;
        final long started = SystemClock.elapsedRealtime();
        volatile boolean cancelled;
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
        notifyListeners("stream", event);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("requestId", "");
        String mode = call.getString("mode", "normal");
        int after = call.getInt("after", 0);
        if (!id.matches("[a-zA-Z0-9_-]{1,80}") || after < 0 || after > 3 ||
            !Set.of("normal", "stall", "drop", "http-error").contains(mode)) {
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
        worker.execute(() -> run(job, mode, after));
    }

    private void run(Job job, String mode, int after) {
        String terminal = "error";
        String detail = "UNEXPECTED_EOF";
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(
                "http://10.0.2.2:18510/stream?mode=" + mode + "&requestId=" + job.id
            ).openConnection();
            job.connection = connection;
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("Last-Event-ID", Integer.toString(after));
            if (job.cancelled) return;
            if (connection.getResponseCode() != 200) throw new IOException("HTTP_STATUS");
            if (!"text/event-stream".equals(connection.getContentType())) throw new IOException("CONTENT_TYPE");
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                connection.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder data = new StringBuilder();
                String eventId = "";
                int total = 0;
                String line;
                // 此解析器只验收受控SSE样例；不是通用供应商协议适配器。
                while (!job.cancelled && (line = reader.readLine()) != null) {
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
                            if (!job.cancelled) emit(job, "chunk", payload, eventId);
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
            detail = "TIMEOUT";
        } catch (IOException error) {
            detail = "HTTP_STATUS".equals(error.getMessage()) ? "HTTP_STATUS" : "NETWORK_OR_PROTOCOL";
        } finally {
            if (job.connection != null) job.connection.disconnect();
            active.compareAndSet(job, null);
            // 仅工作线程退出且连接已关闭后发终态，每个请求只发一个终态。
            emit(job, job.cancelled ? "cancelled" : terminal, job.cancelled ? "" : detail, "");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Job job = active.get();
        if (job == null || !job.id.equals(call.getString("requestId", ""))) {
            call.reject("No matching active stream", "NO_ACTIVE_STREAM");
            return;
        }
        job.cancelled = true;
        // disconnect不能阻塞桥线程，否则离线本地写入也会被网络拖住。
        closer.execute(() -> { if (job.connection != null) job.connection.disconnect(); });
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        Job job = active.get();
        if (job != null) {
            job.cancelled = true;
            closer.execute(() -> { if (job.connection != null) job.connection.disconnect(); });
        }
        worker.shutdown();
        closer.shutdown();
        super.handleOnDestroy();
    }
}
