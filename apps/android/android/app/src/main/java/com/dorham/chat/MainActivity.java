package com.dorham.chat;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(DorhamMediaPlugin.class);
        registerPlugin(DorhamSecretsPlugin.class);
        super.onCreate(state);
    }
}
