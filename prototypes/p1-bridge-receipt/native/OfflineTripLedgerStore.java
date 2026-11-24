package org.travelflow.p1bridge;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.os.Process;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Isolated offline travel ledger store for Work Package D sender-side entry:
 * commits expense, revision, durable receipt and pending-send 0.1.0 command in one SQLite transaction.
 */
final class OfflineTripLedgerStore {
    static final String CONTRACT_ID = "travelflow.expense-create";
    static final String CONTRACT_VERSION = "0.1.0";
    static final String DELIVERY_STATE_PENDING_SEND = "pending_send";
    static final int MAX_BRANCH_EXPENSES = 2000;
    static final int MAX_CANONICAL_BYTES = 65536;
    private static final Set<String> VALID_CATEGORIES = new HashSet<>(
            Arrays.asList("transport", "lodging", "meal", "ticket", "shopping", "other"));
    private static final Set<String> COMMAND_KEYS = new HashSet<>(
            Arrays.asList("profile", "kind", "operation", "target", "expected_revision_id", "payload"));
    private static final Set<String> OPERATION_KEYS = new HashSet<>(
            Arrays.asList("dataset_id", "source_device_id", "operation_id"));
    private static final Set<String> TARGET_KEYS = new HashSet<>(
            Arrays.asList("travel_id", "branch_id", "entity_id"));
    private static final Set<String> PAYLOAD_KEYS = new HashSet<>(Arrays.asList(
            "title", "amount_cents", "currency", "paid_on", "category", "day",
            "activity_id", "notes", "receipt_ids", "allow_shared_receipts",
            "budget_item_id", "settles_budget"));
    private static final Set<Integer> TITLE_WHITESPACE = new HashSet<>(Arrays.asList(
            0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
            0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000));

    private OfflineTripLedgerStore() {}

    static File ledgerDir(File filesDir) {
        return new File(filesDir, "p1-offline-trip-ledger");
    }

