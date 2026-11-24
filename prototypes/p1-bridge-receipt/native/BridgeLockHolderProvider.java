package org.travelflow.p1bridge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * Non-exported second Android process (:writer) that holds a real SQLite write lock
 * before commit so the Capacitor WebView main process can verify pending_busy receipt lookups.
 */
public final class BridgeLockHolderProvider extends ContentProvider {
    static final Uri AUTHORITY_URI = Uri.parse("content://org.travelflow.p1bridge.writer");
    private static final int TIMEOUT_SECONDS = 30;

    private CountDownLatch releaseLatch;
    private FutureTask<String> writerTask;

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public synchronized Bundle call(String method, String scenario, Bundle input) {
        boolean patchScenario = "lock-busy-commit".equals(scenario)
                || "lock-busy-rollback".equals(scenario)
                || "bound-int32-over".equals(scenario);
        boolean createScenario = "create-pending-ec07".equals(scenario);
        if (!patchScenario && !createScenario) {
            throw new IllegalArgumentException("Unsupported lock-holder scenario: " + scenario);
        }
        Bundle result = new Bundle();
        result.putInt("writer_pid", Process.myPid());
        try {
            if ("release".equals(method)) {
                if (releaseLatch == null || writerTask == null) {
                    throw new IllegalStateException("No active writer lock to release");
                }
                releaseLatch.countDown();
                writerTask.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
                writerTask = null;
                releaseLatch = null;
                // Barrier only: never returns a receipt to the caller process.
                return result;
            }
            if ("hold_create".equals(method) && createScenario) {
                if (writerTask != null) {
                    throw new IllegalStateException("Writer lock already held");
                }
                final File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                final CountDownLatch heldLatch = new CountDownLatch(1);
                releaseLatch = new CountDownLatch(1);
                final CountDownLatch activeRelease = releaseLatch;
                writerTask = new FutureTask<>(() -> holdCreateWriteLock(dir, heldLatch, activeRelease));
                new Thread(writerTask, "p1-bridge-create-lock-holder").start();
                if (!heldLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Writer process did not acquire create SQLite write lock in time");
                }
                return result;
            }
            if ("hold".equals(method) && patchScenario) {
                if (writerTask != null) {
                    throw new IllegalStateException("Writer lock already held");
                }
                final String operationId = input.getString("operation_id");
                final String intentJson = input.getString("intent_json");
                final long amountCents = input.getLong("amount_cents", -1L);
                final int expectedRevision = input.getInt("expected_revision", -1);
                final boolean commitOnRelease = input.getBoolean("commit_on_release", false);
                if (operationId == null || intentJson == null
                        || !BridgeLedgerStore.isValidAmountCents(amountCents) || expectedRevision < 0) {
                    throw new IllegalArgumentException("Invalid hold parameters");
                }
                final File dir = BridgeLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                final CountDownLatch heldLatch = new CountDownLatch(1);
                releaseLatch = new CountDownLatch(1);
                final CountDownLatch activeRelease = releaseLatch;
                writerTask = new FutureTask<>(() -> holdWriteTransaction(
                        dir, operationId, intentJson, amountCents, expectedRevision,
                        commitOnRelease, heldLatch, activeRelease));
                new Thread(writerTask, "p1-bridge-lock-holder").start();
                if (!heldLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Writer process did not acquire SQLite write lock in time");
                }
                return result;
            }
            throw new IllegalArgumentException("Unknown lock-holder method: " + method);
        } catch (Exception error) {
            throw new IllegalStateException("Lock holder provider failed", error);
        }
    }

    private static String holdWriteTransaction(
            File dir,
            String operationId,
            String intentJson,
            long amountCents,
            int expectedRevision,
            boolean commitOnRelease,
            CountDownLatch heldLatch,
            CountDownLatch releaseLatch
    ) throws Exception {
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
                int[] existingRev = new int[]{-1};
                String prior = BridgeLedgerStore.checkPriorReceipt(db, operationId, intentJson, existingRev);
                if (prior != null) {
                    return prior + "-" + existingRev[0];
                }
                long head = BridgeLedgerStore.queryLong(db, "SELECT head FROM expense WHERE id=1", null);
                if (head != expectedRevision) {
                    throw new IllegalStateException("Stale head in lock holder: " + head);
                }
                BridgeLedgerStore.writeRows(db, expectedRevision + 1, amountCents, null, operationId, intentJson);
                heldLatch.countDown();
                if (!releaseLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Writer release barrier expired");
                }
                if (commitOnRelease) {
                    db.setTransactionSuccessful();
                }
            } finally {
                db.endTransaction();
            }
        }
        return commitOnRelease ? "committed" : "rolled_back";
    }

    private static String holdCreateWriteLock(
            File dir,
            CountDownLatch heldLatch,
            CountDownLatch releaseLatch
    ) throws Exception {
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
                heldLatch.countDown();
                if (!releaseLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Create writer release barrier expired");
                }
            } finally {
                db.endTransaction();
            }
        }
        return "released";
    }

    @Override
    public Cursor query(Uri u, String[] p, String s, String[] a, String o) {
        throw new UnsupportedOperationException();
    }

    @Override
    public String getType(Uri u) {
        throw new UnsupportedOperationException();
    }

    @Override
    public Uri insert(Uri u, ContentValues v) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri u, String s, String[] a) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri u, ContentValues v, String s, String[] a) {
        throw new UnsupportedOperationException();
    }
}
