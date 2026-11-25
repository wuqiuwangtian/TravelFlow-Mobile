package org.travelflow.p1bridge;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(P1BridgeReceiptPlugin.class);
        registerPlugin(DesktopPairingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
