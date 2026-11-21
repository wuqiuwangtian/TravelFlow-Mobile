package org.travelflow.p1recovery;

import android.app.Activity;
import android.app.Instrumentation;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteFullException;
import android.os.Bundle;
import android.os.Process;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import org.json.JSONObject;

/** Self-instrumenting single-branch experiment with one synthetic expense and attachment. */
public final class RecoveryFixture extends Instrumentation {
    private static final byte[] TICKET = "fictional ticket 56".getBytes(StandardCharsets.UTF_8);
    private File staging, ticket, unrelated;
    private String action, scenario;

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        action = args.getString("action");
        scenario = args.getString("scenario");
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (scenario == null || !scenario.matches("staged|ready|revision|expense|receipt|outbox|committed|full|lock-commit|lock-rollback"))
                throw new IllegalArgumentException("unknown fixture scenario");
            File dir = new File(getTargetContext().getFilesDir(), scenario);
            if ("init".equals(action) && !dir.mkdir()) throw new IllegalStateException("fixture exists");
            if (!dir.isDirectory()) throw new IllegalStateException("missing fixture");
            staging = new File(dir, "ticket.tmp");
            ticket = new File(dir, "ticket-1");
            unrelated = new File(dir, "unmanaged");
            try (SQLiteDatabase db = openStore(dir, "init".equals(action))) {
                db.setForeignKeyConstraintsEnabled(true);
                JSONObject data;
                if (scenario.startsWith("lock-") && !"init".equals(action)) {
                    data = new PendingEditExperiment(this, scenario).run(action, db);
                } else {
                    data = runRecoveryAction(db);
                }
                result.putString("fixture", data.toString());
            }
            finish(Activity.RESULT_OK, result);
        } catch (Exception error) {
            result.putString("failure", android.util.Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private JSONObject runRecoveryAction(SQLiteDatabase db) throws Exception {
        JSONObject data = new JSONObject();
        switch (action) {
            case "init": seed(db); break;
            case "inspect": data = inspect(db); break;
            case "lookup":
                try (Cursor row = db.rawQuery("SELECT rev FROM receipt WHERE op='edit'", null)) {
                    data.put("revision", row.moveToFirst() ? row.getInt(0) : JSONObject.NULL);
                }
                break;
            case "fault":
            case "retry":
            case "detach":
            case "conflict": data.put("outcome", save(db)); break;
            case "recover": recover(db); break;
            default: throw new IllegalArgumentException("unknown fixture action");
        }
        return data;
    }

    static SQLiteDatabase openStore(File dir, boolean create) {
        int flags = SQLiteDatabase.OPEN_READWRITE;
        if (create) flags |= SQLiteDatabase.CREATE_IF_NECESSARY;
        SQLiteDatabase.OpenParams params = new SQLiteDatabase.OpenParams.Builder().setOpenFlags(flags)
                .setJournalMode("DELETE").setSynchronousMode("FULL").build();
        return SQLiteDatabase.openDatabase(new File(dir, "store.db"), params);
    }

    private void seed(SQLiteDatabase db) throws Exception {
        db.beginTransaction();
        try {
            db.execSQL("CREATE TABLE history(rev INTEGER PRIMARY KEY, cents INTEGER NOT NULL, asset TEXT)");
            db.execSQL("CREATE TABLE expense(id INTEGER PRIMARY KEY, cents INTEGER NOT NULL, head INTEGER NOT NULL REFERENCES history)");
            db.execSQL("CREATE TABLE receipt(op TEXT PRIMARY KEY, intent TEXT NOT NULL, rev INTEGER NOT NULL REFERENCES history)");
            db.execSQL("CREATE TABLE outbox(op TEXT PRIMARY KEY REFERENCES receipt, rev INTEGER NOT NULL REFERENCES history)");
            db.execSQL("CREATE TABLE space_probe(padding BLOB)");
            db.execSQL("INSERT INTO history VALUES(0,700,NULL)");
            db.execSQL("INSERT INTO expense VALUES(1,700,0)");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        Files.write(unrelated.toPath(), new byte[]{42});
    }

    private static long number(SQLiteDatabase db, String sql) {
        return DatabaseUtils.longForQuery(db, sql, null);
    }

    private void checkpoint(String phase) {
        if (!"fault".equals(action) || !phase.equals(scenario)) return;
        Bundle status = new Bundle();
        status.putString("checkpoint", phase);
        sendStatus(1, status);
        Process.killProcess(Process.myPid());
        throw new AssertionError("kill returned");
    }

    private void importTicket() throws Exception {
        try (FileOutputStream stream = new FileOutputStream(staging)) {
            stream.write(TICKET);
            stream.getFD().sync();
        }
        checkpoint("staged");
        Os.rename(staging.getPath(), ticket.getPath());
        FileDescriptor parent = Os.open(ticket.getParent(), OsConstants.O_RDONLY, 0);
        try { Os.fsync(parent); } finally { Os.close(parent); }
        checkpoint("ready");
    }

    private String save(SQLiteDatabase db) throws Exception {
        boolean detach = "detach".equals(action);
        String op = detach ? "drop-link" : "edit";
        String intent = detach ? "detach at 1" : "conflict".equals(action) ? "edit to 999 at 0" : "edit to 756 at 0";
        int rev = detach ? 2 : 1;
        boolean full = "fault".equals(action) && "full".equals(scenario);
        if (full) {
            long bytes = db.getPageSize() * number(db, "PRAGMA page_count");
            if (db.setMaximumSize(bytes) != bytes) throw new IllegalStateException("fixture page cap failed");
        }
        boolean sawFull = false;
        db.beginTransaction();
        try {
            try (Cursor row = db.rawQuery("SELECT intent,rev FROM receipt WHERE op=?", new String[]{op})) {
                if (row.moveToFirst())
                    return row.getString(0).equals(intent) ? "replayed-" + row.getInt(1) : "intent_conflict";
            }
            if ("conflict".equals(action)) throw new IllegalStateException("expected original receipt");
            if (number(db, "SELECT head FROM expense WHERE id=1") != rev - 1) throw new IllegalStateException("stale head");
            if (!detach) importTicket();
            writeRows(db, rev, 756, detach ? null : "ticket-1", op, intent, this::checkpoint);
            if (full) {
                try { db.execSQL("INSERT INTO space_probe VALUES(zeroblob(1048576))"); }
                catch (SQLiteFullException expected) { sawFull = true; }
                if (!sawFull) throw new IllegalStateException("SQLITE_FULL missing");
            } else {
                db.setTransactionSuccessful();
            }
        } finally {
            // SQLite can roll back automatically on SQLITE_FULL before Android ends the transaction.
            try { db.endTransaction(); }
            catch (android.database.sqlite.SQLiteException error) {
                if (!sawFull || !error.toString().contains("no transaction is active")) throw error;
            }
        }
        if (sawFull) return "sqlite_full";
        checkpoint("committed");
        return "committed-" + rev;
    }

    interface Checkpoint { void reached(String point); }

    static void writeRows(SQLiteDatabase db, int rev, int cents, String asset, String op, String intent, Checkpoint check) {
        db.execSQL("INSERT INTO history VALUES(?,?,?)", new Object[]{rev, cents, asset});
        check.reached("revision");
        db.execSQL("UPDATE expense SET cents=?,head=? WHERE id=1", new Object[]{cents, rev});
        check.reached("expense");
        db.execSQL("INSERT INTO receipt VALUES(?,?,?)", new Object[]{op, intent, rev});
        check.reached("receipt");
        db.execSQL("INSERT INTO outbox VALUES(?,?)", new Object[]{op, rev});
        check.reached("outbox");
    }

    private void recover(SQLiteDatabase db) throws Exception {
        // File import and collection share the same DB writer lock. Only two owned paths are eligible.
        db.beginTransaction();
        try {
            Files.deleteIfExists(staging.toPath());
            if (number(db, "SELECT count(*) FROM history WHERE asset='ticket-1'") == 0)
                Files.deleteIfExists(ticket.toPath());
            else if (!Arrays.equals(Files.readAllBytes(ticket.toPath()), TICKET))
                throw new IllegalStateException("referenced ticket is unreadable or corrupt");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    private JSONObject inspect(SQLiteDatabase db) throws Exception {
        JSONObject data = new JSONObject();
        for (String table : new String[]{"history", "receipt", "outbox", "space_probe"})
            data.put(table, number(db, "SELECT count(*) FROM " + table));
        data.put("head", number(db, "SELECT head FROM expense WHERE id=1"));
        data.put("cents", number(db, "SELECT cents FROM expense WHERE id=1"));
        data.put("seed_intact", number(db, "SELECT count(*) FROM history WHERE rev=0 AND cents=700 AND asset IS NULL"));
        data.put("edit_chain", number(db, "SELECT count(*) FROM history h JOIN receipt r USING(rev) JOIN outbox o USING(op,rev) WHERE h.rev=1 AND h.cents=756 AND h.asset='ticket-1' AND r.op='edit'"));
        data.put("detached_chain", number(db, "SELECT count(*) FROM history h JOIN receipt r USING(rev) JOIN outbox o USING(op,rev) WHERE h.rev=2 AND h.cents=756 AND h.asset IS NULL AND r.op='drop-link'"));
        data.put("staged", staging.isFile());
        data.put("ticket", ticket.isFile());
        data.put("ticket_intact", ticket.isFile() && Arrays.equals(Files.readAllBytes(ticket.toPath()), TICKET));
        data.put("unmanaged_intact", Arrays.equals(Files.readAllBytes(unrelated.toPath()), new byte[]{42}));
        data.put("journal", DatabaseUtils.stringForQuery(db, "PRAGMA journal_mode", null));
        data.put("sqlite", DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null));
        return data;
    }
}
