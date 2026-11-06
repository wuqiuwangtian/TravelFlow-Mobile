package org.travelflow.p0;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ProbeStorePlugin.class);
        registerPlugin(ProbeStreamPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
