package com.dorham.chat;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import androidx.activity.OnBackPressedCallback;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(DorhamNotificationsPlugin.class);
        registerPlugin(DorhamMediaPlugin.class);
        registerPlugin(DorhamSecretsPlugin.class);
        registerPlugin(DorhamFilesPlugin.class);
        registerPlugin(DorhamUpdatesPlugin.class);
        registerPlugin(DorhamClipboardPlugin.class);
        super.onCreate(state);
        captureLink(getIntent());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript("(()=>{const d=document.querySelector('dialog[open]');if(d){d.dispatchEvent(new Event('cancel',{cancelable:true}));return true;}const e=new Event('dorham-back',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})()", result -> { if (!"true".equals(result)) moveTaskToBack(true); });
            }
        });
    }
    private boolean sameNotificationOrigin(android.net.Uri value) { String saved = getSharedPreferences("dorham.notifications", 0).getString("origin", ""); android.net.Uri expected = android.net.Uri.parse(saved); return value.getUserInfo() == null && value.getHost() != null && value.getHost().equals(expected.getHost()) && value.getPort() == expected.getPort(); }
    private void captureLink(android.content.Intent intent) { if (intent == null || intent.getData() == null) return; android.net.Uri uri = intent.getData(); if ("https".equals(uri.getScheme()) && ("dorhamapp.ir".equals(uri.getHost()) || sameNotificationOrigin(uri)) && "/".equals(uri.getPath())) { DorhamNotificationsPlugin.Companion.setPendingUrl(uri.toString()); if (getBridge() != null) getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('dorham-open-link'))", null); } }
    @Override protected void onNewIntent(android.content.Intent intent) { super.onNewIntent(intent); setIntent(intent); captureLink(intent); }
    @Override public void onWindowFocusChanged(boolean focused) { super.onWindowFocusChanged(focused); if (focused && getBridge() != null) getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('dorham-app-state'))", null); }
    @Override public void onPause() { DorhamNotificationService.Companion.setAppVisible(false); if (DorhamMediaPlugin.Companion.getActive() != null) DorhamMediaPlugin.Companion.getActive().visibility(false); super.onPause(); }
    @Override public void onResume() { super.onResume(); DorhamNotificationService.Companion.setAppVisible(true); DorhamNotificationService.Companion.resume(this); if (DorhamMediaPlugin.Companion.getActive() != null) DorhamMediaPlugin.Companion.getActive().visibility(true); if (getBridge() != null) getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('dorham-app-state'))", null); }
}
