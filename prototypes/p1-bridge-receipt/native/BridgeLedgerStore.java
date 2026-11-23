package org.travelflow.p1bridge;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;

/**
 * Isolated single-branch SQLite ledger and historical ticket store for the P1 bridge receipt prototype.
 * Uses DELETE journal mode and FULL synchronous mode, matching prototypes/p1-android-recovery.
 */
final class BridgeLedgerStore {
    static final byte[] HISTORICAL_TICKET_BYTES = "fictional ticket 56".getBytes(StandardCharsets.UTF_8);
    static final byte[] UNMANAGED_BYTES = new byte[]{42};
    static final String HISTORICAL_TICKET_NAME = "ticket-1";
    static final String UNMANAGED_NAME = "unmanaged";

    private BridgeLedgerStore() {}

    static boolean isValidScenario(String scenario) {
        return scenario != null && scenario.matches(
                "before-commit|after-commit-drop-reply|lock-busy-commit|lock-busy-rollback");
    }

    static File scenarioDir(File filesDir, String scenario) {
        if (!isValidScenario(scenario)) {
            throw new IllegalArgumentException("Unknown P1 bridge scenario: " + scenario);
        }
        return new File(filesDir, "p1-bridge-" + scenario);
    }

    static SQLiteDatabase openStore(File dir, boolean create) {
        int flags = SQLiteDatabase.OPEN_READWRITE;
        if (create) {
            flags |= SQLiteDatabase.CREATE_IF_NECESSARY;
        }
        SQLiteDatabase.OpenParams params = new SQLiteDatabase.OpenParams.Builder()
                .setOpenFlags(flags)
                .setJournalMode("DELETE")
                .setSynchronousMode("FULL")
                .build();
        SQLiteDatabase db = SQLiteDatabase.openDatabase(new File(dir, "store.db"), params);
        db.setForeignKeyConstraintsEnabled(true);
        return db;
    }

    static void seed(File dir) throws Exception {
        if (dir.exists()) {
            throw new IllegalStateException("Scenario already initialized: " + dir.getName());
        }
        if (!dir.mkdirs()) {
            throw new IllegalStateException("Failed to create scenario directory: " + dir.getName());
        }
        writeSyncedFile(new File(dir, HISTORICAL_TICKET_NAME), HISTORICAL_TICKET_BYTES);
        writeSyncedFile(new File(dir, UNMANAGED_NAME), UNMANAGED_BYTES);

        try (SQLiteDatabase db = openStore(dir, true)) {
            db.beginTransaction();
            try {
                db.execSQL("CREATE TABLE history(rev INTEGER PRIMARY KEY, cents INTEGER NOT NULL, asset TEXT)");
                db.execSQL("CREATE TABLE expense(id INTEGER PRIMARY KEY, cents INTEGER NOT NULL, head INTEGER NOT NULL REFERENCES history)");
                db.execSQL("CREATE TABLE receipt(op TEXT PRIMARY KEY, intent TEXT NOT NULL, rev INTEGER NOT NULL REFERENCES history)");
                db.execSQL("CREATE TABLE outbox(op TEXT PRIMARY KEY REFERENCES receipt, rev INTEGER NOT NULL REFERENCES history)");
                db.execSQL("INSERT INTO history VALUES(0,700,NULL)");
                db.execSQL("INSERT INTO expense VALUES(1,700,0)");
                writeRows(db, 1, 756, HISTORICAL_TICKET_NAME, "seed-edit-1", "seed edit to 756 with ticket-1");
                writeRows(db, 2, 756, null, "seed-detach-2", "seed detach ticket-1 at 1");
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
    }

    static void writeRows(SQLiteDatabase db, int rev, int cents, String asset, String op, String intent) {
        db.execSQL("INSERT INTO history VALUES(?,?,?)", new Object[]{rev, cents, asset});
        db.execSQL("UPDATE expense SET cents=?,head=? WHERE id=1", new Object[]{cents, rev});
        db.execSQL("INSERT INTO receipt VALUES(?,?,?)", new Object[]{op, intent, rev});
        db.execSQL("INSERT INTO outbox VALUES(?,?)", new Object[]{op, rev});
    }

    static String checkPriorReceipt(SQLiteDatabase db, String op, String intent, int[] outRevision) {
        try (Cursor row = db.rawQuery("SELECT intent,rev FROM receipt WHERE op=?", new String[]{op})) {
            if (!row.moveToFirst()) {
                return null;
            }
            outRevision[0] = row.getInt(1);
            return intent.equals(row.getString(0)) ? "replayed" : "intent_conflict";
        }
    }

    static long queryLong(SQLiteDatabase db, String sql, String[] args) {
        return DatabaseUtils.longForQuery(db, sql, args);
    }

    static boolean historicalTicketIntact(File dir) throws Exception {
        File ticket = new File(dir, HISTORICAL_TICKET_NAME);
        return ticket.isFile() && Arrays.equals(Files.readAllBytes(ticket.toPath()), HISTORICAL_TICKET_BYTES);
    }

    static String readHistoricalTicketText(File dir) throws Exception {
        File ticket = new File(dir, HISTORICAL_TICKET_NAME);
        if (!ticket.isFile()) {
            return null;
        }
        return new String(Files.readAllBytes(ticket.toPath()), StandardCharsets.UTF_8);
    }

    static boolean unmanagedIntact(File dir) throws Exception {
        File unmanaged = new File(dir, UNMANAGED_NAME);
        return unmanaged.isFile() && Arrays.equals(Files.readAllBytes(unmanaged.toPath()), UNMANAGED_BYTES);
    }

    private static void writeSyncedFile(File target, byte[] bytes) throws Exception {
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(bytes);
            out.getFD().sync();
        }
    }
}
