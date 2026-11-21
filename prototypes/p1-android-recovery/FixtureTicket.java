package org.travelflow.p1recovery;

import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;

/** One immutable fixture asset and its owned staging path, both under the caller's writer lock. */
final class FixtureTicket {
    interface Step { void reached(String phase) throws Exception; }

    final File staging, ready;
    private final byte[] contents;

    FixtureTicket(File dir, String temporaryName, String assetName, byte[] contents) {
        staging = new File(dir, temporaryName);
        ready = new File(dir, assetName);
        this.contents = contents;
    }

    void publish(Step step) throws Exception {
        step.reached("open");
        FileDescriptor file = Os.open(staging.getPath(), OsConstants.O_CREAT | OsConstants.O_TRUNC
                | OsConstants.O_WRONLY | OsConstants.O_NOFOLLOW, 0600);
        try {
            writeRange(file, 0, 8);
            step.reached("partial");
            writeRange(file, 8, contents.length);
            Os.fsync(file);
        } finally { Os.close(file); }
        step.reached("staged");
        Os.rename(staging.getPath(), ready.getPath());
        FileDescriptor dir = Os.open(ready.getParent(), OsConstants.O_RDONLY, 0);
        try {
            step.reached("dir-sync");
            Os.fsync(dir);
        } finally { Os.close(dir); }
        step.reached("ready");
    }

    private void writeRange(FileDescriptor file, int start, int end) throws IOException, ErrnoException {
        while (start < end) {
            int written = Os.write(file, contents, start, end - start);
            if (written <= 0) throw new IOException("ticket write made no progress");
            start += written;
        }
    }

    boolean intact() throws IOException {
        return ready.isFile() && Arrays.equals(Files.readAllBytes(ready.toPath()), contents);
    }

    void recover(SQLiteDatabase db) throws IOException {
        Files.deleteIfExists(staging.toPath());
        if (DatabaseUtils.longForQuery(db, "SELECT count(*) FROM history WHERE asset=?",
                new String[]{ready.getName()}) == 0) {
            Files.deleteIfExists(ready.toPath());
        } else if (!intact()) {
            throw new IOException("historically referenced fixture ticket is missing or corrupt");
        }
    }
}
