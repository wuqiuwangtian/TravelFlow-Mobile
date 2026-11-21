package org.travelflow.p1recovery;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import java.util.UUID;
import org.json.JSONObject;

/** One outstanding synthetic edit per caller and branch. Only the caller opens its preferences. */
final class PendingEditExperiment {
    private static final Uri WRITER = Uri.parse("content://org.travelflow.p1recovery.writer");
    private final RecoveryFixture fixture;
    private final String scenario;
    private final SharedPreferences client;

    PendingEditExperiment(RecoveryFixture fixture, String scenario) {
        this.fixture = fixture;
        this.scenario = scenario;
        client = fixture.getTargetContext().getSharedPreferences(scenario, Context.MODE_PRIVATE);
    }

    private String pending() { return client.getString("pending", null); }

    private void prepare() throws Exception {
        if (pending() != null || client.contains("confirmed_op")) throw new IllegalStateException("operation exists");
        UUID id = UUID.randomUUID();
        String raw = new JSONObject().put("operation_id", id.toString()).put("target", "fixture-expense")
                .put("amount_cents", 701 + Math.floorMod(id.hashCode(), 99)).put("expected_revision", 0).toString();
        if (!client.edit().putString("pending", raw).commit()) throw new IllegalStateException("intent not persisted");
    }

    private Bundle writer(String method, String raw) {
        Bundle args = new Bundle();
        args.putString("request", raw);
        return fixture.getTargetContext().getContentResolver().call(WRITER, method, scenario, args);
    }

    private String reconcile(SQLiteDatabase db) throws Exception {
        String raw = pending();
        if (raw == null) return client.contains("confirmed_op") ? "confirmed" : "idle";
        String op = new JSONObject(raw).getString("operation_id");
        int revision;
        // Serialize the negative lookup with writers. A plain SELECT can read the old snapshot.
        try {
            db.beginTransactionNonExclusive();
            try (Cursor row = db.rawQuery("SELECT intent,rev FROM receipt WHERE op=?", new String[]{op})) {
                if (!row.moveToFirst()) return "no_receipt";
                if (!raw.equals(row.getString(0))) return "intent_conflict";
                revision = row.getInt(1);
            } finally { db.endTransaction(); }
        } catch (SQLiteDatabaseLockedException busy) {
            return "pending_busy";
        }
        if (!client.edit().remove("pending").putString("confirmed_op", op).putInt("confirmed_rev", revision).commit())
            throw new IllegalStateException("receipt not persisted");
        return "confirmed";
    }

    private void interruptCaller(SQLiteDatabase db) throws Exception {
        String raw = pending();
        if (raw == null) throw new IllegalStateException("missing caller intent");
        int writerPid = writer("hold", raw).getInt("writer_pid");
        Bundle observation = new Bundle();
        try {
            String op = new JSONObject(raw).getString("operation_id");
            long visible = DatabaseUtils.longForQuery(db, "SELECT count(*) FROM receipt WHERE op=?", new String[]{op});
            String outcome = reconcile(db);
            if (visible != 0 || !"pending_busy".equals(outcome) || !raw.equals(pending()) || writerPid == Process.myPid())
                throw new IllegalStateException("unexpected contention result: " + visible + "/" + outcome);
            observation.putString("observation", new JSONObject().put("pending", pending()).put("state", outcome)
                    .put("plain_receipts", visible).put("writer_pid", writerPid).put("caller_pid", Process.myPid()).toString());
        } finally {
            writer("release", null);
        }
        fixture.sendStatus(1, observation);
        Process.killProcess(Process.myPid());
        throw new AssertionError("caller kill returned");
    }

    JSONObject run(String action, SQLiteDatabase db) throws Exception {
        JSONObject data = new JSONObject();
        switch (action) {
            case "prepare": prepare(); break;
            case "race": interruptCaller(db); break;
            case "reconcile": data.put("state", reconcile(db)); break;
            case "resubmit":
                String state = reconcile(db);
                if ("no_receipt".equals(state)) {
                    data.put("submission", writer("submit", pending()).getString("outcome"));
                    state = reconcile(db);
                }
                data.put("state", state);
                break;
            case "snapshot": break;
            default: throw new IllegalArgumentException("unknown caller action");
        }
        data.put("pending", pending() == null ? JSONObject.NULL : pending());
        data.put("confirmed_op", client.contains("confirmed_op") ? client.getString("confirmed_op", null) : JSONObject.NULL);
        data.put("confirmed_rev", client.getInt("confirmed_rev", -1));
        data.put("caller_pid", Process.myPid());
        data.put("head", DatabaseUtils.longForQuery(db, "SELECT head FROM expense WHERE id=1", null));
        data.put("cents", DatabaseUtils.longForQuery(db, "SELECT cents FROM expense WHERE id=1", null));
        for (String table : new String[]{"history", "receipt", "outbox"})
            data.put(table, DatabaseUtils.longForQuery(db, "SELECT count(*) FROM " + table, null));
        try (Cursor row = db.rawQuery("SELECT r.intent FROM receipt r JOIN outbox o USING(op,rev) JOIN history h USING(rev) "
                + "JOIN expense e ON e.head=h.rev AND e.cents=h.cents", null)) {
            data.put("committed_intent", row.moveToFirst() ? row.getString(0) : JSONObject.NULL);
        }
        return data;
    }
}
