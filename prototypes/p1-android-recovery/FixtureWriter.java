package org.travelflow.p1recovery;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Private second process. The test controller can stop a writer just before commit. */
public final class FixtureWriter extends ContentProvider {
    private static final int TIMEOUT_SECONDS = 30;
    private CountDownLatch release;
    private FutureTask<String> writing;

    @Override public boolean onCreate() { return true; }

    @Override public synchronized Bundle call(String method, String scenario, Bundle input) {
        if (!"lock-commit".equals(scenario) && !"lock-rollback".equals(scenario))
            throw new IllegalArgumentException("unknown writer scenario");
        Bundle result = new Bundle();
        result.putInt("writer_pid", Process.myPid());
        try {
            if ("release".equals(method)) {
                release.countDown();
                writing.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
                writing = null;
                return result; // Harness barrier only. No receipt delivered to the caller.
            }
            if (writing != null) throw new IllegalStateException("writer already running");
            String raw = input.getString("request");
            File dir = new File(getContext().getFilesDir(), scenario);
            if ("submit".equals(method)) {
                result.putString("outcome", write(dir, raw, null, null, true));
            } else if ("hold".equals(method)) {
                CountDownLatch held = new CountDownLatch(1);
                release = new CountDownLatch(1);
                writing = new FutureTask<>(() -> write(dir, raw, held, release, "lock-commit".equals(scenario)));
                new Thread(writing, "fixture-sqlite-writer").start();
                if (!held.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) throw new IllegalStateException("writer never reached outbox");
            } else throw new IllegalArgumentException("unknown writer method");
            return result;
        } catch (Exception error) { throw new IllegalStateException("fixture writer failed", error); }
    }

    private static String write(File dir, String raw, CountDownLatch held, CountDownLatch release, boolean commit) throws Exception {
        JSONObject edit = new JSONObject(raw);
        String id = edit.getString("operation_id");
        int base = edit.getInt("expected_revision"), cents = edit.getInt("amount_cents");
        if (!"fixture-expense".equals(edit.getString("target")) || base != 0 || cents < 701 || cents > 799)
            throw new IllegalArgumentException("unexpected fixture edit");
        try (SQLiteDatabase db = RecoveryFixture.openStore(dir, false)) {
            db.setForeignKeyConstraintsEnabled(true);
            db.beginTransactionNonExclusive();
            try {
                try (Cursor row = db.rawQuery("SELECT intent,rev FROM receipt WHERE op=?", new String[]{id})) {
                    if (row.moveToFirst()) {
                        if (!raw.equals(row.getString(0))) throw new IllegalStateException("intent_conflict");
                        return "replayed-" + row.getInt(1);
                    }
                }
                if (DatabaseUtils.longForQuery(db, "SELECT head FROM expense WHERE id=1", null) != base)
                    throw new IllegalStateException("stale fixture head");
                RecoveryFixture.writeRows(db, base + 1, cents, null, id, raw, phase -> {});
                if (held != null) {
                    held.countDown();
                    if (!release.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) throw new IllegalStateException("barrier expired");
                }
                if (commit) db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
        return commit ? "committed-1" : "rolled_back";
    }

    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri u) { throw new UnsupportedOperationException(); }
    @Override public Uri insert(Uri u, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri u, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
