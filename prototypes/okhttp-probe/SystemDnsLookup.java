package org.travelflow.p0;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Network;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.Process;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** 一次绑定只做一次系统解析；解除绑定并观察Binder死亡后才返回，不以Future冒充退出。 */
final class SystemDnsLookup {
    private static final AtomicInteger bindings = new AtomicInteger();
    private static volatile int workerPid;
    static int bindings() { return bindings.get(); }
    static int workerPid() { return workerPid; }
    private final Context context;
    private final Network network;
    private final long deadline;
    private final Runnable expired;
    private final boolean slowBind;
    private int observedPid;
    synchronized int observedPid() { return observedPid; }
    private IBinder remote;
    private boolean bound, connected, dead, failed, received, cancelled, released, deadlineReported, interrupted;
    private List<InetAddress> result;

    SystemDnsLookup(Context context, Network network, long deadline, Runnable expired, boolean slowBind) {
        this.context = context; this.network = network; this.deadline = deadline; this.expired = expired; this.slowBind = slowBind;
    }

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            synchronized (SystemDnsLookup.this) {
                // 已连接后的重连只用于收尾，不能把新服务当作旧请求的自动重试。
                if (connected) failed = true;
                remote = service; dead = false;
                try { service.linkToDeath(() -> {
                    synchronized (SystemDnsLookup.this) {
                        if (remote == service) { dead = true; SystemDnsLookup.this.notifyAll(); }
                    }
                }, 0); }
                catch (Exception failure) { dead = true; }
                connected = true;
                SystemDnsLookup.this.notifyAll();
            }
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            synchronized (SystemDnsLookup.this) { failed = true; SystemDnsLookup.this.notifyAll(); }
        }
        @Override public void onNullBinding(ComponentName name) {
            synchronized (SystemDnsLookup.this) { connected = true; failed = true; SystemDnsLookup.this.notifyAll(); }
        }
        @Override public void onBindingDied(ComponentName name) {
            synchronized (SystemDnsLookup.this) { connected = true; failed = true; SystemDnsLookup.this.notifyAll(); }
        }
    };

    synchronized void cancel() { cancelled = true; notifyAll(); }

    private void waitForChange() throws UnknownHostException {
        long left = deadline - System.nanoTime();
        if (left <= 0 && !deadlineReported) {
            deadlineReported = true;
            expired.run();
            cancelled = true;
        }
        // 取消在绑定完成前也必须等到可解绑的连接／失败，不能提前宣布没有辅助工作。
        try { wait(Math.max(1, Math.min(100, left / 1_000_000L))); }
        catch (InterruptedException failure) { interrupted = true; cancelled = true; }
    }

    List<InetAddress> lookup(String host) throws UnknownHostException {
        Binder callback = new Binder() {
            @Override protected boolean onTransact(int code, Parcel input, Parcel reply, int flags) {
                if (Binder.getCallingUid() != Process.myUid() || code < SystemDnsWorkerService.STARTED || code > SystemDnsWorkerService.FAILED) return false;
                input.enforceInterface(SystemDnsWorkerService.TOKEN);
                int pid = input.readInt();
                synchronized (SystemDnsLookup.this) {
                    if (released || cancelled || dead) return true;
                    if (pid <= 0 || pid == Process.myPid()) { failed = true; }
                    else {
                        workerPid = pid; observedPid = pid;
                        if (code == SystemDnsWorkerService.ANSWER) {
                            int count = input.readInt();
                            if (count < 1 || count > 64) failed = true;
                            else {
                                List<InetAddress> addresses = new ArrayList<>();
                                try {
                                    for (int i = 0; i < count; i++) {
                                        byte[] bytes = input.createByteArray(); int scope = input.readInt();
                                        if (bytes == null || (bytes.length != 4 && bytes.length != 16)) throw new UnknownHostException();
                                        addresses.add(bytes.length == 16 ? Inet6Address.getByAddress(null, bytes, scope) : InetAddress.getByAddress(bytes));
                                    }
                                    result = addresses; received = true;
                                } catch (Exception failure) { failed = true; }
                            }
                        } else if (code == SystemDnsWorkerService.FAILED) failed = true;
                    }
                    SystemDnsLookup.this.notifyAll();
                }
                return true;
            }
        };
        try {
            synchronized (this) {
                if (cancelled) throw new UnknownHostException("DNS worker cancelled");
                bound = context.bindService(new Intent(context, SystemDnsWorkerService.class).putExtra("slowBind", slowBind), connection, Context.BIND_AUTO_CREATE);
                if (!bound) throw new UnknownHostException("DNS worker bind failed");
                bindings.incrementAndGet();
                while (!connected) waitForChange();
                if (cancelled || failed || dead) throw new UnknownHostException("DNS worker unavailable");
                Parcel request = Parcel.obtain();
                try {
                    request.writeInterfaceToken(SystemDnsWorkerService.TOKEN);
                    request.writeParcelable(network, 0); request.writeString(host); request.writeStrongBinder(callback);
                    if (!remote.transact(SystemDnsWorkerService.LOOKUP, request, null, IBinder.FLAG_ONEWAY)) throw new UnknownHostException("DNS worker request failed");
                } catch (android.os.RemoteException failure) { throw new UnknownHostException("DNS worker exited"); }
                finally { request.recycle(); }
                while (!received && !failed && !dead && !cancelled) waitForChange();
                if (cancelled || failed || dead || System.nanoTime() >= deadline) throw new UnknownHostException("DNS worker lookup failed");
            }
        } finally {
            boolean unbind;
            synchronized (this) { released = true; unbind = bound; }
            if (unbind) {
                context.unbindService(connection);
                synchronized (this) {
                    // onUnbind结束私有进程；死亡通知是实际退出证据，不能提前减计数。
                    while (remote != null && !dead) waitForChange();
                    bindings.decrementAndGet(); workerPid = 0;
                }
            }
            synchronized (this) { expiredIfNeeded(); if (interrupted) Thread.currentThread().interrupt(); }
        }
        synchronized (this) {
            if (cancelled || deadline - System.nanoTime() <= 0) { expiredIfNeeded(); throw new UnknownHostException("DNS worker stopped"); }
            return result;
        }
    }

    private void expiredIfNeeded() {
        if (deadline - System.nanoTime() <= 0 && !deadlineReported) { deadlineReported = true; expired.run(); }
    }
}