    static void ensureInitialized(
            File dir,
            String datasetId,
            String travelId,
            String branchId,
            String initialRevisionId,
            String baselineSource
    ) throws Exception {
        if (dir.isDirectory() && new File(dir, "store.db").isFile()) {
            return;
        }
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Failed to create offline trip ledger directory");
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, true)) {
            db.beginTransaction();
            try {
                db.execSQL("CREATE TABLE IF NOT EXISTS branch_head("
                        + "id INTEGER PRIMARY KEY CHECK(id=1), "
                        + "dataset_id TEXT NOT NULL, "
                        + "travel_id TEXT NOT NULL, "
                        + "branch_id TEXT NOT NULL, "
                        + "head_revision_id TEXT NOT NULL, "
                        + "baseline_source TEXT NOT NULL)");
                db.execSQL("CREATE TABLE IF NOT EXISTS revisions("
                        + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                        + "revision_id TEXT NOT NULL UNIQUE, "
                        + "parent_revision_id TEXT, "
                        + "snapshot_json TEXT NOT NULL)");
                db.execSQL("CREATE TABLE IF NOT EXISTS expenses("
                        + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                        + "entity_id TEXT NOT NULL UNIQUE, "
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
                        + "settles_budget INTEGER NOT NULL, "
                        + "operation_id TEXT NOT NULL)");
                db.execSQL("CREATE TABLE IF NOT EXISTS receipts("
                        + "dataset_id TEXT NOT NULL, "
                        + "source_device_id TEXT NOT NULL, "
                        + "operation_id TEXT NOT NULL, "
                        + "intent_json TEXT NOT NULL, "
                        + "effect TEXT NOT NULL, "
                        + "result_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), "
                        + "PRIMARY KEY(dataset_id, source_device_id, operation_id))");
                db.execSQL("CREATE TABLE IF NOT EXISTS outbox("
                        + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                        + "dataset_id TEXT NOT NULL, "
                        + "source_device_id TEXT NOT NULL, "
                        + "operation_id TEXT NOT NULL, "
                        + "entity_id TEXT NOT NULL, "
                        + "expected_revision_id TEXT NOT NULL, "
                        + "result_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), "
                        + "raw_command_json TEXT NOT NULL, "
                        + "canonical_intent_json TEXT NOT NULL, "
                        + "intent_sha256 TEXT NOT NULL, "
                        + "delivery_state TEXT NOT NULL, "
                        + "UNIQUE(dataset_id, source_device_id, operation_id), "
                        + "FOREIGN KEY(dataset_id, source_device_id, operation_id) "
                        + "REFERENCES receipts(dataset_id, source_device_id, operation_id))");

                long headCount = BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM branch_head", null);
                if (headCount == 0) {
                    db.execSQL("INSERT INTO revisions(revision_id, parent_revision_id, snapshot_json) VALUES(?,?,?)",
                            new Object[]{initialRevisionId, null, "{\"expenses\":[]}"});
                    db.execSQL("INSERT INTO branch_head VALUES(1,?,?,?,?,?)",
                            new Object[]{datasetId, travelId, branchId, initialRevisionId, baselineSource});
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
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
            Iterator<String> keys = a.keys();
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

    private static final class StrictJsonError extends Exception {
        final String code;

        StrictJsonError(String code) {
            super(code);
            this.code = code;
        }
    }

    private static final class StrictJsonParser {
        private static final int MAX_DEPTH = 16;
        private final String src;
        private int pos = 0;

        StrictJsonParser(String src) {
            this.src = src;
        }

        Object parseDocument() throws StrictJsonError {
            skipWs();
            Object val = parseValue(0);
            skipWs();
            if (pos != src.length()) {
                throw new StrictJsonError("invalid_json");
            }
            return val;
        }

        private void skipWs() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    break;
                }
            }
        }

        private Object parseValue(int depth) throws StrictJsonError {
            if (depth > MAX_DEPTH) {
                throw new StrictJsonError("invalid_json");
            }
            if (pos >= src.length()) {
                throw new StrictJsonError("invalid_json");
            }
            char c = src.charAt(pos);
            if (c == '{') return parseObject(depth + 1);
            if (c == '[') return parseArray(depth + 1);
            if (c == '"') return parseString();
            if (c == 't') return parseLiteral("true", Boolean.TRUE);
            if (c == 'f') return parseLiteral("false", Boolean.FALSE);
            if (c == 'n') return parseLiteral("null", null);
            if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
            throw new StrictJsonError("invalid_json");
        }

        private Map<String, Object> parseObject(int depth) throws StrictJsonError {
            pos++; // '{'
            skipWs();
            TreeMap<String, Object> map = new TreeMap<>();
            if (pos < src.length() && src.charAt(pos) == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWs();
                if (pos >= src.length() || src.charAt(pos) != '"') {
                    throw new StrictJsonError("invalid_json");
                }
                String key = parseString();
                if (map.containsKey(key)) {
                    throw new StrictJsonError("duplicate_key");
                }
                skipWs();
                if (pos >= src.length() || src.charAt(pos) != ':') {
                    throw new StrictJsonError("invalid_json");
                }
                pos++;
                skipWs();
                Object value = parseValue(depth);
                map.put(key, value);
                skipWs();
                if (pos >= src.length()) {
                    throw new StrictJsonError("invalid_json");
                }
                char next = src.charAt(pos++);
                if (next == '}') {
                    return map;
                }
                if (next != ',') {
                    throw new StrictJsonError("invalid_json");
                }
            }
        }

        private List<Object> parseArray(int depth) throws StrictJsonError {
            pos++; // '['
            skipWs();
            List<Object> list = new ArrayList<>();
            if (pos < src.length() && src.charAt(pos) == ']') {
                pos++;
                return list;
            }
            while (true) {
                skipWs();
                list.add(parseValue(depth));
                skipWs();
                if (pos >= src.length()) {
                    throw new StrictJsonError("invalid_json");
                }
                char next = src.charAt(pos++);
                if (next == ']') {
                    return list;
                }
                if (next != ',') {
                    throw new StrictJsonError("invalid_json");
                }
            }
        }

        private String parseString() throws StrictJsonError {
            pos++; // '"'
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') {
                    String result = sb.toString();
                    for (int i = 0; i < result.length(); ) {
                        int cp = result.codePointAt(i);
                        if (cp >= 0xD800 && cp <= 0xDFFF) {
                            throw new StrictJsonError("unicode");
                        }
                        i += Character.charCount(cp);
                    }
                    return result;
                }
                if (c < 0x20) {
                    throw new StrictJsonError("invalid_json");
                }
                if (c == '\\') {
                    if (pos >= src.length()) {
                        throw new StrictJsonError("invalid_json");
                    }
                    char esc = src.charAt(pos++);
                    switch (esc) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u': {
                            if (pos + 4 > src.length()) {
                                throw new StrictJsonError("invalid_json");
                            }
                            int code = 0;
                            for (int i = 0; i < 4; i++) {
                                int digit = Character.digit(src.charAt(pos++), 16);
                                if (digit < 0) {
                                    throw new StrictJsonError("invalid_json");
                                }
                                code = (code << 4) | digit;
                            }
                            sb.append((char) code);
                            break;
                        }
                        default:
                            throw new StrictJsonError("invalid_json");
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new StrictJsonError("invalid_json");
        }

        private Object parseLiteral(String literal, Object value) throws StrictJsonError {
            if (!src.startsWith(literal, pos)) {
                throw new StrictJsonError("invalid_json");
            }
            pos += literal.length();
            return value;
        }

        private Number parseNumber() throws StrictJsonError {
            int start = pos;
            if (src.charAt(pos) == '-') {
                pos++;
                if (pos >= src.length()) {
                    throw new StrictJsonError("invalid_json");
                }
            }
            if (src.charAt(pos) == '0') {
                pos++;
                if (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') {
                    throw new StrictJsonError("invalid_json");
                }
            } else if (src.charAt(pos) >= '1' && src.charAt(pos) <= '9') {
                while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') {
                    pos++;
                }
            } else {
                throw new StrictJsonError("invalid_json");
            }
            boolean isFloat = false;
            if (pos < src.length() && src.charAt(pos) == '.') {
                isFloat = true;
                pos++;
                if (pos >= src.length() || src.charAt(pos) < '0' || src.charAt(pos) > '9') {
                    throw new StrictJsonError("invalid_json");
                }
                while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') {
                    pos++;
                }
            }
            if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                isFloat = true;
                pos++;
                if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) {
                    pos++;
                }
                if (pos >= src.length() || src.charAt(pos) < '0' || src.charAt(pos) > '9') {
                    throw new StrictJsonError("invalid_json");
                }
                while (pos < src.length() && src.charAt(pos) >= '0' && src.charAt(pos) <= '9') {
                    pos++;
                }
            }
            String token = src.substring(start, pos);
            if (isFloat) {
                return Double.valueOf(token);
            }
            BigInteger bi = new BigInteger(token);
            if (bi.compareTo(BigInteger.valueOf(Long.MIN_VALUE)) >= 0
                    && bi.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0) {
                return Long.valueOf(bi.longValue());
            }
            return bi;
        }
    }

    private static void appendCanonicalValue(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof Boolean) {
            sb.append(((Boolean) value) ? "true" : "false");
        } else if (value instanceof Long) {
            sb.append(((Long) value).longValue());
        } else if (value instanceof String) {
            appendJsonString(sb, (String) value);
        } else if (value instanceof List<?>) {
            sb.append('[');
            List<?> list = (List<?>) value;
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(',');
                appendCanonicalValue(sb, list.get(i));
            }
            sb.append(']');
        } else if (value instanceof Map<?, ?>) {
            sb.append('{');
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            TreeMap<String, Object> sorted = new TreeMap<>(map);
            boolean first = true;
            for (Map.Entry<String, Object> entry : sorted.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                appendJsonString(sb, entry.getKey());
                sb.append(':');
                appendCanonicalValue(sb, entry.getValue());
            }
            sb.append('}');
        } else {
            throw new IllegalArgumentException("Unsupported canonical value");
        }
    }

    private static String canonicalizeControlDocument(Map<String, Object> command) {
        TreeMap<String, Object> doc = new TreeMap<>();
        doc.put("canonical_profile", "p1-host-intent-c14n-1");
        doc.put("channel", "control");
        doc.put("intent", command);
        StringBuilder sb = new StringBuilder();
        appendCanonicalValue(sb, doc);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asObject(Object raw) {
        return raw instanceof Map<?, ?> ? (Map<String, Object>) raw : null;
    }

    private static boolean hasExactKeys(Map<String, Object> obj, Set<String> expected) {
        return obj != null && obj.size() == expected.size() && expected.containsAll(obj.keySet());
    }

    private static String validateIdentifier(Map<String, Object> obj, String key) {
        Object raw = obj.get(key);
        if (!(raw instanceof String)) {
            return null;
        }
        String value = (String) raw;
        int scalars = 0;
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            if (cp >= 0xD800 && cp <= 0xDFFF) {
                return null;
            }
            if (cp < 0x20 || cp == 0xFEFF || (cp >= 0x7F && cp <= 0x9F)) {
                return null;
            }
            scalars++;
            i += Character.charCount(cp);
        }
        if (scalars == 0 || scalars > 128
                || value.getBytes(StandardCharsets.UTF_8).length > 128) {
            return null;
        }
        return value;
    }

    private static String validateTextField(Object raw, int maxScalars, boolean isTitle) {
        if (!(raw instanceof String)) {
            return "type";
        }
        String value = (String) raw;
        int scalars = 0;
        boolean hasNonWhitespace = false;
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            if (cp >= 0xD800 && cp <= 0xDFFF) {
                return "unicode";
            }
            if (cp == 0xFEFF || (cp >= 0x7F && cp <= 0x9F)
                    || (cp < 0x20 && (isTitle || (cp != 9 && cp != 10 && cp != 13)))) {
                return "text_control";
            }
            if (isTitle && !TITLE_WHITESPACE.contains(cp)) {
                hasNonWhitespace = true;
            }
            scalars++;
            i += Character.charCount(cp);
        }
        if (scalars > maxScalars || (isTitle && scalars == 0)) {
            return "text_length";
        }
        if (isTitle && !hasNonWhitespace) {
            return "title_blank";
        }
        return null;
    }

    static JSObject saveOfflineExpense(
            File dir,
            String rawCommandJson,
            String canonicalIntentJson
    ) throws Exception {
        if (rawCommandJson.getBytes(StandardCharsets.UTF_8).length > MAX_CANONICAL_BYTES
                || canonicalIntentJson.getBytes(StandardCharsets.UTF_8).length > MAX_CANONICAL_BYTES) {
            return rejected("canonical_bytes");
        }
        final Object parsedDoc;
        try {
            parsedDoc = new StrictJsonParser(rawCommandJson).parseDocument();
        } catch (StrictJsonError error) {
            return rejected(error.code);
        }
        Map<String, Object> command = asObject(parsedDoc);
        if (!hasExactKeys(command, COMMAND_KEYS)) {
            return rejected("shape");
        }
        if (!"p1-host-control-1".equals(command.get("profile"))
                || !"expense.create".equals(command.get("kind"))) {
            return rejected("unsupported_command");
        }
        Map<String, Object> op = asObject(command.get("operation"));
        Map<String, Object> target = asObject(command.get("target"));
        Map<String, Object> payload = asObject(command.get("payload"));
        if (!hasExactKeys(op, OPERATION_KEYS)
                || !hasExactKeys(target, TARGET_KEYS)
                || !hasExactKeys(payload, PAYLOAD_KEYS)) {
            return rejected("shape");
        }

        String datasetId = validateIdentifier(op, "dataset_id");
        String sourceDeviceId = validateIdentifier(op, "source_device_id");
        String operationId = validateIdentifier(op, "operation_id");
        String travelId = validateIdentifier(target, "travel_id");
        String branchId = validateIdentifier(target, "branch_id");
        String entityId = validateIdentifier(target, "entity_id");
        String expectedRevisionId = validateIdentifier(command, "expected_revision_id");

        if (datasetId == null || sourceDeviceId == null || operationId == null
                || travelId == null || branchId == null || entityId == null
                || expectedRevisionId == null || operationId.equals(entityId)) {
            return rejected("invalid_identity");
        }

        Object rawAmount = payload.get("amount_cents");
        if (!(rawAmount instanceof Number)) {
            return rejected("type");
        }
        if (!(rawAmount instanceof Long)) {
            return rejected("integer_range");
        }
        long amountCents = ((Long) rawAmount).longValue();
        if (!BridgeLedgerStore.isValidAmountCents(amountCents)) {
            return rejected("integer_range");
        }

        String titleError = validateTextField(payload.get("title"), 100, true);
        if (titleError != null) {
            return rejected(titleError);
        }
        String title = (String) payload.get("title");

        String notesError = validateTextField(payload.get("notes"), 1000, false);
        if (notesError != null) {
            return rejected(notesError);
        }
        String notes = (String) payload.get("notes");

        Object rawCurrency = payload.get("currency");
        if (!"CNY".equals(rawCurrency)) {
            return rejected("unsupported_capability");
        }
        String currency = "CNY";
        if (payload.get("paid_on") != null
                || payload.get("day") != null
                || payload.get("activity_id") != null
                || payload.get("budget_item_id") != null) {
            return rejected("unsupported_capability");
        }
        Object rawCategory = payload.get("category");
        if (!(rawCategory instanceof String) || !VALID_CATEGORIES.contains(rawCategory)) {
            return rejected("invalid_field");
        }
        String category = (String) rawCategory;
        Object rawReceipts = payload.get("receipt_ids");
        if (!(rawReceipts instanceof List<?>)) {
            return rejected("type");
        }
        if (!((List<?>) rawReceipts).isEmpty()) {
            return rejected("unsupported_capability");
        }
        Object rawAllowShared = payload.get("allow_shared_receipts");
        Object rawSettles = payload.get("settles_budget");
        if (!(rawAllowShared instanceof Boolean) || !(rawSettles instanceof Boolean)) {
            return rejected("type");
        }
        if (Boolean.TRUE.equals(rawSettles)) {
            return rejected("invalid_field");
        }

        String canonicalVerified = canonicalizeControlDocument(command);
        if (canonicalVerified.getBytes(StandardCharsets.UTF_8).length > MAX_CANONICAL_BYTES) {
            return rejected("canonical_bytes");
        }
        if (!canonicalVerified.equals(canonicalIntentJson)) {
            return rejected("non_canonical_intent");
        }

        boolean allowSharedReceipts = (Boolean) rawAllowShared;
        String intentSha256 = BridgeCreateLedgerStore.sha256Hex(canonicalVerified);

        String resultRevisionId = null;
        boolean replayed = false;
        String rejectError = null;

        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            db.beginTransactionNonExclusive();
            try {
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
                            if (!canonicalVerified.equals(row.getString(0))) {
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
                            db, "SELECT count(*) FROM expenses WHERE entity_id=?", new String[]{entityId}) > 0) {
                        rejectError = "entity_exists";
                    } else if (BridgeLedgerStore.queryLong(
                            db, "SELECT count(*) FROM expenses", null) >= MAX_BRANCH_EXPENSES) {
                        rejectError = "expense_count";
                    } else {
                        resultRevisionId = "local-rev-" + UUID.randomUUID().toString();
                        db.execSQL(
                                "INSERT INTO expenses(entity_id, title, amount_cents, currency, paid_on, category, "
                                        + "day, activity_id, notes, receipt_ids_json, allow_shared_receipts, "
                                        + "budget_item_id, settles_budget, operation_id) "
                                        + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                new Object[]{
                                        entityId,
                                        title,
                                        amountCents,
                                        currency,
                                        null,
                                        category,
                                        null,
                                        null,
                                        notes,
                                        "[]",
                                        allowSharedReceipts ? 1 : 0,
                                        null,
                                        0,
                                        operationId,
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
                                new Object[]{datasetId, sourceDeviceId, operationId, canonicalVerified, "changed", resultRevisionId});
                        db.execSQL(
                                "INSERT INTO outbox(dataset_id, source_device_id, operation_id, entity_id, "
                                        + "expected_revision_id, result_revision_id, raw_command_json, "
                                        + "canonical_intent_json, intent_sha256, delivery_state) "
                                        + "VALUES(?,?,?,?,?,?,?,?,?,?)",
                                new Object[]{
                                        datasetId,
                                        sourceDeviceId,
                                        operationId,
                                        entityId,
                                        expectedRevisionId,
                                        resultRevisionId,
                                        rawCommandJson,
                                        canonicalVerified,
                                        intentSha256,
                                        DELIVERY_STATE_PENDING_SEND,
                                });
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
        ok.put("replayed", replayed);
        ok.put("operation_id", operationId);
        ok.put("entity_id", entityId);
        ok.put("expected_revision_id", expectedRevisionId);
        ok.put("result_revision_id", resultRevisionId);
        ok.put("intent_sha256", intentSha256);
        ok.put("delivery_state", DELIVERY_STATE_PENDING_SEND);
        return ok;
    }

    static JSObject inspectLedger(File dir) throws Exception {
        JSObject data = new JSObject();
        data.put("callerPid", Process.myPid());
        if (!dir.isDirectory() || !new File(dir, "store.db").isFile()) {
            data.put("initialized", false);
            data.put("expenseCount", 0);
            data.put("totalCents", 0L);
            data.put("expenses", new JSArray());
            data.put("revisions", new JSArray());
            data.put("revisionCount", 0);
            data.put("receiptCount", 0);
            data.put("outboxCount", 0);
            data.put("outbox", new JSArray());
            return data;
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            data.put("initialized", true);
            try (Cursor head = db.rawQuery(
                    "SELECT dataset_id, travel_id, branch_id, head_revision_id, baseline_source "
                            + "FROM branch_head WHERE id=1", null)) {
                if (head.moveToFirst()) {
                    data.put("datasetId", head.getString(0));
                    data.put("travelId", head.getString(1));
                    data.put("branchId", head.getString(2));
                    data.put("headRevisionId", head.getString(3));
                    data.put("baselineSource", head.getString(4));
                }
            }
            data.put("expenseCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM expenses", null));
            data.put("totalCents", BridgeLedgerStore.queryLong(db, "SELECT COALESCE(SUM(amount_cents), 0) FROM expenses", null));
            data.put("revisionCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM revisions", null));
            data.put("receiptCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM receipts", null));
            data.put("outboxCount", BridgeLedgerStore.queryLong(db, "SELECT count(*) FROM outbox", null));

            JSArray expenses = new JSArray();
            try (Cursor rows = db.rawQuery(
                    "SELECT e.entity_id, e.title, e.amount_cents, e.currency, e.paid_on, e.category, "
                            + "e.day, e.activity_id, e.notes, e.receipt_ids_json, e.budget_item_id, "
                            + "e.settles_budget, e.operation_id, o.delivery_state, o.expected_revision_id, "
                            + "o.result_revision_id, o.intent_sha256 "
                            + "FROM expenses e LEFT JOIN outbox o ON o.operation_id = e.operation_id "
                            + "ORDER BY e.seq", null)) {
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
                    item.put("budget_item_id", rows.isNull(10) ? JSONObject.NULL : rows.getString(10));
                    item.put("settles_budget", rows.getInt(11) != 0);
                    item.put("operation_id", rows.getString(12));
                    item.put("delivery_state", rows.isNull(13) ? DELIVERY_STATE_PENDING_SEND : rows.getString(13));
                    item.put("expected_revision_id", rows.isNull(14) ? JSONObject.NULL : rows.getString(14));
                    item.put("result_revision_id", rows.isNull(15) ? JSONObject.NULL : rows.getString(15));
                    item.put("intent_sha256", rows.isNull(16) ? JSONObject.NULL : rows.getString(16));
                    expenses.put(item);
                }
            }
            data.put("expenses", expenses);

            JSArray revisions = new JSArray();
            try (Cursor rows = db.rawQuery(
                    "SELECT revision_id, parent_revision_id, snapshot_json FROM revisions ORDER BY seq", null)) {
                while (rows.moveToNext()) {
                    String rawSnapshot = rows.getString(2);
                    JSONObject parsed = new JSONObject(rawSnapshot);
                    JSONArray snapshotExpenses = parsed.getJSONArray("expenses");
                    long revTotal = 0L;
                    for (int i = 0; i < snapshotExpenses.length(); i++) {
                        revTotal += snapshotExpenses.getJSONObject(i).getLong("amount_cents");
                    }
                    JSObject rev = new JSObject();
                    rev.put("revision_id", rows.getString(0));
                    rev.put("parent_revision_id", rows.isNull(1) ? JSONObject.NULL : rows.getString(1));
                    rev.put("expense_count", snapshotExpenses.length());
                    rev.put("total_cents", revTotal);
                    rev.put("snapshot_sha256", BridgeCreateLedgerStore.sha256Hex(rawSnapshot));
                    revisions.put(rev);
                }
            }
            data.put("revisions", revisions);

            data.put("outbox", readOutboxArray(db));
            data.put("journal", DatabaseUtils.stringForQuery(db, "PRAGMA journal_mode", null));
            data.put("sqlite", DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null));
        }
        return data;
    }

    static JSObject exportOutboxCommands(File dir) throws Exception {
        JSObject out = new JSObject();
        out.put("contract_id", CONTRACT_ID);
        out.put("contract_version", CONTRACT_VERSION);
        if (!dir.isDirectory() || !new File(dir, "store.db").isFile()) {
            out.put("initialized", false);
            out.put("count", 0);
            out.put("items", new JSArray());
            return out;
        }
        try (SQLiteDatabase db = BridgeLedgerStore.openStore(dir, false)) {
            out.put("initialized", true);
            try (Cursor head = db.rawQuery(
                    "SELECT dataset_id, travel_id, branch_id, head_revision_id, baseline_source "
                            + "FROM branch_head WHERE id=1", null)) {
                if (head.moveToFirst()) {
                    out.put("dataset_id", head.getString(0));
                    out.put("travel_id", head.getString(1));
                    out.put("branch_id", head.getString(2));
                    out.put("head_revision_id", head.getString(3));
                    out.put("baseline_source", head.getString(4));
                }
            }
            JSArray items = readOutboxArray(db);
            out.put("count", items.length());
            out.put("items", items);
        }
        return out;
    }

    private static JSArray readOutboxArray(SQLiteDatabase db) throws Exception {
        JSArray items = new JSArray();
        try (Cursor rows = db.rawQuery(
                "SELECT seq, dataset_id, source_device_id, operation_id, entity_id, expected_revision_id, "
                        + "result_revision_id, raw_command_json, canonical_intent_json, intent_sha256, delivery_state "
                        + "FROM outbox ORDER BY seq", null)) {
            while (rows.moveToNext()) {
                String datasetId = rows.getString(1);
                String sourceDeviceId = rows.getString(2);
                String operationId = rows.getString(3);
                String rawCommandJson = rows.getString(7);
                JSObject item = new JSObject();
                item.put("seq", rows.getLong(0));
                item.put("dataset_id", datasetId);
                item.put("source_device_id", sourceDeviceId);
                item.put("operation_id", operationId);
                item.put("entity_id", rows.getString(4));
                item.put("expected_revision_id", rows.getString(5));
                item.put("result_revision_id", rows.getString(6));
                item.put("raw_command_json", rawCommandJson);
                item.put("command", new JSONObject(rawCommandJson));
                item.put("canonical_intent_json", rows.getString(8));
                item.put("intent_sha256", rows.getString(9));
                item.put("delivery_state", rows.getString(10));
                JSONObject receiptQuery = new JSONObject()
                        .put("profile", "p1-host-query-1")
                        .put("kind", "receipt.lookup")
                        .put("operation", new JSONObject()
                                .put("dataset_id", datasetId)
                                .put("source_device_id", sourceDeviceId)
                                .put("operation_id", operationId));
                item.put("receipt_query", receiptQuery);
                items.put(item);
            }
        }
        return items;
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

    private static String buildSnapshotJson(SQLiteDatabase db) {
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
                        sb.append(String.format(Locale.US, "\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
                    break;
            }
        }
        sb.append('"');
    }

    private static JSObject rejected(String error) {
        JSObject out = new JSObject();
        out.put("accepted", false);
        out.put("error", error);
        return out;
    }
}
