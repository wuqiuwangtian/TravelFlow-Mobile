package org.travelflow.p1bridge;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.os.Process;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Isolated empty-ledger SQLite store for P1 expense.create Android verification,
 * matching the host desktop-create contract (revisions, expenses, receipts, outbox in one tx).
 */
final class BridgeCreateLedgerStore {
    private BridgeCreateLedgerStore() {}

    static boolean isCreateScenario(String scenario) {
        return scenario != null && scenario.matches("create-before-commit|create-after-commit");
    }

    static File scenarioDir(File filesDir, String scenario) {
        if (!isCreateScenario(scenario)) {
            throw new IllegalArgumentException("Unknown P1 create scenario: " + scenario);
        }
        return new File(filesDir, "p1-bridge-" + scenario);
    }

    static void seedEmpty(File dir, String datasetId, String travelId, String branchId, String initialRevisionId)
            throws Exception {
        if (dir.exists()) {
            throw new IllegalStateException("Create scenario already initialized: " + dir.getName());
        }
        if (!dir.mkdirs()) {
            throw new IllegalStateException("Failed to create scenario directory: " + dir.getName());
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, true)) {
            db.beginTransaction();
            try {
                db.execSQL("CREATE TABLE branch_head("
                        + "id INTEGER PRIMARY KEY CHECK(id=1), "
                        + "dataset_id TEXT NOT NULL, "
                        + "travel_id TEXT NOT NULL, "
                        + "branch_id TEXT NOT NULL, "
                        + "head_revision_id TEXT NOT NULL)");
                db.execSQL("CREATE TABLE revisions("
                        + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                        + "revision_id TEXT NOT NULL UNIQUE, "
                        + "parent_revision_id TEXT, "
                        + "snapshot_json TEXT NOT NULL)");
                db.execSQL("CREATE TABLE expenses("
                        + "entity_id TEXT PRIMARY KEY, "
                        + "title TEXT NOT NULL, "
                        + "amount_cents INTEGER NOT NULL, "
                        + "currency TEXT NOT NULL, "
                        + "paid_on TEXT, "
                        + "category TEXT NOT NULL, "
                        + "day INTEGER, "
                        + "activity_id TEXT, "
                        + "notes TEXT NOT NULL, "
                        + "receipt_ids_json TEXT NOT NULL, "
                        + "allow_shared_receipts INTEGER NOT NULL, "
                        + "budget_item_id TEXT, "
                        + "settles_budget INTEGER NOT NULL)");
                db.execSQL("CREATE TABLE receipts("
                        + "dataset_id TEXT NOT NULL, "
                        + "source_device_id TEXT NOT NULL, "
                        + "operation_id TEXT NOT NULL, "
                        + "intent_json TEXT NOT NULL, "
                        + "effect TEXT NOT NULL, "
                        + "result_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), "
                        + "PRIMARY KEY(dataset_id, source_device_id, operation_id))");
                db.execSQL("CREATE TABLE outbox("
                        + "dataset_id TEXT NOT NULL, "
                        + "source_device_id TEXT NOT NULL, "
                        + "operation_id TEXT NOT NULL, "
                        + "result_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), "
                        + "PRIMARY KEY(dataset_id, source_device_id, operation_id), "
                        + "FOREIGN KEY(dataset_id, source_device_id, operation_id) "
                        + "REFERENCES receipts(dataset_id, source_device_id, operation_id))");

                db.execSQL("INSERT INTO revisions(revision_id, parent_revision_id, snapshot_json) VALUES(?,?,?)",
                        new Object[]{initialRevisionId, null, "{\"expenses\":[]}"});
                db.execSQL("INSERT INTO branch_head VALUES(1,?,?,?,?)",
                        new Object[]{datasetId, travelId, branchId, initialRevisionId});
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
    }

    static String validateAmountCents(JSONObject payload, long[] outCents) {
        if (!payload.has("amount_cents") || payload.isNull("amount_cents")) {
            return "type";
        }
        Object raw = payload.opt("amount_cents");
        if (raw instanceof Boolean || raw instanceof String || raw instanceof JSONObject || raw instanceof JSONArray) {
            return "type";
        }
        long value;
        if (raw instanceof Integer) {
            value = ((Integer) raw).longValue();
        } else if (raw instanceof Long) {
            value = ((Long) raw).longValue();
        } else if (raw instanceof Double) {
            double d = ((Double) raw).doubleValue();
            if (!Double.isFinite(d) || Math.rint(d) != d) {
                return "integer_range";
            }
            value = (long) d;
            if ((double) value != d) {
                return "integer_range";
            }
        } else {
            return "type";
        }
        if (!BridgeLedgerStore.isValidAmountCents(value)) {
            return "integer_range";
        }
        outCents[0] = value;
        return null;
    }

    static JSObject executeCreate(
            File dir,
            String rawCommandJson,
            String canonicalIntentJson,
            String faultMode
    ) throws Exception {
        JSONObject command = new JSONObject(rawCommandJson);
        if (!"p1-host-control-1".equals(command.optString("profile"))
                || !"expense.create".equals(command.optString("kind"))) {
            return rejected("unsupported_command");
        }
        JSONObject op = command.getJSONObject("operation");
        JSONObject target = command.getJSONObject("target");
        JSONObject payload = command.getJSONObject("payload");

        String datasetId = op.getString("dataset_id");
        String sourceDeviceId = op.getString("source_device_id");
        String operationId = op.getString("operation_id");
        String travelId = target.getString("travel_id");
        String branchId = target.getString("branch_id");
        String entityId = target.getString("entity_id");
        String expectedRevisionId = command.getString("expected_revision_id");

        long[] parsedCents = new long[1];
        String amountError = validateAmountCents(payload, parsedCents);
        if (amountError != null) {
            return rejected(amountError);
        }
        long amountCents = parsedCents[0];
        String currency = payload.isNull("currency") ? null : payload.optString("currency", null);
        if (!"CNY".equals(currency)) {
            return rejected("currency");
        }
        String title = payload.getString("title");
        String paidOn = payload.isNull("paid_on") ? null : payload.getString("paid_on");
        String category = payload.getString("category");
        Integer day = payload.isNull("day") ? null : payload.getInt("day");
        String activityId = payload.isNull("activity_id") ? null : payload.getString("activity_id");
        String notes = payload.getString("notes");
        JSONArray receiptIds = payload.getJSONArray("receipt_ids");
        boolean allowSharedReceipts = payload.getBoolean("allow_shared_receipts");
        String budgetItemId = payload.isNull("budget_item_id") ? null : payload.getString("budget_item_id");
        boolean settlesBudget = payload.getBoolean("settles_budget");

        String resultRevisionId = null;
        boolean replayed = false;
        String rejectError = null;

        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
                // Always check durable receipt first: replays must return the original revision even after head advances.
                try (Cursor row = db.rawQuery(
                        "SELECT intent_json, effect, result_revision_id FROM receipts "
                                + "WHERE dataset_id=? AND source_device_id=? AND operation_id=?",
                        new String[]{datasetId, sourceDeviceId, operationId})) {
                    if (row.moveToFirst()) {
                        String storedIntent = row.getString(0);
                        if (!canonicalIntentJson.equals(storedIntent)) {
                            rejectError = "intent_conflict";
                        } else {
                            replayed = true;
                            resultRevisionId = row.getString(2);
                        }
                    }
                }

                if (rejectError == null && !replayed) {
                    String currentHead;
                    try (Cursor headRow = db.rawQuery(
                            "SELECT dataset_id, travel_id, branch_id, head_revision_id FROM branch_head WHERE id=1",
                            null)) {
                        if (!headRow.moveToFirst()) {
                            throw new IllegalStateException("Missing branch_head row");
                        }
                        if (!datasetId.equals(headRow.getString(0))
                                || !travelId.equals(headRow.getString(1))
                                || !branchId.equals(headRow.getString(2))) {
                            rejectError = "scope_mismatch";
                            currentHead = null;
                        } else {
                            currentHead = headRow.getString(3);
                        }
                    }

                    if (rejectError == null) {
                        if (!expectedRevisionId.equals(currentHead)) {
                            rejectError = "baseline_conflict";
                        } else if (BridgeLedgerStore.queryLong(
                                db, "SELECT count(*) FROM expenses WHERE entity_id=?", new String[]{entityId}) > 0) {
                            rejectError = "entity_exists";
                        } else {
                            resultRevisionId = "fixture-" + UUID.randomUUID().toString();
                            db.execSQL(
                                    "INSERT INTO expenses(entity_id, title, amount_cents, currency, paid_on, category, "
                                            + "day, activity_id, notes, receipt_ids_json, allow_shared_receipts, "
                                            + "budget_item_id, settles_budget) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                    new Object[]{
                                            entityId,
                                            title,
                                            amountCents,
                                            currency,
                                            paidOn,
                                            category,
                                            day,
                                            activityId,
                                            notes,
                                            receiptIds.toString(),
                                            allowSharedReceipts ? 1 : 0,
                                            budgetItemId,
                                            settlesBudget ? 1 : 0,
                                    });
                            String snapshotJson = buildSnapshotJson(db);
                            db.execSQL(
                                    "INSERT INTO revisions(revision_id, parent_revision_id, snapshot_json) VALUES(?,?,?)",
                                    new Object[]{resultRevisionId, currentHead, snapshotJson});
                            db.execSQL(
                                    "UPDATE branch_head SET head_revision_id=? WHERE id=1",
                                    new Object[]{resultRevisionId});
                            db.execSQL(
                                    "INSERT INTO receipts(dataset_id, source_device_id, operation_id, intent_json, effect, result_revision_id) "
                                            + "VALUES(?,?,?,?,?,?)",
                                    new Object[]{datasetId, sourceDeviceId, operationId, canonicalIntentJson, "changed", resultRevisionId});
                            db.execSQL(
                                    "INSERT INTO outbox(dataset_id, source_device_id, operation_id, result_revision_id) VALUES(?,?,?,?)",
                                    new Object[]{datasetId, sourceDeviceId, operationId, resultRevisionId});

                            if ("before_commit".equals(faultMode)) {
                                Process.killProcess(Process.myPid());
                                throw new AssertionError("Process kill returned");
                            }
                            db.setTransactionSuccessful();
                        }
                    }
                }
            } finally {
                db.endTransaction();
            }
        }

        if (rejectError != null) {
            return rejected(rejectError);
        }
        if ("after_commit_drop_reply".equals(faultMode) && !replayed) {
            Process.killProcess(Process.myPid());
            throw new AssertionError("Process kill returned");
        }
        JSObject ok = new JSObject();
        ok.put("accepted", true);
        ok.put("kind", "committed");
        ok.put("replayed", replayed);
        ok.put("effect", "changed");
        ok.put("result_revision_id", resultRevisionId);
        return ok;
    }

    static JSObject executeNotesPatch(
            File dir,
            String rawCommandJson,
            String canonicalIntentJson
    ) throws Exception {
        JSONObject command = new JSONObject(rawCommandJson);
        if (!"p1-host-control-1".equals(command.optString("profile"))
                || !"expense.patch".equals(command.optString("kind"))) {
            return rejected("unsupported_command");
        }
        JSONObject op = command.getJSONObject("operation");
        JSONObject target = command.getJSONObject("target");
        JSONObject payload = command.getJSONObject("payload");

        String datasetId = op.getString("dataset_id");
        String sourceDeviceId = op.getString("source_device_id");
        String operationId = op.getString("operation_id");
        String entityId = target.getString("entity_id");
        String expectedRevisionId = command.getString("expected_revision_id");
        String notes = payload.getString("notes");

        String resultRevisionId = null;
        boolean replayed = false;
        String rejectError = null;

        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
                try (Cursor row = db.rawQuery(
                        "SELECT intent_json, result_revision_id FROM receipts "
                                + "WHERE dataset_id=? AND source_device_id=? AND operation_id=?",
                        new String[]{datasetId, sourceDeviceId, operationId})) {
                    if (row.moveToFirst()) {
                        if (!canonicalIntentJson.equals(row.getString(0))) {
                            rejectError = "intent_conflict";
                        } else {
                            replayed = true;
                            resultRevisionId = row.getString(1);
                        }
                    }
                }
                if (rejectError == null && !replayed) {
                    String currentHead = DatabaseUtils.stringForQuery(
                            db, "SELECT head_revision_id FROM branch_head WHERE id=1", null);
                    if (!expectedRevisionId.equals(currentHead)) {
                        rejectError = "baseline_conflict";
                    } else if (BridgeLedgerStore.queryLong(
                            db, "SELECT count(*) FROM expenses WHERE entity_id=?", new String[]{entityId}) == 0) {
                        rejectError = "entity_missing";
                    } else {
                        resultRevisionId = "fixture-" + UUID.randomUUID().toString();
                        db.execSQL("UPDATE expenses SET notes=? WHERE entity_id=?", new Object[]{notes, entityId});
                        String snapshotJson = buildSnapshotJson(db);
                        db.execSQL(
                                "INSERT INTO revisions(revision_id, parent_revision_id, snapshot_json) VALUES(?,?,?)",
                                new Object[]{resultRevisionId, currentHead, snapshotJson});
                        db.execSQL("UPDATE branch_head SET head_revision_id=? WHERE id=1", new Object[]{resultRevisionId});
                        db.execSQL(
                                "INSERT INTO receipts(dataset_id, source_device_id, operation_id, intent_json, effect, result_revision_id) "
                                        + "VALUES(?,?,?,?,?,?)",
                                new Object[]{datasetId, sourceDeviceId, operationId, canonicalIntentJson, "changed", resultRevisionId});
                        db.execSQL(
                                "INSERT INTO outbox(dataset_id, source_device_id, operation_id, result_revision_id) VALUES(?,?,?,?)",
                                new Object[]{datasetId, sourceDeviceId, operationId, resultRevisionId});
                        db.setTransactionSuccessful();
                    }
                }
            } finally {
                db.endTransaction();
            }
        }
        if (rejectError != null) {
            return rejected(rejectError);
        }
        JSObject ok = new JSObject();
        ok.put("accepted", true);
        ok.put("kind", "committed");
        ok.put("replayed", replayed);
        ok.put("effect", "changed");
        ok.put("result_revision_id", resultRevisionId);
        return ok;
    }

    static JSObject lookupReceipt(
            File dir,
            JSObject principal,
            String datasetId,
            String sourceDeviceId,
            String operationId,
            AtomicLong receiptReadCounter
    ) throws Exception {
        // Synthetic principal/permission gate happens strictly before any receipt table read.
        boolean authenticated = principal != null && Boolean.TRUE.equals(principal.getBool("authenticated"));
        boolean canQuery = principal != null && Boolean.TRUE.equals(principal.getBool("can_query"));
        String principalDataset = principal != null ? principal.getString("dataset_id", "") : "";
        String principalDevice = principal != null ? principal.getString("source_device_id", "") : "";
        if (!authenticated || !canQuery
                || !datasetId.equals(principalDataset)
                || !sourceDeviceId.equals(principalDevice)) {
            return rejected("denied");
        }

        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            try {
                db.beginTransactionNonExclusive();
                try {
                    receiptReadCounter.incrementAndGet();
                    try (Cursor row = db.rawQuery(
                            "SELECT effect, result_revision_id FROM receipts "
                                    + "WHERE dataset_id=? AND source_device_id=? AND operation_id=?",
                            new String[]{datasetId, sourceDeviceId, operationId})) {
                        JSObject result = new JSObject();
                        result.put("accepted", true);
                        if (!row.moveToFirst()) {
                            result.put("state", "not_found_at_settled_read");
                        } else {
                            JSObject receipt = new JSObject();
                            receipt.put("effect", row.getString(0));
                            receipt.put("result_revision_id", row.getString(1));
                            result.put("state", "committed");
                            result.put("receipt", receipt);
                        }
                        return result;
                    }
                } finally {
                    db.endTransaction();
                }
            } catch (SQLiteDatabaseLockedException busy) {
                JSObject result = new JSObject();
                result.put("accepted", true);
                result.put("state", "pending_busy");
                return result;
            }
        }
    }

    static JSObject inspectState(File dir, long receiptReadCount) throws Exception {
        JSObject data = new JSObject();
        data.put("callerPid", Process.myPid());
        data.put("receiptReadCount", receiptReadCount);
        if (!dir.isDirectory() || !new File(dir, "store.db").isFile()) {
            data.put("seeded", false);
            data.put("headRevisionId", JSONObject.NULL);
            data.put("expenses", new JSArray());
            data.put("revisionCount", 0);
            data.put("receiptCount", 0);
            data.put("outboxCount", 0);
            data.put("receipts", new JSArray());
            data.put("outbox", new JSArray());
            data.put("journal", "");
            data.put("sqlite", "");
            return data;
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            data.put("seeded", true);
            data.put("headRevisionId", DatabaseUtils.stringForQuery(db, "SELECT head_revision_id FROM branch_head WHERE id=1", null));
            data.put("revisionCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM revisions", null));
            data.put("receiptCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM receipts", null));
            data.put("outboxCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM outbox", null));

            JSArray expenses = new JSArray();
            try (Cursor rows = db.rawQuery(
                    "SELECT entity_id, title, amount_cents, currency, paid_on, category, day, activity_id, "
                            + "notes, receipt_ids_json, allow_shared_receipts, budget_item_id, settles_budget "
                            + "FROM expenses ORDER BY entity_id", null)) {
                while (rows.moveToNext()) {
                    JSObject item = new JSObject();
                    item.put("id", rows.getString(0));
                    item.put("title", rows.getString(1));
                    item.put("amount_cents", rows.getLong(2));
                    item.put("currency", rows.getString(3));
                    item.put("paid_on", rows.isNull(4) ? JSONObject.NULL : rows.getString(4));
                    item.put("category", rows.getString(5));
                    item.put("day", rows.isNull(6) ? JSONObject.NULL : rows.getInt(6));
                    item.put("activity_id", rows.isNull(7) ? JSONObject.NULL : rows.getString(7));
                    item.put("notes", rows.getString(8));
                    item.put("receipt_ids", new JSONArray(rows.getString(9)));
                    item.put("allow_shared_receipts", rows.getInt(10) != 0);
                    item.put("budget_item_id", rows.isNull(11) ? JSONObject.NULL : rows.getString(11));
                    item.put("settles_budget", rows.getInt(12) != 0);
                    expenses.put(item);
                }
            }
            data.put("expenses", expenses);

            JSArray receipts = new JSArray();
            try (Cursor rows = db.rawQuery(
                    "SELECT dataset_id, source_device_id, operation_id, intent_json, effect, result_revision_id "
                            + "FROM receipts ORDER BY rowid", null)) {
                while (rows.moveToNext()) {
                    JSObject item = new JSObject();
                    item.put("dataset_id", rows.getString(0));
                    item.put("source_device_id", rows.getString(1));
                    item.put("operation_id", rows.getString(2));
                    item.put("intent_json", rows.getString(3));
                    item.put("effect", rows.getString(4));
                    item.put("result_revision_id", rows.getString(5));
                    receipts.put(item);
                }
            }
            data.put("receipts", receipts);

            JSArray outbox = new JSArray();
            try (Cursor rows = db.rawQuery(
                    "SELECT dataset_id, source_device_id, operation_id, result_revision_id FROM outbox ORDER BY rowid",
                    null)) {
                while (rows.moveToNext()) {
                    JSObject item = new JSObject();
                    item.put("dataset_id", rows.getString(0));
                    item.put("source_device_id", rows.getString(1));
                    item.put("operation_id", rows.getString(2));
                    item.put("result_revision_id", rows.getString(3));
                    outbox.put(item);
                }
            }
            data.put("outbox", outbox);
            data.put("journal", DatabaseUtils.stringForQuery(db, "PRAGMA journal_mode", null));
            data.put("sqlite", DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null));
        }
        return data;
    }

    private static String buildSnapshotJson(SQLiteDatabase db) throws Exception {
        JSONArray list = new JSONArray();
        try (Cursor rows = db.rawQuery(
                "SELECT entity_id, title, amount_cents, currency, paid_on, notes FROM expenses ORDER BY entity_id",
                null)) {
            while (rows.moveToNext()) {
                JSONObject item = new JSONObject();
                item.put("id", rows.getString(0));
                item.put("title", rows.getString(1));
                item.put("amount_cents", rows.getLong(2));
                item.put("currency", rows.getString(3));
                item.put("paid_on", rows.isNull(4) ? JSONObject.NULL : rows.getString(4));
                item.put("notes", rows.getString(5));
                list.put(item);
            }
        }
        return new JSONObject().put("expenses", list).toString();
    }

    private static JSObject rejected(String error) {
        JSObject out = new JSObject();
        out.put("accepted", false);
        out.put("error", error);
        return out;
    }
}
