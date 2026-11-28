package org.travelflow.p1bridge;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Proxy;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

@CapacitorPlugin(name = "DesktopPairing")
public class DesktopPairingPlugin extends Plugin {
    private static final String ALIAS = "travelflow.isolated.desktop.v1";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean inForeground = true;
    private JSONObject pending;
    private JSONObject lastPatchQuery;
    private final SecureRandom random = new SecureRandom();

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) result.append(String.format(Locale.ROOT, "%02x", b));
        return result.toString();
    }

    private static class PinMismatch extends CertificateException {}
    private static class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }

    private static JSONObject request(JSONObject peer, String route, JSONObject body, boolean authenticated) throws Exception {
        return requestBytes(peer, route, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8), authenticated);
    }

    private static JSONObject requestBytes(JSONObject peer, String route, byte[] body, boolean authenticated) throws Exception {
        String pin = peer.getString("pin");
        X509TrustManager trust = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                throw new CertificateException("client certificates unsupported");
            }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                try {
                    if (chain == null || chain.length == 0 ||
                        !pin.equals(hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()))))
                        throw new PinMismatch();
                    chain[0].checkValidity();
                } catch (java.security.NoSuchAlgorithmException e) { throw new CertificateException(e); }
            }
        };
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[]{trust}, null);
        URL url = new URL("https", peer.getString("host"), peer.getInt("port"), route);
        HttpsURLConnection conn = (HttpsURLConnection) url.openConnection(Proxy.NO_PROXY);
        try {
            conn.setSSLSocketFactory(tls.getSocketFactory());
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setUseCaches(false);
            if (authenticated) {
                conn.setRequestProperty("Authorization", "Bearer " + peer.getString("token"));
                conn.setRequestProperty("X-Device-Id", peer.getString("device"));
            }
            if (body != null) {
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = conn.getOutputStream()) { out.write(body); }
            }
            int status = conn.getResponseCode();
            try (InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                if (stream == null) throw new Failure("invalid_response");
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buf = new byte[2048];
                int n;
                while ((n = stream.read(buf)) != -1) {
                    if (bytes.size() + n > 32768) throw new Failure("invalid_response");
                    bytes.write(buf, 0, n);
                }
                JSONObject reply = new JSONObject(bytes.toString("UTF-8"));
                if (status != 200 || !reply.getBoolean("ok")) {
                    String code = reply.optString("error");
                    throw new Failure("HTTP_" + status + "_" + (code.matches("[a-z_]{1,48}") ? code : "rejected"));
                }
                return reply;
            }
        } finally { conn.disconnect(); }
    }

    private AtomicFile file() {
        return new AtomicFile(new File(getContext().getNoBackupFilesDir(), "desktop-pairing.gcm"));
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (create && !store.containsAlias(ALIAS)) {
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            gen.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private File ledgerDir() { return OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir()); }

    private byte[] encrypt(JSONObject peer) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        byte[] ciphertext = cipher.doFinal(peer.toString().getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        return ByteBuffer.allocate(iv.length + ciphertext.length).put(iv).put(ciphertext).array();
    }

    private void save(JSONObject peer) throws Exception {
        byte[] data = encrypt(peer);
        if (peer.optBoolean("manager")) {
            OfflineTripLedgerStore.updateManagerCredential(ledgerDir(), data);
            return;
        }
        AtomicFile f = file();
        FileOutputStream out = f.startWrite();
        try {
            out.write(data);
            f.finishWrite(out);
        } catch (IOException e) { f.failWrite(out); throw e; }
    }
    private JSONObject saved() throws Exception {
        byte[] data = OfflineTripLedgerStore.managerCredential(ledgerDir());
        if (data == null) {
            try { data = file().readFully(); }
            catch (java.io.FileNotFoundException e) { throw new Failure("not_paired"); }
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOf(data, 12)));
        return new JSONObject(new String(cipher.doFinal(data, 12, data.length - 12), StandardCharsets.UTF_8));
    }

    private interface Action { JSObject run() throws Exception; }
    private void execute(PluginCall call, Action action) {
        worker.execute(() -> {
            try { call.resolve(action.run()); }
            catch (Exception e) {
                String code = e instanceof Failure ? ((Failure)e).code : "pairing_failed";
                for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof PinMismatch) code = "pin_mismatch";
                call.reject(code, code);
            }
        });
    }
    private JSONObject material(PluginCall call, boolean manager) throws Exception {
        try {
            JSONObject info = OfflineTripLedgerStore.parsePairingDisplay(call.getString("display", ""));
            JSONObject session = info.getJSONObject("pairing_session");
            Object port = info.opt("lan_port");
            String pin = info.getString("cert_sha256");
            if (!"travelflow-lan-pairing/0-draft".equals(info.opt("protocol"))
                    || !android.util.Patterns.IP_ADDRESS.matcher(info.getString("lan_host")).matches()
                    || !(port instanceof Number) || ((Number)port).longValue() < 1 || ((Number)port).longValue() > 65535
                    || !pin.matches("[0-9a-f]{64}") || !pin.equals(session.opt("cert_sha256"))
                    || !(session.opt("pairing_session_id") instanceof String)
                    || !session.getString("pairing_session_id").matches("[0-9a-f]{32}")
                    || !(session.opt("pairing_code") instanceof String) || !session.getString("pairing_code").matches("[0-9]{6}"))
                throw new Failure("invalid_display");
            if (manager) {
                for (String key : new String[]{"pairing_session_id", "pairing_code", "expires_at"})
                    if (!(info.opt(key) instanceof String) || !info.getString(key).equals(session.opt(key)))
                        throw new Failure("invalid_display");
                java.time.OffsetDateTime.parse(info.getString("expires_at"));
                JSONObject trip = info.getJSONObject("trip");
                for (String key : new String[]{"dataset_id", "travel_id", "branch_id", "current_revision_id"})
                    if (OfflineTripLedgerStore.validCreateIdentifier(trip.opt(key)) == null || trip.getString(key).trim().isEmpty())
                        throw new Failure("invalid_display");
                if (!(trip.opt("title") instanceof String) || trip.getString("title").trim().isEmpty()
                        || trip.getString("title").length() > 256 || trip.getString("title").matches("(?s).*\\p{Cc}.*"))
                    throw new Failure("invalid_display");
                if (trip.length() != 5 || session.length() != 4 || info.length() != 9) throw new Failure("invalid_display");
            }
            return info;
        } catch (Exception e) { throw new Failure("invalid_display"); }
    }

    private void checkManagerScope(JSONObject info) throws Exception {
        if (!OfflineTripLedgerStore.compatibleTrip(ledgerDir(), info.getJSONObject("trip")))
            throw new Failure("trip_scope_conflict");
        try {
            JSONObject old = saved();
            if (!info.getString("cert_sha256").equals(old.getString("pin"))) throw new Failure("pin_mismatch");
        } catch (Failure e) {
            if (!e.code.equals("not_paired")) throw e;
        }
    }

    private JSObject displayTrip(JSONObject info) throws Exception {
        JSObject result = new JSObject();
        result.put("trip", info.getJSONObject("trip"));
        result.put("sourceDeviceId", OfflineTripLedgerStore.businessSource(getContext()));
        return result;
    }

    @PluginMethod public void preview(PluginCall call) {
        execute(call, () -> {
            pending = null;
            JSONObject info = material(call, true);
            checkManagerScope(info);
            return displayTrip(info);
        });
    }

    @PluginMethod public void begin(PluginCall call) {
        execute(call, () -> {
            pending = null;
            boolean manager = call.getBoolean("runtime", false);
            JSONObject info = material(call, manager);
            if (manager) checkManagerScope(info);
            else if (OfflineTripLedgerStore.managerCredential(ledgerDir()) != null) throw new Failure("trip_scope_conflict");
            JSONObject session = info.getJSONObject("pairing_session");
            String host = info.getString("lan_host"), pin = info.getString("cert_sha256");
            String sid = session.getString("pairing_session_id"), code = session.getString("pairing_code");
            int port = info.getInt("lan_port");
            JSONObject peer = new JSONObject().put("host", host).put("port", port).put("pin", pin);
            String device = UUID.randomUUID().toString();
            // A new manager request must not rotate a working credential before the new local binding commits.
            if (!manager && file().getBaseFile().exists()) {
                JSONObject old = saved();
                if (pin.equals(old.getString("pin"))) device = old.getString("device");
            }
            peer.put("device", device);
            byte[] nonceBytes = new byte[16];
            random.nextBytes(nonceBytes);
            String nonce = hex(nonceBytes);
            JSONObject reply = request(peer, "/pair/request", new JSONObject().put("pairing_session_id", sid)
                    .put("pairing_code", code).put("device_id", device).put("device_name", android.os.Build.MODEL)
                    .put("client_nonce", nonce), false);
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(code.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(String.join("|", pin, sid, device, nonce, reply.getString("server_nonce")).getBytes(StandardCharsets.UTF_8));
            String sas = String.format(Locale.ROOT, "%06d", Integer.toUnsignedLong(ByteBuffer.wrap(digest).getInt()) % 1000000);
            if (!sas.equals(reply.getString("sas_code"))) throw new Failure("sas_mismatch");
            pending = new JSONObject().put("peer", peer).put("complete", new JSONObject()
                    .put("request_id", reply.getString("request_id")).put("client_nonce", nonce)
                    .put("device_id", device).put("sas_code", sas));
            JSObject result = new JSObject();
            if (manager) {
                pending.put("material", info);
                result = displayTrip(info);
            }
            result.put("sas", sas);
            return result;
        });
    }
    @PluginMethod public void confirm(PluginCall call) {
        execute(call, () -> {
            if (pending == null) throw new Failure("no_pending_request");
            JSONObject peer = pending.getJSONObject("peer");
            JSONObject info = pending.optJSONObject("material");
            if (info != null) checkManagerScope(info);
            // Token delivery is one-shot. Retry a failed verification or local commit with the
            // verified token held by this same pending session until binding succeeds.
            if (!peer.has("token")) {
                JSONObject reply = request(peer, "/pair/complete", pending.getJSONObject("complete"), false);
                if (!peer.getString("device").equals(reply.getString("device_id")) ||
                    !peer.getString("pin").equals(reply.getString("cert_sha256")) ||
                    !reply.getString("device_token").matches("[A-Za-z0-9_-]{43}")) throw new Failure("invalid_credential");
                peer.put("token", reply.getString("device_token"));
            }
            if (info == null) save(peer);
            else {
                JSONObject trip = info.getJSONObject("trip");
                JSONObject remote = request(peer, "/trip/fictional", null, true).getJSONObject("trip");
                // This endpoint identifies the fixture's travel and branch; its head is static. The
                // current baseline comes from the reviewed manager bundle, including on re-pair.
                if (!Boolean.TRUE.equals(remote.opt("fictional_only")) || !trip.getString("travel_id").equals(remote.opt("travel_id"))
                        || !trip.getString("branch_id").equals(remote.opt("main_branch_id"))
                        || !trip.getString("title").equals(remote.opt("title"))) throw new Failure("trip_scope_conflict");
                peer.put("manager", true);
                OfflineTripLedgerStore.bindManager(ledgerDir(), trip,
                        OfflineTripLedgerStore.businessSource(getContext()), encrypt(peer));
            }
            lastPatchQuery = null;
            pending = null;
            return new JSObject();
        });
    }
    @PluginMethod public void readTrip(PluginCall call) {
        execute(call, () -> {
            JSONObject trip = request(saved(), "/trip/fictional", null, true).getJSONObject("trip");
            if (!trip.getBoolean("fictional_only")) throw new Failure("invalid_trip");
            JSObject result = new JSObject();
            result.put("trip", trip);
            return result;
        });
    }
    private JSObject exchangeExpense(JSONObject peer, File dir, String op, boolean lookup) throws Exception {
        byte[] payload = OfflineTripLedgerStore.deliveryBytes(dir, op, lookup);
        if (payload == null) throw new Failure("wire_not_ready");
        JSONObject reply;
        try {
            reply = requestBytes(peer, lookup ? "/exchange/receipt-lookup" : "/exchange/expense-create", payload, true);
        } catch (javax.net.ssl.SSLException e) {
            throw e;
        } catch (IOException e) {
            throw new Failure("delivery_unconfirmed");
        }
        if (lookup && "unknown".equals(reply.optString("state")) && "storage_busy".equals(reply.optString("reason")))
            throw new Failure("storage_busy");
        if (lookup && "not_found_at_settled_read".equals(reply.optString("state"))
                && reply.has("receipt") && reply.isNull("receipt")) {
            throw new Failure("receipt_not_found");
        }
        if (!OfflineTripLedgerStore.confirmDelivery(dir, op, reply).getBoolean("accepted"))
            throw new Failure("receipt_mismatch");
        JSObject result = new JSObject();
        result.put("revision", reply.getJSONObject("receipt").getString("result_revision_id"));
        result.put("replayed", reply.optBoolean("replayed", false));
        return result;
    }

    @PluginMethod public void exchangeExpense(PluginCall call) {
        execute(call, () -> exchangeExpense(saved(), OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir()),
                call.getString("operationId", ""), call.getBoolean("lookup", false)));
    }

    @PluginMethod public void pullPatch(PluginCall call) {
        execute(call, () -> pullPatch(saved()));
    }

    private JSObject pullPatch(JSONObject peer) throws Exception {
        org.json.JSONArray items = request(peer, "/exchange/expense-patch/pull", new JSONObject(), true)
                .getJSONArray("items");
        JSObject result = new JSObject();
        result.put("available", items.length() > 0);
        lastPatchQuery = null;
        if (items.length() == 0) return result;
        // Process the oldest command first; the desktop retains it until explicit confirmation.
        JSONObject item = items.getJSONObject(0);
        String raw = item.getString("raw_command_json");
        File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
        JSObject applied = OfflineTripLedgerStore.receiveDesktopCommand(dir, raw, item);
        if (!applied.getBoolean("ok")) throw new Failure(applied.getString("error"));
        JSONObject receipt = applied.getJSONObject("receipt");
        lastPatchQuery = new JSONObject().put("profile", "p1-host-query-1").put("kind", "receipt.lookup")
                .put("operation", receipt.getJSONObject("operation"));
        result.put("replayed", applied.getBoolean("replayed"));
        result.put("revision", receipt.getString("result_revision_id"));
        result.put("rawSha256", BridgeCreateLedgerStore.sha256Hex(raw));
        return result;
    }

    @PluginMethod public void confirmPatch(PluginCall call) {
        execute(call, () -> confirmPatch(saved()));
    }

    private JSObject confirmPatch(JSONObject peer) throws Exception {
        if (lastPatchQuery == null) throw new Failure("pull_required");
        File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
        JSONObject lookup = OfflineTripLedgerStore.receiveDesktopCommand(dir, lastPatchQuery.toString());
        JSONObject receipt = lookup.optJSONObject("receipt");
        if (receipt == null) throw new Failure("receipt_not_found");
        JSONObject reply = request(peer, "/exchange/expense-patch/confirm", lookup, true);
        if (!reply.getBoolean("confirmed") || !receipt.getString("result_revision_id")
                .equals(reply.getJSONObject("record").getString("confirmed_mobile_revision_id")))
            throw new Failure("receipt_mismatch");
        JSObject result = new JSObject();
        result.put("alreadyConfirmed", reply.getBoolean("already_confirmed"));
        return result;
    }

    @Override protected void handleOnPause() {
        inForeground = false;
        super.handleOnPause();
    }

    @Override protected void handleOnResume() {
        super.handleOnResume();
        inForeground = true;
    }

    private static JSObject syncResult(String state, String reason, boolean changed) {
        JSObject result = new JSObject();
        result.put("state", state);
        result.put("changed", changed);
        if (reason != null) result.put("reason", reason);
        return result;
    }

    @PluginMethod public void syncForeground(PluginCall call) {
        execute(call, () -> {
            if (!inForeground) return syncResult("idle", null, false);
            JSONObject peer;
            try { peer = saved(); }
            catch (Failure e) {
                if (e.code.equals("not_paired")) return syncResult("unpaired", null, false);
                throw e;
            }
            if (peer.has("syncStop")) return syncResult("blocked", peer.getString("syncStop"), false);
            File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
            if (!new File(dir, "store.db").isFile()) return syncResult("idle", null, false);
            boolean changed = false;
            try {
                String op = OfflineTripLedgerStore.firstPendingOperation(dir);
                if (op != null) {
                    // A pending row might already be committed remotely, including after a crash or manual send.
                    try {
                        exchangeExpense(peer, dir, op, true);
                    } catch (Failure e) {
                        if (!e.code.equals("receipt_not_found")) throw e;
                        if (!inForeground) return syncResult("idle", null, false);
                        exchangeExpense(peer, dir, op, false);
                    }
                    changed = true;
                }
                if (inForeground && pullPatch(peer).getBoolean("available")) {
                    changed = true;
                    if (inForeground) confirmPatch(peer);
                }
                if (inForeground && !peer.optBoolean("exchangeGranted")) save(peer.put("exchangeGranted", true));
                return syncResult(changed ? "synced" : "idle", null, changed);
            } catch (Exception e) {
                String code = syncError(e);
                if ("HTTP_403_exchange_not_authorized".equals(code) && !peer.optBoolean("exchangeGranted"))
                    return syncResult("unpaired", code, changed);
                if ("delivery_unconfirmed".equals(code) || "storage_busy".equals(code)
                        || "HTTP_400_storage_busy".equals(code) || code.startsWith("HTTP_5"))
                    return syncResult("retry", code, changed);
                // Persist the halt with this credential before notifying the page. Re-pairing creates a fresh grant.
                save(peer.put("syncStop", code));
                return syncResult("blocked", code, changed);
            }
        });
    }

    private static String syncError(Exception e) {
        if (e instanceof Failure) return ((Failure)e).code;
        for (Throwable cause = e; cause != null; cause = cause.getCause()) {
            if (cause instanceof PinMismatch) return "pin_mismatch";
            if (cause instanceof CertificateException) return "invalid_certificate";
        }
        if (e instanceof IOException) return "delivery_unconfirmed";
        if (e instanceof android.database.sqlite.SQLiteDatabaseLockedException) return "storage_busy";
        if (e instanceof org.json.JSONException) return "invalid_response";
        return "local_sync_failed";
    }

    @Override protected void handleOnDestroy() {
        worker.shutdownNow();
        super.handleOnDestroy();
    }
}
