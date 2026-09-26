package mg.appmada.baindefrancais;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final int REQ_AUDIO = 7001;
    private WebView webView;
    private PermissionRequest pendingAudioRequest;
    private boolean appLoaded = false;
    private final NativeMicBridge nativeMic = new NativeMicBridge();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " APP-MADA-BainFrancais/2.2.1");

        // Native bridge: the microphone no longer depends on WebView getUserMedia().
        webView.addJavascriptInterface(nativeMic, "AndroidMic");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectMicFix();
            }
        });

        // Keep WebView permission support as a fallback for older code, but the main
        // push-to-talk path uses AndroidMic directly.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            wantsAudio = true;
                            break;
                        }
                    }
                    if (!wantsAudio) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingAudioRequest = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingAudioRequest == request) pendingAudioRequest = null;
            }
        });

        // The microphone is the main feature, so request Android permission once at startup.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            loadApp();
        } else {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        }
    }

    private void loadApp() {
        if (appLoaded || webView == null) return;
        appLoaded = true;
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private void injectMicFix() {
        if (webView == null) return;
        String js = readAsset("micfix.js");
        if (!js.isEmpty()) webView.evaluateJavascript(js, null);
    }

    private String jsonError(String code, String detail) {
        try {
            JSONObject j = new JSONObject();
            j.put("ok", false);
            j.put("error", code);
            if (detail != null) j.put("detail", detail);
            return j.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"unknown\"}";
        }
    }

    public class NativeMicBridge {
        private MediaRecorder recorder;
        private File audioFile;
        private long startedAtMs;

        @JavascriptInterface
        public synchronized boolean hasPermission() {
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public synchronized String start() {
            if (!hasPermission()) return jsonError("permission_denied", null);
            releaseRecorder();
            try {
                audioFile = File.createTempFile("bain_voice_", ".m4a", getCacheDir());
                recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        ? new MediaRecorder(MainActivity.this)
                        : new MediaRecorder();
                recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
                recorder.setAudioChannels(1);
                recorder.setAudioSamplingRate(44100);
                recorder.setAudioEncodingBitRate(64000);
                recorder.setOutputFile(audioFile.getAbsolutePath());
                recorder.prepare();
                recorder.start();
                startedAtMs = SystemClock.elapsedRealtime();
                JSONObject j = new JSONObject();
                j.put("ok", true);
                return j.toString();
            } catch (Exception e) {
                releaseRecorder();
                deleteAudioFile();
                return jsonError("native_mic_start_failed", e.getClass().getSimpleName());
            }
        }

        @JavascriptInterface
        public synchronized int amplitude() {
            if (recorder == null) return 0;
            try {
                return recorder.getMaxAmplitude();
            } catch (Exception e) {
                return 0;
            }
        }

        @JavascriptInterface
        public synchronized String stop() {
            if (recorder == null || audioFile == null) return jsonError("not_recording", null);
            long durationMs = Math.max(0, SystemClock.elapsedRealtime() - startedAtMs);
            try {
                recorder.stop();
            } catch (RuntimeException e) {
                releaseRecorder();
                deleteAudioFile();
                return jsonError("recording_too_short", null);
            }
            releaseRecorder();
            try (FileInputStream in = new FileInputStream(audioFile); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                byte[] bytes = out.toByteArray();
                JSONObject j = new JSONObject();
                j.put("ok", true);
                j.put("audioBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                j.put("mimeType", "audio/mp4");
                j.put("durationMs", durationMs);
                j.put("size", bytes.length);
                deleteAudioFile();
                return j.toString();
            } catch (Exception e) {
                deleteAudioFile();
                return jsonError("audio_read_failed", e.getClass().getSimpleName());
            }
        }

        @JavascriptInterface
        public synchronized void cancel() {
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
            }
            releaseRecorder();
            deleteAudioFile();
        }

        private void releaseRecorder() {
            if (recorder != null) {
                try { recorder.reset(); } catch (Exception ignored) {}
                try { recorder.release(); } catch (Exception ignored) {}
                recorder = null;
            }
        }

        private void deleteAudioFile() {
            if (audioFile != null) {
                try { if (audioFile.exists()) audioFile.delete(); } catch (Exception ignored) {}
                audioFile = null;
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_AUDIO) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingAudioRequest != null) {
                if (granted) pendingAudioRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                else pendingAudioRequest.deny();
                pendingAudioRequest = null;
            }
            loadApp();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        nativeMic.cancel();
        if (webView != null) {
            webView.stopLoading();
            webView.removeJavascriptInterface("AndroidMic");
            webView.destroy();
        }
        super.onDestroy();
    }
}
