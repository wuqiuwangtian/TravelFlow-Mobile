package org.travelflow.p1recovery;

import android.app.Activity;
import android.app.Instrumentation;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteFullException;
import android.os.Bundle;
import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import org.json.JSONObject;

/** Self-instrumenting single-branch experiment with one synthetic expense and attachment. */
public final class RecoveryFixture extends Instrumentation {
    private static final byte[] TICKET = "fictional ticket 56".getBytes(StandardCharsets.UTF_8);
    private FixtureTicket ticket, replacement;
    private File unrelated;
    private static final String REPLACE_OP = "attach-second";
    private static final String REPLACE_INTENT = "set 842 and ticket-2 at 2";
    private String action, scenario, damagedBackup;

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        action = args.getString("action");
        scenario = args.getString("scenario");
        damagedBackup = args.getString("bundle");
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (scenario == null || !scenario.matches("staged|ready|revision|expense|receipt|outbox|committed|full|lock-commit|lock-rollback|file-open|file-partial|file-rename|file-dir-sync|backup"))
                throw new IllegalArgumentException("unknown fixture scenario");
            File dir = new File(getTargetContext().getFilesDir(), scenario);
            if ("init".equals(action) && !dir.mkdir()) throw new IllegalStateException("fixture exists");
            if (!dir.isDirectory()) throw new IllegalStateException("missing fixture");
            if ("backup".equals(scenario) && action.startsWith("backup-")) {
                result.putString("fixture", new FixtureBackup(dir).run(action, damagedBackup).toString());
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("backup".equals(scenario) && "restored-attach".equals(action)) {
                dir = new File(dir, "restored");
                action = "attach";
            }
            ticket = new FixtureTicket(dir, "ticket.tmp", "ticket-1", TICKET);
            if (scenario.startsWith("file-") || "backup".equals(scenario)) {
                File assets = new File(dir, "attachments");
                if ("init".equals(action)) {
                    if (!assets.mkdir()) throw new IllegalStateException("asset directory exists");
                    Os.chmod(assets.getPath(), 0700);
                }
                replacement = new FixtureTicket(assets, "incoming.tmp", "ticket-2",
                        "second fictional ticket 842".getBytes(StandardCharsets.UTF_8));
            }
            unrelated = new File(replacement == null ? dir : replacement.ready.getParentFile(), "unmanaged");
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
            case "attach":
            case "file-fault": return replaceTicket(db);
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

    private static String priorResult(SQLiteDatabase db, String op, String intent) {
        try (Cursor row = db.rawQuery("SELECT intent,rev FROM receipt WHERE op=?", new String[]{op})) {
            if (!row.moveToFirst()) return null;
            return row.getString(0).equals(intent) ? "replayed-" + row.getInt(1) : "intent_conflict";
        }
    }

    private JSONObject replaceTicket(SQLiteDatabase db) throws Exception {
        if (replacement == null) throw new IllegalStateException("missing second fixture asset");
        boolean fault = "file-fault".equals(action);
        boolean denyDirectory = fault && ("file-open".equals(scenario) || "file-rename".equals(scenario));
        String directory = replacement.ready.getParent();
        db.beginTransaction();
        try {
            String prior = priorResult(db, REPLACE_OP, REPLACE_INTENT);
            if (prior != null) return new JSONObject().put("outcome", prior);
            if (number(db, "SELECT head FROM expense WHERE id=1") != 2) throw new IllegalStateException("stale head");
            try {
                replacement.publish(phase -> {
                    if (!fault) return;
                    if (("open".equals(phase) && "file-open".equals(scenario))
                            || ("staged".equals(phase) && "file-rename".equals(scenario))) Os.chmod(directory, 0500);
                    if ("partial".equals(phase) && "file-partial".equals(scenario))
                        throw new ErrnoException("injected write", OsConstants.ENOSPC);
                    if ("dir-sync".equals(phase) && "file-dir-sync".equals(scenario))
                        throw new ErrnoException("injected directory fsync", OsConstants.EIO);
                });
            } catch (ErrnoException failure) {
                return new JSONObject().put("outcome", "file_error").put("errno", failure.errno)
                        .put("detail", failure.getMessage());
            } finally {
                if (denyDirectory) Os.chmod(directory, 0700);
            }
            writeRows(db, 3, 842, replacement.ready.getName(), REPLACE_OP, REPLACE_INTENT, this::checkpoint);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return new JSONObject().put("outcome", "committed-3");
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
            String prior = priorResult(db, op, intent);
            if (prior != null) return prior;
            if ("conflict".equals(action)) throw new IllegalStateException("expected original receipt");
            if (number(db, "SELECT head FROM expense WHERE id=1") != rev - 1) throw new IllegalStateException("stale head");
            if (!detach) ticket.publish(this::checkpoint);
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
        // File import and collection share the same DB writer lock. Each registered asset has a fixed pair of owned paths.
        db.beginTransaction();
        try {
            ticket.recover(db);
            if (replacement != null) replacement.recover(db);
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
        data.put("edit_chain", number(db, "SELECT count(*) FROM history h JOIN receipt r USING(rev) JOIN outbox o USING(op,rev) WHERE h.rev=1 AND h.cents=756 AND h.asset='ticket-1' AND r.op='edit' AND r.intent='edit to 756 at 0'"));
        data.put("detached_chain", number(db, "SELECT count(*) FROM history h JOIN receipt r USING(rev) JOIN outbox o USING(op,rev) WHERE h.rev=2 AND h.cents=756 AND h.asset IS NULL AND r.op='drop-link' AND r.intent='detach at 1'"));
        data.put("staged", ticket.staging.isFile());
        data.put("ticket", ticket.ready.isFile());
        data.put("ticket_intact", ticket.intact());
        if (replacement != null) {
            data.put("new_stage", replacement.staging.exists()
                    ? new String(Files.readAllBytes(replacement.staging.toPath()), StandardCharsets.UTF_8) : JSONObject.NULL);
            data.put("new_ready", replacement.ready.exists());
            data.put("new_intact", replacement.intact());
            data.put("replacement_chain", DatabaseUtils.longForQuery(db,
                    "SELECT count(*) FROM history h JOIN receipt r USING(rev) JOIN outbox o USING(op,rev) "
                    + "WHERE h.rev=3 AND h.cents=842 AND h.asset='ticket-2' AND r.op=? AND r.intent=?",
                    new String[]{REPLACE_OP, REPLACE_INTENT}));
        }
        data.put("unmanaged_intact", Arrays.equals(Files.readAllBytes(unrelated.toPath()), new byte[]{42}));
        data.put("journal", DatabaseUtils.stringForQuery(db, "PRAGMA journal_mode", null));
        data.put("sqlite", DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null));
        return data;
    }
}
