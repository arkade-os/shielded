package io.arkade.shielded;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

public final class DataProbe extends Activity {
    private static final String TAG = "ShieldedUpdateProbe";
    private static final String ALIAS = "shielded-update-ci-only";
    private WebView browser;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String nonce = getIntent().getStringExtra("nonce");
        String phase = getIntent().getStringExtra("phase");
        try {
            require(nonce != null && nonce.matches("[a-f0-9]{32}"), "Invalid fixture nonce");
            boolean writing = "write".equals(phase);
            require(writing || "verify".equals(phase), "Invalid fixture phase");
            require(getPackageManager().getPackageInfo(getPackageName(), 0).versionCode == (writing ? 100001 : 100002), "Unexpected installed version");
            if (writing) writeData(nonce);
            verifyData(nonce);
            browser = new WebView(this);
            browser.getSettings().setJavaScriptEnabled(true);
            browser.getSettings().setDomStorageEnabled(true);
            browser.getSettings().setBlockNetworkLoads(true);
            browser.getSettings().setAllowFileAccess(false);
            browser.getSettings().setAllowContentAccess(false);
            setContentView(browser);
            browser.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    String expression = (writing ? "localStorage.setItem('shielded-ci-marker'," + JSONObject.quote(nonce) + ");" : "") + "localStorage.getItem('shielded-ci-marker')";
                    view.evaluateJavascript(expression, value -> {
                        if (!JSONObject.quote(nonce).equals(value)) { fail(nonce, "WebView origin storage changed"); return; }
                        view.postDelayed(() -> Log.i(TAG, (writing ? "WRITE_OK:" : "VERIFY_OK:") + nonce), writing ? 6000 : 0);
                    });
                }
            });
            browser.loadDataWithBaseURL("http://tauri.localhost/", "<!doctype html><title>Disposable update data probe</title>", "text/html", "UTF-8", null);
        } catch (Exception error) { fail(nonce, error.getClass().getSimpleName() + ":" + error.getMessage()); }
    }

    private SharedPreferences preferences() { return getSharedPreferences("shielded-update-ci", MODE_PRIVATE); }

    private void writeData(String nonce) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, generator.generateKey());
        byte[] ciphertext = cipher.doFinal(nonce.getBytes(StandardCharsets.UTF_8));
        require(preferences().edit().putString("marker", nonce).putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP)).commit(), "Preferences were not saved");
        try (FileOutputStream journal = new FileOutputStream(new File(getFilesDir(), "pending-swap-fixture.json"))) {
            journal.write(("{\"dummyPendingSwap\":\"" + nonce + "\"}").getBytes(StandardCharsets.UTF_8));
            journal.getFD().sync();
        }
    }

    private void verifyData(String nonce) throws Exception {
        require(nonce.equals(preferences().getString("marker", null)), "Preferences changed");
        byte[] expected = ("{\"dummyPendingSwap\":\"" + nonce + "\"}").getBytes(StandardCharsets.UTF_8);
        try (FileInputStream journal = new FileInputStream(new File(getFilesDir(), "pending-swap-fixture.json"))) {
            byte[] actual = new byte[expected.length];
            int size = 0, count;
            while (size < actual.length && (count = journal.read(actual, size, actual.length - size)) > 0) size += count;
            require(size == expected.length && journal.read() == -1 && Arrays.equals(expected, actual), "Pending journal changed");
        }
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        require(keys.containsAlias(ALIAS), "Android Keystore key is missing");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, (SecretKey) keys.getKey(ALIAS, null), new GCMParameterSpec(128, Base64.decode(preferences().getString("iv", ""), Base64.NO_WRAP)));
        byte[] plaintext = cipher.doFinal(Base64.decode(preferences().getString("ciphertext", ""), Base64.NO_WRAP));
        require(nonce.equals(new String(plaintext, StandardCharsets.UTF_8)), "Encrypted vault fixture changed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private static void fail(String nonce, String message) { Log.e(TAG, "FAILED:" + nonce + ":" + message); }
}
