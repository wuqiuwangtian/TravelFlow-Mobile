package org.travelflow.p1recovery;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteDatabaseCorruptException;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** One bounded single-branch, private-directory fixture. All paths are selected by this class. */
final class FixtureBackup {
    private static final String DB = "store.db", MANIFEST = "manifest.json";
    private static final String FIRST = "ticket-1", SECOND = "attachments/ticket-2";
    private static final Set<String> ALLOWED = new HashSet<>(Arrays.asList(DB, FIRST, SECOND, MANIFEST));
    private static final int LIMIT = 1 << 20;
    private final Path live, archive, restored;

    FixtureBackup(File dir) {
        live = dir.toPath();
        archive = live.resolve("fixture-backup.zip");
        restored = live.resolve("restored");
    }

    private static class Invalid extends IOException {
        Invalid(String reason) { super(reason); }
    }

    private static String digest(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : hash) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }

    private static byte[] read(Path path) throws IOException {
        if (Files.size(path) > LIMIT) throw new Invalid("size_limit");
        return Files.readAllBytes(path);
    }

    private static SQLiteDatabase readStore(Path dir) {
        return SQLiteDatabase.openDatabase(dir.resolve(DB).toString(), null, SQLiteDatabase.OPEN_READONLY,
                db -> { throw new SQLiteDatabaseCorruptException("unreadable fixture database"); });
    }

    private static Set<String> members(SQLiteDatabase db) throws IOException {
        Set<String> files = new LinkedHashSet<>();
        files.add(DB);
        try (Cursor rows = db.rawQuery("SELECT DISTINCT asset FROM history WHERE asset IS NOT NULL ORDER BY asset", null)) {
            while (rows.moveToNext()) {
                String asset = rows.getString(0);
                if (FIRST.equals(asset)) files.add(FIRST);
                else if ("ticket-2".equals(asset)) files.add(SECOND);
                else throw new Invalid("unknown_history_asset");
            }
        }
        return files;
    }

    private static void add(ZipOutputStream zip, String name, byte[] data) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(data);
        zip.closeEntry();
    }

    private void capture(Path work) throws Exception {
        // Hold the same reserved writer lock used by asset import/collection. VACUUM uses
        // a separate connection so its consistent snapshot runs outside the lock transaction.
        try (SQLiteDatabase lock = RecoveryFixture.openStore(live.toFile(), false);
             SQLiteDatabase copy = RecoveryFixture.openStore(live.toFile(), false)) {
            lock.beginTransactionNonExclusive();
            try {
                copy.execSQL("VACUUM INTO ?", new Object[]{work.resolve(DB).toString()});
                JSONObject hashes = new JSONObject();
                try (SQLiteDatabase snap = readStore(work);
                     ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(work.resolve("capture.zip")))) {
                    for (String name : members(snap)) {
                        byte[] bytes = read((DB.equals(name) ? work : live).resolve(name));
                        hashes.put(name, digest(bytes));
                        add(zip, name, bytes);
                    }
                    JSONObject manifest = new JSONObject().put("format", "fixture-backup-1").put("sha256", hashes);
                    add(zip, MANIFEST, manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                Files.move(work.resolve("capture.zip"), archive, StandardCopyOption.ATOMIC_MOVE);
            } finally { lock.endTransaction(); }
        }
    }

    private static byte[] entry(ZipFile zip, String name) throws IOException {
        ZipEntry item = zip.getEntry(name);
        if (item == null) throw new Invalid("missing:" + name);
        if (item.getSize() < 0 || item.getSize() > LIMIT) throw new Invalid("size_limit");
        try (InputStream stream = zip.getInputStream(item)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = stream.read(buffer)) != -1) {
                if (bytes.size() + n > item.getSize()) throw new Invalid("size_limit");
                bytes.write(buffer, 0, n);
            }
            if (bytes.size() != item.getSize()) throw new Invalid("entry_size");
            return bytes.toByteArray();
        }
    }

    private static void unpack(Path input, Path stage) throws Exception {
        Files.createDirectory(stage.resolve("attachments"));
        try (ZipFile zip = new ZipFile(input.toFile())) {
            Set<String> names = new HashSet<>();
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                String name = entries.nextElement().getName();
                if (!ALLOWED.contains(name) || !names.add(name)) throw new Invalid("unexpected_member");
            }
            JSONObject manifest = new JSONObject(new String(entry(zip, MANIFEST), java.nio.charset.StandardCharsets.UTF_8));
            if (!"fixture-backup-1".equals(manifest.getString("format"))) throw new Invalid("format");
            JSONObject hashes = manifest.getJSONObject("sha256");
            Set<String> listed = new HashSet<>();
            hashes.keys().forEachRemaining(listed::add);
            if (!listed.contains(DB)) throw new Invalid("missing:" + DB);
            for (String name : listed) {
                if (!ALLOWED.contains(name) || MANIFEST.equals(name)) throw new Invalid("unexpected_member");
                byte[] bytes = entry(zip, name);
                if (!digest(bytes).equals(hashes.getString(name))) throw new Invalid("digest:" + name);
                Files.write(stage.resolve(name), bytes);
            }
            names.remove(MANIFEST);
            if (!names.equals(listed)) throw new Invalid("inventory");
            try (SQLiteDatabase db = readStore(stage);
                 Cursor fk = db.rawQuery("PRAGMA foreign_key_check", null)) {
                if (!db.isDatabaseIntegrityOk() || fk.moveToFirst()) throw new Invalid("database_integrity");
                if (!members(db).equals(listed)) throw new Invalid("history_inventory");
            } catch (SQLiteException invalidDatabase) {
                throw new Invalid("database_integrity");
            }
        }
    }

    // Fixed scratch tree only. Both publication and cleanup stay outside the active ledger.
    private static void clean(Path dir) throws IOException {
        for (String name : new String[]{FIRST, SECOND, "attachments", DB, "capture.zip", "input.zip"})
            Files.deleteIfExists(dir.resolve(name));
        Files.deleteIfExists(dir);
    }

    private JSONObject restore(Path work, String damaged) throws Exception {
        if (Files.exists(restored)) return new JSONObject().put("outcome", "destination_exists");
        Path input = archive;
        if (damaged != null) {
            if (damaged.length() > LIMIT) throw new Invalid("size_limit");
            input = work.resolve("input.zip");
            Files.write(input, Base64.decode(damaged, Base64.NO_WRAP));
        }
        Path stage = Files.createDirectory(work.resolve("candidate"));
        try {
            unpack(input, stage);
            Files.move(stage, restored, StandardCopyOption.ATOMIC_MOVE);
            return new JSONObject().put("outcome", "restored");
        } catch (IOException | org.json.JSONException error) {
            return new JSONObject().put("outcome", "rejected").put("reason", error.getMessage());
        } finally {
            if (Files.exists(stage)) clean(stage);
        }
    }

    private static JSONArray rows(SQLiteDatabase db, String query) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = db.rawQuery(query, null)) {
            while (c.moveToNext()) {
                JSONArray row = new JSONArray();
                for (int i = 0; i < c.getColumnCount(); i++) {
                    if (c.isNull(i)) row.put(JSONObject.NULL);
                    else if (c.getType(i) == Cursor.FIELD_TYPE_INTEGER) row.put(c.getLong(i));
                    else row.put(c.getString(i));
                }
                result.put(row);
            }
        }
        return result;
    }

    private static JSONObject inspect(Path dir) throws Exception {
        try (SQLiteDatabase db = readStore(dir)) {
            JSONObject tickets = new JSONObject();
            for (String name : members(db)) {
                if (!DB.equals(name)) tickets.put(name, Base64.encodeToString(read(dir.resolve(name)), Base64.NO_WRAP));
            }
            return new JSONObject().put("expense", rows(db, "SELECT id,cents,head FROM expense ORDER BY id"))
                    .put("history", rows(db, "SELECT rev,cents,asset FROM history ORDER BY rev"))
                    .put("receipts", rows(db, "SELECT op,intent,rev FROM receipt ORDER BY rev"))
                    .put("outbox", rows(db, "SELECT op,rev FROM outbox ORDER BY rev")).put("tickets", tickets);
        }
    }

    JSONObject run(String action, String damaged) throws Exception {
        switch (action) {
            case "backup-live": return inspect(live);
            case "backup-restored": return inspect(restored);
            case "backup-status":
                String[] scratch = live.toFile().list((d, n) -> n.startsWith("backup-work-"));
                if (scratch == null) throw new IOException("cannot list fixture directory");
                return new JSONObject().put("published", Files.exists(restored)).put("scratch", scratch.length);
            case "backup-advance":
                try (SQLiteDatabase db = RecoveryFixture.openStore(live.toFile(), false)) {
                    db.setForeignKeyConstraintsEnabled(true);
                    db.beginTransaction();
                    try {
                        if (DatabaseUtils.longForQuery(db, "SELECT head FROM expense WHERE id=1", null) != 3)
                            throw new IllegalStateException("expected revision 3");
                        RecoveryFixture.writeRows(db, 4, 915, null, "later", "edit after backup", phase -> {});
                        db.setTransactionSuccessful();
                    } finally { db.endTransaction(); }
                }
                return inspect(live);
            case "backup-create":
            case "backup-restore":
                Path work = Files.createTempDirectory(live, "backup-work-");
                try {
                    if ("backup-restore".equals(action)) return restore(work, damaged);
                    capture(work);
                    return new JSONObject().put("archive", Base64.encodeToString(read(archive), Base64.NO_WRAP));
                } finally { clean(work); }
            default: throw new IllegalArgumentException("unknown backup fixture action");
        }
    }
}
