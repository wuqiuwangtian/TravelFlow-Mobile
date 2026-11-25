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
    private JSONObject pending;
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
    private void save(JSONObject peer) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        byte[] ciphertext = cipher.doFinal(peer.toString().getBytes(StandardCharsets.UTF_8));
        AtomicFile f = file();
        FileOutputStream out = f.startWrite();
        try {
            out.write(cipher.getIV());
            out.write(ciphertext);
            f.finishWrite(out);
        } catch (IOException e) { f.failWrite(out); throw e; }
    }
    private JSONObject saved() throws Exception {
        AtomicFile f = file();
        if (!f.getBaseFile().exists()) throw new Failure("not_paired");
        byte[] data = f.readFully();
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
    @PluginMethod public void begin(PluginCall call) {
        execute(call, () -> {
            pending = null;
            JSONObject info = new JSONObject(call.getString("display", ""));
            JSONObject session = info.getJSONObject("pairing_session");
            String host = info.getString("lan_host"), pin = info.getString("cert_sha256");
            String sid = session.getString("pairing_session_id"), code = session.getString("pairing_code");
            int port = info.getInt("lan_port");
            if (!"travelflow-lan-pairing/0-draft".equals(info.optString("protocol")) ||
                !android.util.Patterns.IP_ADDRESS.matcher(host).matches() || port < 1 || port > 65535 ||
                !pin.matches("[0-9a-f]{64}") || !pin.equals(session.getString("cert_sha256")) ||
                !sid.matches("[0-9a-f]{32}") || !code.matches("[0-9]{6}")) throw new Failure("invalid_display");
            JSONObject peer = new JSONObject().put("host", host).put("port", port).put("pin", pin);
            String device = UUID.randomUUID().toString();
            if (file().getBaseFile().exists()) {
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
            JSObject result = new JSObject(); result.put("sas", sas); return result;
        });
    }
    @PluginMethod public void confirm(PluginCall call) {
        execute(call, () -> {
            if (pending == null) throw new Failure("no_pending_request");
            JSONObject peer = pending.getJSONObject("peer");
            JSONObject reply = request(peer, "/pair/complete", pending.getJSONObject("complete"), false);
            if (!peer.getString("device").equals(reply.getString("device_id")) ||
                !peer.getString("pin").equals(reply.getString("cert_sha256")) ||
                !reply.getString("device_token").matches("[A-Za-z0-9_-]{43}")) throw new Failure("invalid_credential");
            save(peer.put("token", reply.getString("device_token")));
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
    @PluginMethod public void exchangeExpense(PluginCall call) {
        execute(call, () -> {
            File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
            String op = call.getString("operationId", "");
            boolean lookup = call.getBoolean("lookup", false);
            byte[] payload = OfflineTripLedgerStore.deliveryBytes(dir, op, lookup);
            JSONObject peer = saved();
            JSONObject reply;
            try {
                reply = requestBytes(peer, lookup ? "/exchange/receipt-lookup" : "/exchange/expense-create", payload, true);
            } catch (javax.net.ssl.SSLException e) {
                throw e;
            } catch (IOException e) {
                throw new Failure("delivery_unconfirmed");
            }
            if (lookup && "not_found_at_settled_read".equals(reply.optString("state"))) {
                throw new Failure("receipt_not_found");
            }
            if (!OfflineTripLedgerStore.confirmDelivery(dir, op, reply).getBoolean("accepted"))
                throw new Failure("receipt_mismatch");
            JSObject result = new JSObject();
            result.put("revision", reply.getJSONObject("receipt").getString("result_revision_id"));
            result.put("replayed", reply.optBoolean("replayed", false));
            return result;
        });
    }

    @Override protected void handleOnDestroy() {
        worker.shutdownNow();
        super.handleOnDestroy();
    }
}
