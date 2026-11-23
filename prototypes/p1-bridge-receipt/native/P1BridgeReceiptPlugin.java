package org.travelflow.p1bridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.os.Bundle;
import android.os.Process;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Isolated P1 Capacitor plugin bridging TS expense.patch + receipt.lookup commands
 * to durable Android SQLite transactions and synchronous caller-side intent persistence.
 */
@CapacitorPlugin(name = "P1BridgeReceipt")
public class P1BridgeReceiptPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private SharedPreferences callerPrefs(String scenario) {
        return getContext().getSharedPreferences("p1-bridge-caller-" + scenario, Context.MODE_PRIVATE);
    }

    private static Long extractExactAmountCents(PluginCall call, String key) {
        Object raw = call.getData().opt(key);
        long value;
        if (raw instanceof Integer) {
            value = ((Integer) raw).longValue();
        } else if (raw instanceof Long) {
            value = ((Long) raw).longValue();
        } else if (raw instanceof Double) {
            double d = ((Double) raw).doubleValue();
            if (!Double.isFinite(d) || Math.rint(d) != d) {
                return null;
            }
            value = (long) d;
            if ((double) value != d) {
                return null;
            }
        } else {
            return null;
        }
        return BridgeLedgerStore.isValidAmountCents(value) ? Long.valueOf(value) : null;
    }

    private static boolean intentMatchesAmountCents(String intentJson, long amountCents) {
        try {
            JSONObject doc = new JSONObject(intentJson);
            JSONObject intent = doc.getJSONObject("intent");
            JSONObject payload = intent.getJSONObject("payload");
            Object raw = payload.opt("amount_cents");
            if (raw instanceof Integer) {
                return ((Integer) raw).longValue() == amountCents;
            }
            if (raw instanceof Long) {
                return ((Long) raw).longValue() == amountCents;
            }
            return false;
        } catch (Exception ignored) {
            return false;
        }
    }

    private JSObject buildPendingState(String scenario) throws Exception {
        SharedPreferences prefs = callerPrefs(scenario);
        JSObject result = new JSObject();
        String pendingRaw = prefs.getString("pending", null);
        if (pendingRaw != null) {
            result.put("pending", new JSObject(pendingRaw));
        } else {
            result.put("pending", JSONObject.NULL);
        }
        String confirmedOp = prefs.getString("confirmed_op", null);
        result.put("confirmedOp", confirmedOp != null ? confirmedOp : JSONObject.NULL);
        result.put("confirmedRev", prefs.getInt("confirmed_rev", -1));
        String confirmedIntent = prefs.getString("confirmed_intent_json", null);
        result.put("confirmedIntentJson", confirmedIntent != null ? confirmedIntent : JSONObject.NULL);
        // The first fixture build stored confirmations as Integer; new writes use Long.
        Object cents = prefs.getAll().get("confirmed_amount_cents");
        if (cents != null && !(cents instanceof Integer) && !(cents instanceof Long)) {
            throw new IllegalStateException("Unexpected confirmed amount type");
        }
        result.put("confirmedAmountCents", cents == null ? -1L : ((Number) cents).longValue());
        result.put("confirmedExpectedRevision", prefs.getInt("confirmed_expected_revision", -1));
        return result;
    }

    private JSObject buildInspectState(String scenario, String operationId) throws Exception {
        File dir = BridgeLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
        JSObject pendingState = buildPendingState(scenario);
        JSObject data = new JSObject();
        data.put("scenario", scenario);
        data.put("callerPid", Process.myPid());
        data.put("pending", pendingState.get("pending"));
        data.put("confirmedOp", pendingState.get("confirmedOp"));
        data.put("confirmedRev", pendingState.getInteger("confirmedRev", -1));
        if (!dir.isDirectory() || !new File(dir, "store.db").isFile()) {
            data.put("seeded", false);
            data.put("head", -1);
            data.put("cents", 0);
            data.put("historyCount", 0);
            data.put("receiptCount", 0);
            data.put("outboxCount", 0);
            data.put("opReceiptCount", 0);
            data.put("opOutboxCount", 0);
            data.put("opHistoryCount", 0);
            data.put("ticketExists", false);
            data.put("ticketIntact", false);
            data.put("ticketText", JSONObject.NULL);
            data.put("unmanagedIntact", false);
            data.put("journal", "");
            data.put("sqlite", "");
            data.put("committedIntent", JSONObject.NULL);
            return data;
        }
        String effectiveOp = operationId;
        if (effectiveOp == null || effectiveOp.isEmpty()) {
            SharedPreferences prefs = callerPrefs(scenario);
            String pendingRaw = prefs.getString("pending", null);
            if (pendingRaw != null) {
                effectiveOp = new JSONObject(pendingRaw).optString("operationId", null);
            }
            if (effectiveOp == null || effectiveOp.isEmpty()) {
                effectiveOp = prefs.getString("confirmed_op", null);
            }
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            data.put("seeded", true);
            data.put("head", BridgeLedgerStore.queryLong(db, "SELECT head FROM expense WHERE id=1", null));
            data.put("cents", BridgeLedgerStore.queryLong(db, "SELECT cents FROM expense WHERE id=1", null));
            data.put("historyCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM history", null));
            data.put("receiptCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM receipt", null));
            data.put("outboxCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM outbox", null));
            if (effectiveOp != null && !effectiveOp.isEmpty()) {
                String[] args = new String[]{effectiveOp};
                data.put("opReceiptCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM receipt WHERE op=?", args));
                data.put("opOutboxCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM outbox WHERE op=?", args));
                data.put("opHistoryCount", BridgeLedgerStore.queryLong(
                        db,
                        "SELECT count(*) FROM history h JOIN receipt r ON r.rev=h.rev JOIN outbox o ON o.op=r.op AND o.rev=r.rev WHERE r.op=?",
                        args));
                try (Cursor row = db.rawQuery("SELECT intent FROM receipt WHERE op=?", args)) {
                    data.put("committedIntent", row.moveToFirst() ? row.getString(0) : JSONObject.NULL);
                }
            } else {
                data.put("opReceiptCount", 0);
                data.put("opOutboxCount", 0);
                data.put("opHistoryCount", 0);
                data.put("committedIntent", JSONObject.NULL);
            }
            File ticket = new File(dir, BridgeLedgerStore.HISTORICAL_TICKET_NAME);
            data.put("ticketExists", ticket.isFile());
            data.put("ticketIntact", BridgeLedgerStore.historicalTicketIntact(dir));
            String ticketText = BridgeLedgerStore.readHistoricalTicketText(dir);
            data.put("ticketText", ticketText != null ? ticketText : JSONObject.NULL);
            data.put("unmanagedIntact", BridgeLedgerStore.unmanagedIntact(dir));
            data.put("journal", DatabaseUtils.stringForQuery(db, "PRAGMA journal_mode", null));
            data.put("sqlite", DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null));
        }
        return data;
    }

    @PluginMethod
    public void seedScenario(PluginCall call) {
        String scenario = call.getString("scenario", "");
        executor.execute(() -> {
            try {
                File dir = BridgeLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                BridgeLedgerStore.seed(dir);
                call.resolve(buildInspectState(scenario, null));
            } catch (Exception error) {
                call.reject(error.getMessage(), "SEED_FAILED");
            }
        });
    }

    @PluginMethod
    public void savePendingIntent(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String intentJson = call.getString("intentJson", "");
        Long amountCents = extractExactAmountCents(call, "amountCents");
        Integer expectedRevision = call.getInt("expectedRevision");
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario)
                        || operationId.isEmpty() || intentJson.isEmpty()
                        || amountCents == null
                        || !intentMatchesAmountCents(intentJson, amountCents.longValue())
                        || expectedRevision == null || expectedRevision < 0) {
                    call.reject("Invalid pending intent arguments", "INVALID_ARGUMENTS");
                    return;
                }
                SharedPreferences prefs = callerPrefs(scenario);
                if (prefs.contains("pending") || prefs.contains("confirmed_op")) {
                    call.reject("An operation already exists for this scenario", "OPERATION_EXISTS");
                    return;
                }
                JSONObject pending = new JSONObject()
                        .put("operationId", operationId)
                        .put("intentJson", intentJson)
                        .put("amountCents", amountCents.longValue())
                        .put("expectedRevision", expectedRevision.intValue());
                if (!prefs.edit().putString("pending", pending.toString()).commit()) {
                    call.reject("Failed to durably persist caller pending intent", "PENDING_SAVE_FAILED");
                    return;
                }
                call.resolve(buildPendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "PENDING_SAVE_FAILED");
            }
        });
    }

    @PluginMethod
    public void loadPendingIntent(PluginCall call) {
        String scenario = call.getString("scenario", "");
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario)) {
                    call.reject("Unknown scenario", "INVALID_ARGUMENTS");
                    return;
                }
                call.resolve(buildPendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "PENDING_LOAD_FAILED");
            }
        });
    }

    @PluginMethod
    public void confirmPendingIntent(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        Integer revision = call.getInt("revision");
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario) || operationId.isEmpty() || revision == null || revision < 0) {
                    call.reject("Invalid confirmation arguments", "INVALID_ARGUMENTS");
                    return;
                }
                SharedPreferences prefs = callerPrefs(scenario);
                String pendingRaw = prefs.getString("pending", null);
                if (pendingRaw == null) {
                    if (operationId.equals(prefs.getString("confirmed_op", null))) {
                        call.resolve(buildPendingState(scenario));
                        return;
                    }
                    call.reject("No matching pending operation to confirm", "NO_PENDING");
                    return;
                }
                JSONObject pending = new JSONObject(pendingRaw);
                if (!operationId.equals(pending.getString("operationId"))) {
                    call.reject("Pending operation ID mismatch", "OPERATION_MISMATCH");
                    return;
                }
                boolean committed = prefs.edit()
                        .remove("pending")
                        .putString("confirmed_op", operationId)
                        .putInt("confirmed_rev", revision)
                        .putString("confirmed_intent_json", pending.getString("intentJson"))
                        .putLong("confirmed_amount_cents", pending.getLong("amountCents"))
                        .putInt("confirmed_expected_revision", pending.getInt("expectedRevision"))
                        .commit();
                if (!committed) {
                    call.reject("Failed to persist confirmation", "CONFIRM_FAILED");
                    return;
                }
                call.resolve(buildPendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "CONFIRM_FAILED");
            }
        });
    }

    @PluginMethod
    public void submitExpensePatch(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String intentJson = call.getString("intentJson", "");
        Long amountCents = extractExactAmountCents(call, "amountCents");
        Integer expectedRevision = call.getInt("expectedRevision");
        String faultMode = call.getString("faultMode", "none");
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario)
                        || operationId.isEmpty() || intentJson.isEmpty()
                        || amountCents == null
                        || !intentMatchesAmountCents(intentJson, amountCents.longValue())
                        || expectedRevision == null || expectedRevision < 0
                        || (!"none".equals(faultMode) && !"before_commit".equals(faultMode)
                                && !"after_commit_drop_reply".equals(faultMode))) {
                    call.reject("Invalid submit arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                String status;
                int resultRevision = -1;
                try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
                    db.beginTransactionNonExclusive();
                    try {
                        int[] existingRev = new int[]{-1};
                        String prior = BridgeLedgerStore.checkPriorReceipt(db, operationId, intentJson, existingRev);
                        if (prior != null) {
                            status = prior;
                            resultRevision = existingRev[0];
                        } else {
                            long head = BridgeLedgerStore.queryLong(db, "SELECT head FROM expense WHERE id=1", null);
                            if (head != expectedRevision.longValue()) {
                                status = "stale_head";
                                resultRevision = (int) head;
                            } else {
                                int nextRev = expectedRevision + 1;
                                BridgeLedgerStore.writeRows(db, nextRev, amountCents.longValue(), null, operationId, intentJson);
                                if ("before_commit".equals(faultMode)) {
                                    // Kill process before SQLite commit so the entire write rolls back on reopen.
                                    Process.killProcess(Process.myPid());
                                    throw new AssertionError("Process kill returned");
                                }
                                db.setTransactionSuccessful();
                                status = "committed";
                                resultRevision = nextRev;
                            }
                        }
                    } finally {
                        db.endTransaction();
                    }
                }
                if ("after_commit_drop_reply".equals(faultMode) && "committed".equals(status)) {
                    // SQLite transaction is committed and durable; kill process before resolving the Capacitor bridge call.
                    Process.killProcess(Process.myPid());
                    throw new AssertionError("Process kill returned");
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("operationId", operationId);
                result.put("revision", resultRevision);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), "SUBMIT_FAILED");
            }
        });
    }

    @PluginMethod
    public void lookupReceipt(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String intentJson = call.getString("intentJson", "");
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario) || operationId.isEmpty() || intentJson.isEmpty()) {
                    call.reject("Invalid lookup arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                JSObject result = new JSObject();
                result.put("operationId", operationId);
                result.put("callerPid", Process.myPid());
                try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
                    long plainCount = BridgeLedgerStore.queryLong(
                            db, "SELECT count(*) FROM receipt WHERE op=?", new String[]{operationId});
                    result.put("plainReceipts", plainCount);
                    // Serialize receipt lookup with writers; a plain SELECT can miss an uncommitted write in progress.
                    try {
                        db.beginTransactionNonExclusive();
                        try (Cursor row = db.rawQuery("SELECT intent,rev FROM receipt WHERE op=?", new String[]{operationId})) {
                            if (!row.moveToFirst()) {
                                result.put("status", "no_receipt");
                                result.put("revision", -1);
                            } else if (intentJson.equals(row.getString(0))) {
                                result.put("status", "confirmed");
                                result.put("revision", row.getInt(1));
                            } else {
                                result.put("status", "intent_conflict");
                                result.put("revision", row.getInt(1));
                            }
                        } finally {
                            db.endTransaction();
                        }
                    } catch (SQLiteDatabaseLockedException busy) {
                        result.put("status", "pending_busy");
                        result.put("revision", -1);
                    }
                }
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), "LOOKUP_FAILED");
            }
        });
    }

    @PluginMethod
    public void inspectState(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario)) {
                    call.reject("Unknown scenario", "INVALID_ARGUMENTS");
                    return;
                }
                call.resolve(buildInspectState(scenario, operationId));
            } catch (Exception error) {
                call.reject(error.getMessage(), "INSPECT_FAILED");
            }
        });
    }

    @PluginMethod
    public void holdWriterLock(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String intentJson = call.getString("intentJson", "");
        Long amountCents = extractExactAmountCents(call, "amountCents");
        Integer expectedRevision = call.getInt("expectedRevision");
        Boolean commitOnRelease = call.getBoolean("commitOnRelease", false);
        executor.execute(() -> {
            try {
                if (!BridgeLedgerStore.isValidScenario(scenario)
                        || operationId.isEmpty() || intentJson.isEmpty()
                        || amountCents == null
                        || !intentMatchesAmountCents(intentJson, amountCents.longValue())
                        || expectedRevision == null || expectedRevision < 0) {
                    call.reject("Invalid hold lock arguments", "INVALID_ARGUMENTS");
                    return;
                }
                Bundle args = new Bundle();
                args.putString("operation_id", operationId);
                args.putString("intent_json", intentJson);
                args.putLong("amount_cents", amountCents.longValue());
                args.putInt("expected_revision", expectedRevision.intValue());
                args.putBoolean("commit_on_release", Boolean.TRUE.equals(commitOnRelease));
                Bundle reply = getContext().getContentResolver().call(
                        BridgeLockHolderProvider.AUTHORITY_URI, "hold", scenario, args);
                JSObject result = new JSObject();
                result.put("writerPid", reply != null ? reply.getInt("writer_pid", -1) : -1);
                result.put("callerPid", Process.myPid());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), "HOLD_LOCK_FAILED");
            }
        });
    }

    @PluginMethod
    public void releaseWriterLock(PluginCall call) {
        String scenario = call.getString("scenario", "");
        executor.execute(() -> {
            try {
                Bundle reply = getContext().getContentResolver().call(
                        BridgeLockHolderProvider.AUTHORITY_URI, "release", scenario, null);
                JSObject result = new JSObject();
                result.put("writerPid", reply != null ? reply.getInt("writer_pid", -1) : -1);
                result.put("callerPid", Process.myPid());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), "RELEASE_LOCK_FAILED");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
