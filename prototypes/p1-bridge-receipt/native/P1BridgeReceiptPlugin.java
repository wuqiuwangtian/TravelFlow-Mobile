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
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/**
 * Isolated P1 Capacitor plugin bridging TS expense.patch, expense.create and receipt.lookup commands
 * to durable Android SQLite transactions and synchronous caller-side intent persistence.
 */
@CapacitorPlugin(name = "P1BridgeReceipt")
public class P1BridgeReceiptPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicLong createReceiptReadCount = new AtomicLong(0L);

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

    private SharedPreferences createCallerPrefs(String scenario) {
        return getContext().getSharedPreferences("p1-bridge-create-caller-" + scenario, Context.MODE_PRIVATE);
    }

    private static JSObject normalizeCreatePending(String pendingRaw) throws Exception {
        JSONObject stored = new JSONObject(pendingRaw);
        String operationId = stored.getString("operationId");
        String rawCommandJson = stored.getString("rawCommandJson");
        String canonicalIntentJson = stored.getString("canonicalIntentJson");
        JSONObject rawCmd = new JSONObject(rawCommandJson);
        JSONObject op = rawCmd.getJSONObject("operation");
        String cmdOpId = op.getString("operation_id");
        if (!operationId.equals(cmdOpId)) {
            throw new IllegalStateException("Persisted pending operationId does not match rawCommandJson");
        }
        String datasetId = stored.optString("datasetId", "");
        if (datasetId.isEmpty()) {
            datasetId = op.getString("dataset_id");
        }
        String sourceDeviceId = stored.optString("sourceDeviceId", "");
        if (sourceDeviceId.isEmpty()) {
            sourceDeviceId = op.getString("source_device_id");
        }
        String expectedRevisionId = stored.optString("expectedRevisionId", "");
        if (expectedRevisionId.isEmpty()) {
            expectedRevisionId = rawCmd.getString("expected_revision_id");
        }
        String intentSha256 = stored.optString("intentSha256", "");
        if (intentSha256.isEmpty()) {
            intentSha256 = BridgeCreateLedgerStore.sha256Hex(canonicalIntentJson);
        }
        String recoveryState = stored.optString("recoveryState", "");
        if (recoveryState.isEmpty()) {
            // Legacy 131b848 records were persisted immediately before submission without recoveryState.
            recoveryState = "pending_verification";
        }
        Object lastError = stored.has("lastError") ? stored.get("lastError") : JSONObject.NULL;

        JSObject normalized = new JSObject();
        normalized.put("operationId", operationId);
        normalized.put("datasetId", datasetId);
        normalized.put("sourceDeviceId", sourceDeviceId);
        normalized.put("expectedRevisionId", expectedRevisionId);
        normalized.put("rawCommandJson", rawCommandJson);
        normalized.put("canonicalIntentJson", canonicalIntentJson);
        normalized.put("intentSha256", intentSha256);
        normalized.put("recoveryState", recoveryState);
        normalized.put("lastError", lastError);
        return normalized;
    }

    private JSObject buildCreatePendingState(String scenario) throws Exception {
        SharedPreferences prefs = createCallerPrefs(scenario);
        JSObject result = new JSObject();
        String pendingRaw = prefs.getString("pending", null);
        result.put("pending", pendingRaw != null ? normalizeCreatePending(pendingRaw) : JSONObject.NULL);
        String confirmedOp = prefs.getString("confirmed_op", null);
        result.put("confirmedOp", confirmedOp != null ? confirmedOp : JSONObject.NULL);
        String confirmedRev = prefs.getString("confirmed_rev_id", null);
        result.put("confirmedRevisionId", confirmedRev != null ? confirmedRev : JSONObject.NULL);
        return result;
    }

    @PluginMethod
    public void seedCreateScenario(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String datasetId = call.getString("datasetId", "");
        String travelId = call.getString("travelId", "");
        String branchId = call.getString("branchId", "");
        String initialRevisionId = call.getString("initialRevisionId", "");
        int initialCount = call.getInt("initialCount", 0);
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)
                        || datasetId.isEmpty() || travelId.isEmpty()
                        || branchId.isEmpty() || initialRevisionId.isEmpty()
                        || initialCount < 0 || initialCount > BridgeCreateLedgerStore.MAX_BRANCH_EXPENSES) {
                    call.reject("Invalid seedCreateScenario arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                BridgeCreateLedgerStore.seedWithExpenseCount(
                        dir, datasetId, travelId, branchId, initialRevisionId, initialCount);
                JSObject state = BridgeCreateLedgerStore.inspectState(
                        dir, createReceiptReadCount.get(), 0, BridgeCreateLedgerStore.DEFAULT_PAGE_LIMIT);
                JSObject pending = buildCreatePendingState(scenario);
                state.put("pending", pending.get("pending"));
                state.put("confirmedOp", pending.get("confirmedOp"));
                state.put("confirmedRevisionId", pending.get("confirmedRevisionId"));
                call.resolve(state);
            } catch (Exception error) {
                call.reject(error.getMessage(), "SEED_CREATE_FAILED");
            }
        });
    }

    @PluginMethod
    public void saveCreatePendingIntent(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String rawCommandJson = call.getString("rawCommandJson", "");
        String canonicalIntentJson = call.getString("canonicalIntentJson", "");
        String recoveryState = call.getString("recoveryState", "pending_submission");
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)
                        || operationId.isEmpty() || rawCommandJson.isEmpty() || canonicalIntentJson.isEmpty()) {
                    call.reject("Invalid saveCreatePendingIntent arguments", "INVALID_ARGUMENTS");
                    return;
                }
                SharedPreferences prefs = createCallerPrefs(scenario);
                if (prefs.contains("pending") || prefs.contains("confirmed_op")) {
                    call.reject("An operation already exists for this create scenario", "OPERATION_EXISTS");
                    return;
                }
                JSONObject rawCmd = new JSONObject(rawCommandJson);
                JSONObject op = rawCmd.getJSONObject("operation");
                JSONObject pending = new JSONObject()
                        .put("operationId", operationId)
                        .put("datasetId", op.getString("dataset_id"))
                        .put("sourceDeviceId", op.getString("source_device_id"))
                        .put("expectedRevisionId", rawCmd.getString("expected_revision_id"))
                        .put("rawCommandJson", rawCommandJson)
                        .put("canonicalIntentJson", canonicalIntentJson)
                        .put("intentSha256", BridgeCreateLedgerStore.sha256Hex(canonicalIntentJson))
                        .put("recoveryState", recoveryState)
                        .put("lastError", JSONObject.NULL);
                if (!prefs.edit().putString("pending", pending.toString()).commit()) {
                    call.reject("Failed to persist create pending intent", "PENDING_SAVE_FAILED");
                    return;
                }
                call.resolve(buildCreatePendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "PENDING_SAVE_FAILED");
            }
        });
    }

    @PluginMethod
    public void updateCreatePendingStatus(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String recoveryState = call.getString("recoveryState", "");
        String lastError = call.getString("lastError", null);
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)
                        || operationId.isEmpty() || recoveryState.isEmpty()) {
                    call.reject("Invalid updateCreatePendingStatus arguments", "INVALID_ARGUMENTS");
                    return;
                }
                SharedPreferences prefs = createCallerPrefs(scenario);
                String pendingRaw = prefs.getString("pending", null);
                if (pendingRaw == null) {
                    call.reject("No pending create operation to update", "NO_PENDING");
                    return;
                }
                JSONObject pending = normalizeCreatePending(pendingRaw);
                if (!operationId.equals(pending.getString("operationId"))) {
                    call.reject("Pending create operation ID mismatch", "OPERATION_MISMATCH");
                    return;
                }
                pending.put("recoveryState", recoveryState);
                pending.put("lastError", lastError != null ? lastError : JSONObject.NULL);
                if (!prefs.edit().putString("pending", pending.toString()).commit()) {
                    call.reject("Failed to update create pending status", "PENDING_UPDATE_FAILED");
                    return;
                }
                call.resolve(buildCreatePendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "PENDING_UPDATE_FAILED");
            }
        });
    }

    @PluginMethod
    public void holdCreateWriterLock(PluginCall call) {
        String scenario = call.getString("scenario", "");
        executor.execute(() -> {
            try {
                if (!"create-pending-ec07".equals(scenario)) {
                    call.reject("Unsupported create lock scenario", "INVALID_ARGUMENTS");
                    return;
                }
                Bundle reply = getContext().getContentResolver().call(
                        BridgeLockHolderProvider.AUTHORITY_URI, "hold_create", scenario, null);
                JSObject result = new JSObject();
                result.put("writerPid", reply != null ? reply.getInt("writer_pid", -1) : -1);
                result.put("callerPid", Process.myPid());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), "HOLD_CREATE_LOCK_FAILED");
            }
        });
    }

    @PluginMethod
    public void releaseCreateWriterLock(PluginCall call) {
        String scenario = call.getString("scenario", "");
        executor.execute(() -> {
            try {
                if (!"create-pending-ec07".equals(scenario)) {
                    call.reject("Unsupported create lock scenario", "INVALID_ARGUMENTS");
                    return;
                }
                Bundle reply = getContext().getContentResolver().call(
                        BridgeLockHolderProvider.AUTHORITY_URI, "release", scenario, null);
                JSObject result = new JSObject();
                result.put("writerPid", reply != null ? reply.getInt("writer_pid", -1) : -1);
                result.put("callerPid", Process.myPid());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), "RELEASE_CREATE_LOCK_FAILED");
            }
        });
    }

    @PluginMethod
    public void loadCreatePendingIntent(PluginCall call) {
        String scenario = call.getString("scenario", "");
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)) {
                    call.reject("Unknown create scenario", "INVALID_ARGUMENTS");
                    return;
                }
                call.resolve(buildCreatePendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "PENDING_LOAD_FAILED");
            }
        });
    }

    @PluginMethod
    public void confirmCreatePendingIntent(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String operationId = call.getString("operationId", "");
        String revisionId = call.getString("revisionId", "");
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario) || operationId.isEmpty() || revisionId.isEmpty()) {
                    call.reject("Invalid confirmCreatePendingIntent arguments", "INVALID_ARGUMENTS");
                    return;
                }
                SharedPreferences prefs = createCallerPrefs(scenario);
                String pendingRaw = prefs.getString("pending", null);
                if (pendingRaw == null) {
                    if (operationId.equals(prefs.getString("confirmed_op", null))) {
                        call.resolve(buildCreatePendingState(scenario));
                        return;
                    }
                    call.reject("No matching pending create operation", "NO_PENDING");
                    return;
                }
                JSONObject pending = new JSONObject(pendingRaw);
                if (!operationId.equals(pending.getString("operationId"))) {
                    call.reject("Pending create operation ID mismatch", "OPERATION_MISMATCH");
                    return;
                }
                boolean ok = prefs.edit()
                        .remove("pending")
                        .putString("confirmed_op", operationId)
                        .putString("confirmed_rev_id", revisionId)
                        .commit();
                if (!ok) {
                    call.reject("Failed to confirm create pending intent", "CONFIRM_FAILED");
                    return;
                }
                call.resolve(buildCreatePendingState(scenario));
            } catch (Exception error) {
                call.reject(error.getMessage(), "CONFIRM_FAILED");
            }
        });
    }

    @PluginMethod
    public void submitExpenseCreate(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String rawCommandJson = call.getString("rawCommandJson", "");
        String canonicalIntentJson = call.getString("canonicalIntentJson", "");
        String faultMode = call.getString("faultMode", "none");
        JSObject principal = call.getObject("principal");
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)
                        || rawCommandJson.isEmpty() || canonicalIntentJson.isEmpty()
                        || (!"none".equals(faultMode) && !"before_commit".equals(faultMode)
                                && !"after_commit_drop_reply".equals(faultMode))) {
                    call.reject("Invalid submitExpenseCreate arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                call.resolve(BridgeCreateLedgerStore.executeCreate(
                        dir, principal, rawCommandJson, canonicalIntentJson, faultMode));
            } catch (Exception error) {
                call.reject(error.getMessage(), "CREATE_SUBMIT_FAILED");
            }
        });
    }

    @PluginMethod
    public void submitCreateNotesPatch(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String rawCommandJson = call.getString("rawCommandJson", "");
        String canonicalIntentJson = call.getString("canonicalIntentJson", "");
        JSObject principal = call.getObject("principal");
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)
                        || rawCommandJson.isEmpty() || canonicalIntentJson.isEmpty()) {
                    call.reject("Invalid submitCreateNotesPatch arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                call.resolve(BridgeCreateLedgerStore.executeNotesPatch(
                        dir, principal, rawCommandJson, canonicalIntentJson));
            } catch (Exception error) {
                call.reject(error.getMessage(), "CREATE_PATCH_FAILED");
            }
        });
    }

    @PluginMethod
    public void lookupCreateReceipt(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String datasetId = call.getString("datasetId", "");
        String sourceDeviceId = call.getString("sourceDeviceId", "");
        String operationId = call.getString("operationId", "");
        String expectedCanonicalIntentJson = call.getString("canonicalIntentJson", null);
        JSObject principal = call.getObject("principal");
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)
                        || datasetId.isEmpty() || sourceDeviceId.isEmpty() || operationId.isEmpty()) {
                    call.reject("Invalid lookupCreateReceipt arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                call.resolve(BridgeCreateLedgerStore.lookupReceipt(
                        dir, principal, datasetId, sourceDeviceId, operationId,
                        expectedCanonicalIntentJson, createReceiptReadCount));
            } catch (Exception error) {
                call.reject(error.getMessage(), "CREATE_LOOKUP_FAILED");
            }
        });
    }

    @PluginMethod
    public void inspectCreateState(PluginCall call) {
        String scenario = call.getString("scenario", "");
        int pageOffset = call.getInt("pageOffset", 0);
        int pageLimit = call.getInt("pageLimit", BridgeCreateLedgerStore.DEFAULT_PAGE_LIMIT);
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario)) {
                    call.reject("Unknown create scenario", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                JSObject state = BridgeCreateLedgerStore.inspectState(
                        dir, createReceiptReadCount.get(), pageOffset, pageLimit);
                JSObject pending = buildCreatePendingState(scenario);
                state.put("pending", pending.get("pending"));
                state.put("confirmedOp", pending.get("confirmedOp"));
                state.put("confirmedRevisionId", pending.get("confirmedRevisionId"));
                call.resolve(state);
            } catch (Exception error) {
                call.reject(error.getMessage(), "CREATE_INSPECT_FAILED");
            }
        });
    }

    @PluginMethod
    public void readCreateRevisionPage(PluginCall call) {
        String scenario = call.getString("scenario", "");
        String revisionId = call.getString("revisionId", "");
        int offset = call.getInt("offset", 0);
        int limit = call.getInt("limit", BridgeCreateLedgerStore.DEFAULT_PAGE_LIMIT);
        executor.execute(() -> {
            try {
                if (!BridgeCreateLedgerStore.isCreateScenario(scenario) || revisionId.isEmpty()) {
                    call.reject("Invalid readCreateRevisionPage arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = BridgeCreateLedgerStore.scenarioDir(getContext().getFilesDir(), scenario);
                call.resolve(BridgeCreateLedgerStore.readRevisionPage(dir, revisionId, offset, limit));
            } catch (Exception error) {
                call.reject(error.getMessage(), "CREATE_REVISION_PAGE_FAILED");
            }
        });
    }

    @PluginMethod
    public void initOfflineTripLedger(PluginCall call) {
        String datasetId = call.getString("datasetId", "");
        String travelId = call.getString("travelId", "");
        String branchId = call.getString("branchId", "");
        String initialRevisionId = call.getString("initialRevisionId", "");
        String baselineSource = call.getString("baselineSource", "");
        executor.execute(() -> {
            try {
                if (datasetId.isEmpty() || travelId.isEmpty() || branchId.isEmpty()
                        || initialRevisionId.isEmpty() || baselineSource.isEmpty()) {
                    call.reject("Invalid initOfflineTripLedger arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
                OfflineTripLedgerStore.ensureInitialized(
                        dir, datasetId, travelId, branchId, initialRevisionId, baselineSource);
                call.resolve(OfflineTripLedgerStore.inspectLedger(dir));
            } catch (Exception error) {
                call.reject(error.getMessage(), "OFFLINE_LEDGER_INIT_FAILED");
            }
        });
    }

    @PluginMethod
    public void saveOfflineTripExpense(PluginCall call) {
        String rawCommandJson = call.getString("rawCommandJson", "");
        String canonicalIntentJson = call.getString("canonicalIntentJson", "");
        executor.execute(() -> {
            try {
                if (rawCommandJson.isEmpty() || canonicalIntentJson.isEmpty()) {
                    call.reject("Invalid saveOfflineTripExpense arguments", "INVALID_ARGUMENTS");
                    return;
                }
                File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
                call.resolve(OfflineTripLedgerStore.saveOfflineExpense(dir, rawCommandJson, canonicalIntentJson));
            } catch (Exception error) {
                call.reject(error.getMessage(), "OFFLINE_EXPENSE_SAVE_FAILED");
            }
        });
    }

    @PluginMethod
    public void confirmOfflineDelivery(PluginCall call) {
        executor.execute(() -> {
            try {
                JSObject response = call.getObject("response");
                if (response == null) throw new IllegalArgumentException("Missing receiver response");
                call.resolve(OfflineTripLedgerStore.confirmDelivery(
                        OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir()),
                        call.getString("operationId", ""), response));
            } catch (Exception error) {
                call.reject(error.getMessage(), "OFFLINE_CONFIRM_FAILED");
            }
        });
    }

    @PluginMethod
    public void receiveDesktopCommand(PluginCall call) {
        executor.execute(() -> {
            try {
                call.resolve(OfflineTripLedgerStore.receiveDesktopCommand(
                        OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir()), call.getString("raw", "")));
            } catch (Exception error) {
                call.reject(error.getMessage(), "OFFLINE_RECEIVE_FAILED");
            }
        });
    }

    @PluginMethod
    public void inspectOfflineTripLedger(PluginCall call) {
        executor.execute(() -> {
            try {
                File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
                call.resolve(OfflineTripLedgerStore.inspectLedger(dir));
            } catch (Exception error) {
                call.reject(error.getMessage(), "OFFLINE_LEDGER_INSPECT_FAILED");
            }
        });
    }

    @PluginMethod
    public void exportOfflineOutboxCommands(PluginCall call) {
        executor.execute(() -> {
            try {
                File dir = OfflineTripLedgerStore.ledgerDir(getContext().getFilesDir());
                call.resolve(OfflineTripLedgerStore.exportOutboxCommands(dir));
            } catch (Exception error) {
                call.reject(error.getMessage(), "OFFLINE_OUTBOX_EXPORT_FAILED");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
