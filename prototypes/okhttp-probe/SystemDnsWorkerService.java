package org.travelflow.p0;

import android.app.Service;
import android.content.Intent;
import android.net.Network;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.Process;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.concurrent.atomic.AtomicBoolean;

/** 仅可选debug：同UID私有进程，只处理固定虚构DNS，不初始化业务或凭据。 */
public final class SystemDnsWorkerService extends Service {
    static final String TOKEN = "org.travelflow.p0.SystemDnsWorker";
    static final int LOOKUP = IBinder.FIRST_CALL_TRANSACTION;
    static final int STARTED = IBinder.FIRST_CALL_TRANSACTION;
    static final int ANSWER = STARTED + 1;
    static final int FAILED = STARTED + 2;
    private final AtomicBoolean used = new AtomicBoolean();

    private final Binder binder = new Binder() {
        @Override protected boolean onTransact(int code, Parcel input, Parcel reply, int flags) {
            if (code != LOOKUP || Binder.getCallingUid() != Process.myUid()) return false;
            input.enforceInterface(TOKEN);
            Network network = input.readParcelable(Network.class.getClassLoader());
            String host = input.readString();
            IBinder callback = input.readStrongBinder();
            if (network == null || callback == null || host == null ||
                !(host.equals("valid.p0-dns.invalid") || host.matches("tf[0-9a-f]{32}\\.p0-dns\\.invalid")) ||
                !used.compareAndSet(false, true)) return false;
            new Thread(() -> {
                send(callback, STARTED, null);
                try { send(callback, ANSWER, network.getAllByName(host)); }
                catch (Exception failure) { send(callback, FAILED, null); }
            }, "p0-system-dns").start();
            return true;
        }
    };

    private void send(IBinder callback, int code, InetAddress[] addresses) {
        Parcel output = Parcel.obtain();
        try {
            output.writeInterfaceToken(TOKEN);
            output.writeInt(Process.myPid());
            if (code == ANSWER) {
                if (addresses.length > 64) { send(callback, FAILED, null); return; }
                output.writeInt(addresses.length);
                for (InetAddress address : addresses) {
                    output.writeByteArray(address.getAddress());
                    output.writeInt(address instanceof Inet6Address ? ((Inet6Address) address).getScopeId() : 0);
                }
            }
            callback.transact(code, output, null, IBinder.FLAG_ONEWAY);
        } catch (Exception ignored) { /* 调用方已离开时不输出名称或异常文本。 */ }
        finally { output.recycle(); }
    }

    @Override public IBinder onBind(Intent intent) {
        // 固定400ms仅用于绑定期间取消的闭合负例，不接受任意时长。
        if (intent.getBooleanExtra("slowBind", false)) android.os.SystemClock.sleep(400);
        return binder;
    }

    // 先由调用方解除绑定，再结束自身，避免BIND_AUTO_CREATE维持旧请求。
    @Override public boolean onUnbind(Intent intent) { Process.killProcess(Process.myPid()); return false; }
    @Override public void onDestroy() { super.onDestroy(); Process.killProcess(Process.myPid()); }
}
