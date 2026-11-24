package org.travelflow.p1bridge;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.os.Process;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Isolated empty-ledger SQLite store for P1 expense.create Android verification,
 * matching the host desktop-create contract (revisions, expenses, receipts, outbox in one tx).
 */
final class BridgeCreateLedgerStore {
    static final int MAX_BRANCH_EXPENSES = 2000;
    static final int DEFAULT_PAGE_LIMIT = 20;
    private static final java.util.Set<String> VALID_CATEGORIES = new java.util.HashSet<>(
            java.util.Arrays.asList("transport", "lodging", "meal", "ticket", "shopping", "other"));

    private BridgeCreateLedgerStore() {}

    static boolean isCreateScenario(String scenario) {
        return scenario != null && scenario.matches(
                "create-before-commit|create-after-commit|create-conflict-amount|create-conflict-share"
                        + "|create-boundary-fields-scope|create-boundary-over-20|create-boundary-cap-2000");
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

    static void seedWithExpenseCount(
            File dir,
            String datasetId,
            String travelId,
            String branchId,
            String initialRevisionId,
            int initialCount
    ) throws Exception {
        if (initialCount < 0 || initialCount > MAX_BRANCH_EXPENSES) {
            throw new IllegalArgumentException("Invalid initialCount: " + initialCount);
        }
        seedEmpty(dir, datasetId, travelId, branchId, initialRevisionId);
        if (initialCount == 0) {
            return;
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransaction();
            try {
                for (int i = 1; i <= initialCount; i++) {
                    String entityId = String.format(java.util.Locale.US, "fixture-seed-%04d", i);
                    db.execSQL(
                            "INSERT INTO expenses(entity_id, title, amount_cents, currency, paid_on, category, "
                                    + "day, activity_id, notes, receipt_ids_json, allow_shared_receipts, "
                                    + "budget_item_id, settles_budget) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            new Object[]{entityId, "seed", 100L, "CNY", null, "other", null, null, "", "[]", 0, null, 0});
                }
                db.execSQL("UPDATE revisions SET snapshot_json=? WHERE revision_id=?",
                        new Object[]{buildSnapshotJson(db), initialRevisionId});
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

    private static boolean jsonValuesEqual(Object left, Object right) throws Exception {
        boolean leftNull = left == null || left == JSONObject.NULL;
        boolean rightNull = right == null || right == JSONObject.NULL;
        if (leftNull || rightNull) {
            return leftNull && rightNull;
        }
        if (left instanceof JSONObject && right instanceof JSONObject) {
            JSONObject a = (JSONObject) left;
            JSONObject b = (JSONObject) right;
            if (a.length() != b.length()) {
                return false;
            }
            java.util.Iterator<String> keys = a.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!b.has(key) || !jsonValuesEqual(a.opt(key), b.opt(key))) {
                    return false;
                }
            }
            return true;
        }
        if (left instanceof JSONArray && right instanceof JSONArray) {
            JSONArray a = (JSONArray) left;
            JSONArray b = (JSONArray) right;
            if (a.length() != b.length()) {
                return false;
            }
            for (int i = 0; i < a.length(); i++) {
                if (!jsonValuesEqual(a.opt(i), b.opt(i))) {
                    return false;
                }
            }
            return true;
        }
        if ((left instanceof Integer || left instanceof Long) && (right instanceof Integer || right instanceof Long)) {
            return ((Number) left).longValue() == ((Number) right).longValue();
        }
        return left.getClass().equals(right.getClass()) && left.equals(right);
    }

    private static boolean canonicalMatchesCommand(JSONObject rawCommand, String canonicalIntentJson) {
        try {
            JSONObject doc = new JSONObject(canonicalIntentJson);
            if (!"p1-host-intent-c14n-1".equals(doc.optString("canonical_profile"))
                    || !"control".equals(doc.optString("channel"))) {
                return false;
            }
            JSONObject canonicalIntent = doc.optJSONObject("intent");
            return canonicalIntent != null && jsonValuesEqual(rawCommand, canonicalIntent);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isAuthorizedWriter(JSObject principal, String datasetId, String sourceDeviceId) {
        if (principal == null) {
            return false;
        }
        boolean authenticated = Boolean.TRUE.equals(principal.getBool("authenticated"));
        boolean canWrite = Boolean.TRUE.equals(principal.getBool("can_write"));
        String principalDataset = principal.getString("dataset_id", "");
        String principalDevice = principal.getString("source_device_id", "");
        return authenticated && canWrite
                && datasetId.equals(principalDataset)
                && sourceDeviceId.equals(principalDevice);
    }

    private static String validateExchangeableCapabilities(JSONObject payload) throws Exception {
        String currency = payload.isNull("currency") ? null : payload.optString("currency", null);
        if (!"CNY".equals(currency)) {
            return "unsupported_capability";
        }
        if (!payload.isNull("paid_on")) {
            return "unsupported_capability";
        }
        Object rawCategory = payload.opt("category");
        if (!(rawCategory instanceof String)) {
            return "type";
        }
        if (!VALID_CATEGORIES.contains(rawCategory)) {
            return "invalid_field";
        }
        if (!payload.isNull("day")) {
            return "unsupported_capability";
        }
        if (!payload.isNull("activity_id")) {
            return "unsupported_capability";
        }
        Object rawReceipts = payload.opt("receipt_ids");
        if (!(rawReceipts instanceof JSONArray)) {
            return "type";
        }
        if (((JSONArray) rawReceipts).length() != 0) {
            return "unsupported_capability";
        }
        Object rawAllowShared = payload.opt("allow_shared_receipts");
        if (!(rawAllowShared instanceof Boolean)) {
            return "type";
        }
        if (!payload.isNull("budget_item_id")) {
            return "unsupported_capability";
        }
        Object rawSettles = payload.opt("settles_budget");
        if (!(rawSettles instanceof Boolean)) {
            return "type";
        }
        if (Boolean.TRUE.equals(rawSettles)) {
            return "invalid_field";
        }
        return null;
    }

    static JSObject executeCreate(
            File dir,
            JSObject principal,
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

        if (!isAuthorizedWriter(principal, datasetId, sourceDeviceId)) {
            return rejected("denied");
        }

        long[] parsedCents = new long[1];
        String amountError = validateAmountCents(payload, parsedCents);
        if (amountError != null) {
            return rejected(amountError);
        }
        if (!canonicalMatchesCommand(command, canonicalIntentJson)) {
            return rejected("intent_mismatch");
        }
        long amountCents = parsedCents[0];
        String title = payload.getString("title");
        String notes = payload.getString("notes");

        String resultRevisionId = null;
        boolean replayed = false;
        String rejectError = null;

        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
                // Enforce target dataset/travel/branch scope strictly before reading receipts or replaying.
                String currentHead = readHeadIfScopeMatches(db, datasetId, travelId, branchId);
                if (currentHead == null) {
                    rejectError = "scope_mismatch";
                }

                // Check durable receipt next: valid-scope replays return the original revision even after head advances or cap is full.
                if (rejectError == null) {
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
                }

                if (rejectError == null && !replayed) {
                    rejectError = validateExchangeableCapabilities(payload);
                }

                if (rejectError == null && !replayed) {
                    if (!expectedRevisionId.equals(currentHead)) {
                        rejectError = "baseline_conflict";
                    } else if (BridgeLedgerStore.queryLong(
                            db, "SELECT count(*) FROM expenses WHERE entity_id=?", new String[]{entityId}) > 0) {
                        rejectError = "entity_exists";
                    } else if (BridgeLedgerStore.queryLong(
                            db, "SELECT count(*) FROM expenses", null) >= MAX_BRANCH_EXPENSES) {
                        rejectError = "expense_count";
                    } else {
                        String currency = payload.getString("currency");
                        String paidOn = payload.isNull("paid_on") ? null : payload.getString("paid_on");
                        String category = payload.getString("category");
                        Integer day = payload.isNull("day") ? null : payload.getInt("day");
                        String activityId = payload.isNull("activity_id") ? null : payload.getString("activity_id");
                        JSONArray receiptIds = payload.getJSONArray("receipt_ids");
                        boolean allowSharedReceipts = payload.getBoolean("allow_shared_receipts");
                        String budgetItemId = payload.isNull("budget_item_id") ? null : payload.getString("budget_item_id");
                        boolean settlesBudget = payload.getBoolean("settles_budget");

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
            JSObject principal,
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
        if (!isAuthorizedWriter(principal, datasetId, sourceDeviceId)) {
            return rejected("denied");
        }
        if (!canonicalMatchesCommand(command, canonicalIntentJson)) {
            return rejected("intent_mismatch");
        }
        String operationId = op.getString("operation_id");
        String travelId = target.getString("travel_id");
        String branchId = target.getString("branch_id");
        String entityId = target.getString("entity_id");
        String expectedRevisionId = command.getString("expected_revision_id");
        String notes = payload.getString("notes");

        String resultRevisionId = null;
        boolean replayed = false;
        String rejectError = null;

        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
                // Enforce target dataset/travel/branch scope strictly before reading receipts.
                String currentHead = readHeadIfScopeMatches(db, datasetId, travelId, branchId);
                if (currentHead == null) {
                    rejectError = "scope_mismatch";
                }

                if (rejectError == null) {
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
                }
                if (rejectError == null && !replayed) {
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
            String expectedCanonicalIntentJson,
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
                            "SELECT intent_json, effect, result_revision_id FROM receipts "
                                    + "WHERE dataset_id=? AND source_device_id=? AND operation_id=?",
                            new String[]{datasetId, sourceDeviceId, operationId})) {
                        JSObject result = new JSObject();
                        if (!row.moveToFirst()) {
                            result.put("accepted", true);
                            result.put("state", "not_found_at_settled_read");
                        } else if (expectedCanonicalIntentJson != null
                                && !expectedCanonicalIntentJson.isEmpty()
                                && !expectedCanonicalIntentJson.equals(row.getString(0))) {
                            return rejected("intent_conflict");
                        } else {
                            JSObject receipt = new JSObject();
                            receipt.put("effect", row.getString(1));
                            receipt.put("result_revision_id", row.getString(2));
                            result.put("accepted", true);
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

    static JSObject inspectState(File dir, long receiptReadCount, int pageOffset, int pageLimit) throws Exception {
        int safeOffset = Math.max(0, pageOffset);
        int safeLimit = pageLimit <= 0 ? DEFAULT_PAGE_LIMIT : Math.min(pageLimit, 200);
        JSObject data = new JSObject();
        data.put("callerPid", Process.myPid());
        data.put("receiptReadCount", receiptReadCount);
        data.put("pageOffset", safeOffset);
        data.put("pageLimit", safeLimit);
        if (!dir.isDirectory() || !new File(dir, "store.db").isFile()) {
            data.put("seeded", false);
            data.put("headRevisionId", JSONObject.NULL);
            data.put("expenseCount", 0);
            data.put("totalCents", 0L);
            data.put("expenses", new JSArray());
            data.put("hasMoreExpenses", false);
            data.put("revisions", new JSArray());
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
            long expenseCount = BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM expenses", null);
            long totalCents = BridgeLedgerStore.queryLong(db, "SELECT COALESCE(SUM(amount_cents), 0) FROM expenses", null);
            data.put("expenseCount", expenseCount);
            data.put("totalCents", totalCents);
            data.put("revisionCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM revisions", null));
            data.put("receiptCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM receipts", null));
            data.put("outboxCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM outbox", null));

            JSONArray pageExpenses = readExpensesPage(db, safeOffset, safeLimit);
            data.put("expenses", pageExpenses);
            data.put("hasMoreExpenses", safeOffset + pageExpenses.length() < expenseCount);

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

            JSArray revisions = new JSArray();
            try (Cursor rows = db.rawQuery(
                    "SELECT revision_id, parent_revision_id, snapshot_json FROM revisions ORDER BY seq",
                    null)) {
                while (rows.moveToNext()) {
                    String rawSnapshot = rows.getString(2);
                    JSONObject parsed = new JSONObject(rawSnapshot);
                    JSONArray snapshotExpenses = parsed.getJSONArray("expenses");
                    long revTotalCents = 0L;
                    for (int i = 0; i < snapshotExpenses.length(); i++) {
                        revTotalCents += snapshotExpenses.getJSONObject(i).getLong("amount_cents");
                    }
                    JSObject item = new JSObject();
                    item.put("revision_id", rows.getString(0));
                    item.put("parent_revision_id", rows.isNull(1) ? JSONObject.NULL : rows.getString(1));
                    item.put("expense_count", snapshotExpenses.length());
                    item.put("total_cents", revTotalCents);
                    item.put("snapshot_sha256", sha256Hex(rawSnapshot));
                    if (snapshotExpenses.length() <= 25) {
                        item.put("snapshot", parsed);
                    }
                    revisions.put(item);
                }
            }
            data.put("revisions", revisions);
            data.put("journal", DatabaseUtils.stringForQuery(db, "PRAGMA journal_mode", null));
            data.put("sqlite", DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null));
        }
        return data;
    }

    static JSObject readRevisionPage(File dir, String revisionId, int offset, int limit) throws Exception {
        int safeOffset = Math.max(0, offset);
        int safeLimit = limit <= 0 ? DEFAULT_PAGE_LIMIT : Math.min(limit, 200);
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            try (Cursor row = db.rawQuery(
                    "SELECT parent_revision_id, snapshot_json FROM revisions WHERE revision_id=?",
                    new String[]{revisionId})) {
                if (!row.moveToFirst()) {
                    return rejected("revision_not_found");
                }
                String rawSnapshot = row.getString(1);
                JSONObject parsed = new JSONObject(rawSnapshot);
                JSONArray all = parsed.getJSONArray("expenses");
                long totalCents = 0L;
                for (int i = 0; i < all.length(); i++) {
                    totalCents += all.getJSONObject(i).getLong("amount_cents");
                }
                JSONArray page = new JSONArray();
                int end = Math.min(all.length(), safeOffset + safeLimit);
                for (int i = safeOffset; i < end; i++) {
                    page.put(all.getJSONObject(i));
                }
                JSObject out = new JSObject();
                out.put("accepted", true);
                out.put("revision_id", revisionId);
                out.put("parent_revision_id", row.isNull(0) ? JSONObject.NULL : row.getString(0));
                out.put("expense_count", all.length());
                out.put("total_cents", totalCents);
                out.put("snapshot_sha256", sha256Hex(rawSnapshot));
                out.put("offset", safeOffset);
                out.put("limit", safeLimit);
                out.put("has_more", end < all.length());
                out.put("expenses", page);
                return out;
            }
        }
    }

    private static String readHeadIfScopeMatches(
            SQLiteDatabase db,
            String datasetId,
            String travelId,
            String branchId
    ) {
        try (Cursor headRow = db.rawQuery(
                "SELECT dataset_id, travel_id, branch_id, head_revision_id FROM branch_head WHERE id=1",
                null)) {
            if (!headRow.moveToFirst()) {
                throw new IllegalStateException("Missing branch_head row");
            }
            if (!datasetId.equals(headRow.getString(0))
                    || !travelId.equals(headRow.getString(1))
                    || !branchId.equals(headRow.getString(2))) {
                return null;
            }
            return headRow.getString(3);
        }
    }

    private static String buildSnapshotJson(SQLiteDatabase db) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"expenses\":[");
        boolean first = true;
        try (Cursor rows = db.rawQuery(
                "SELECT entity_id, title, amount_cents, currency, paid_on, category, day, activity_id, "
                        + "notes, receipt_ids_json, budget_item_id, settles_budget "
                        + "FROM expenses ORDER BY entity_id",
                null)) {
            while (rows.moveToNext()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append("{\"id\":");
                appendJsonString(sb, rows.getString(0));
                sb.append(",\"title\":");
                appendJsonString(sb, rows.getString(1));
                sb.append(",\"amount_cents\":").append(rows.getLong(2));
                sb.append(",\"currency\":");
                appendJsonString(sb, rows.getString(3));
                sb.append(",\"paid_on\":");
                if (rows.isNull(4)) sb.append("null"); else appendJsonString(sb, rows.getString(4));
                sb.append(",\"category\":");
                appendJsonString(sb, rows.getString(5));
                sb.append(",\"day\":");
                if (rows.isNull(6)) sb.append("null"); else sb.append(rows.getInt(6));
                sb.append(",\"activity_id\":");
                if (rows.isNull(7)) sb.append("null"); else appendJsonString(sb, rows.getString(7));
                sb.append(",\"notes\":");
                appendJsonString(sb, rows.getString(8));
                sb.append(",\"receipt_ids\":").append(rows.getString(9));
                sb.append(",\"budget_item_id\":");
                if (rows.isNull(10)) sb.append("null"); else appendJsonString(sb, rows.getString(10));
                sb.append(",\"settles_budget\":").append(rows.getInt(11) != 0 ? "true" : "false");
                sb.append('}');
            }
        }
        sb.append("]}");
        return sb.toString();
    }

    private static void appendJsonString(StringBuilder sb, String value) {
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        sb.append(String.format(java.util.Locale.US, "\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
                    break;
            }
        }
        sb.append('"');
    }

    private static String sha256Hex(String text) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
        }
        return hex.toString();
    }

    private static JSONArray readExpensesPage(SQLiteDatabase db, int offset, int limit) throws Exception {
        JSONArray list = new JSONArray();
        try (Cursor rows = db.rawQuery(
                "SELECT entity_id, title, amount_cents, currency, paid_on, category, day, activity_id, "
                        + "notes, receipt_ids_json, budget_item_id, settles_budget "
                        + "FROM expenses ORDER BY entity_id LIMIT ? OFFSET ?",
                new String[]{String.valueOf(limit), String.valueOf(offset)})) {
            while (rows.moveToNext()) {
                JSONObject item = new JSONObject();
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
                item.put("budget_item_id", rows.isNull(10) ? JSONObject.NULL : rows.getString(10));
                item.put("settles_budget", rows.getInt(11) != 0);
                list.put(item);
            }
        }
        return list;
    }

    private static JSObject rejected(String error) {
        JSObject out = new JSObject();
        out.put("accepted", false);
        out.put("error", error);
        return out;
    }
}
