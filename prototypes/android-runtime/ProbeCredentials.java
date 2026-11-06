package org.travelflow.p0;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AndroidKeyStore能力实验。仅接收写死的公开虚构值，不是正式凭据管理API。 */
final class ProbeCredentials {
    private static final String ALIAS = "travelflow_p0_synthetic_v1";
    private static final String PREFS = "p0-synthetic-credential";

    private static KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    static void prepare(Context context) throws Exception {
        KeyStore store = keyStore();
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, (SecretKey) store.getKey(ALIAS, null));
        byte[] encrypted = cipher.doFinal("fixture-stream-token".getBytes(StandardCharsets.UTF_8));
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) {
            throw new IllegalStateException("Fixture persistence failed");
        }
    }

    static String read(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String iv = prefs.getString("iv", null);
        String ciphertext = prefs.getString("ciphertext", null);
        if (iv == null || ciphertext == null) throw new IllegalStateException("No synthetic credential");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, (SecretKey) keyStore().getKey(ALIAS, null),
            new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    static void clear(Context context) throws Exception {
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()) {
            throw new IllegalStateException("Fixture removal failed");
        }
        keyStore().deleteEntry(ALIAS);
    }
}
