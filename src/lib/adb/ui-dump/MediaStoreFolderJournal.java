import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import org.json.JSONObject;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;

/** On-device recovery of a folder operation interrupted before marker cleanup. */
final class MediaStoreFolderJournal implements AutoCloseable {
    private static final File PARENT_DIRECTORY = new File("/data/local/tmp");
    private static final File DIRECTORY = new File(PARENT_DIRECTORY, "emukase-folder-journals");
    static final String NONCE_PATTERN = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
    private final int user;
    private final RandomAccessFile lockFile;
    private final FileLock lock;

    MediaStoreFolderJournal(int user) throws Exception {
        try {
            Os.mkdir(DIRECTORY.getPath(), 0700);
        } catch (ErrnoException error) {
            if (error.errno != OsConstants.EEXIST) throw error;
        }
        final StructStat dir = Os.lstat(DIRECTORY.getPath());
        if (!OsConstants.S_ISDIR(dir.st_mode) || dir.st_uid != Process.myUid() || (dir.st_mode & 077) != 0) {
            throw new IllegalStateException("Folder recovery directory is not private.");
        }
        this.user = user;
        lockFile = new RandomAccessFile(new File(DIRECTORY, user + ".lock"), "rw");
        try {
            lock = lockFile.getChannel().tryLock();
            if (lock == null) throw new IllegalStateException("Another folder operation is active.");
        } catch (Exception error) {
            lockFile.close();
            throw error;
        }
    }

    File[] entries() throws Exception {
        final File[] entries = DIRECTORY.listFiles((dir, name) -> name.matches(user + "(?:-" + NONCE_PATTERN + ")?\\.json"));
        if (entries == null) throw new IllegalStateException("Could not list folder recovery entries.");
        return entries;
    }

    JSONObject read(File entry) throws Exception {
        try (FileInputStream input = new FileInputStream(entry)) {
            return new JSONObject(new String(AndroidUiAction.read(input, 262144), StandardCharsets.UTF_8));
        }
    }

    File begin(String nonce, JSONObject request) throws Exception {
        if (!nonce.matches(NONCE_PATTERN)) throw new IllegalArgumentException("Invalid folder operation nonce.");
        final File entry = new File(DIRECTORY, user + "-" + nonce + ".json");
        if (entry.exists()) throw new IllegalStateException("Folder operation already recorded.");
        write(entry, request);
        return entry;
    }

    void write(File entry, JSONObject request) throws Exception {
        final File staging = new File(DIRECTORY, user + ".json.new");
        try (FileOutputStream output = new FileOutputStream(staging)) {
            output.write(request.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        Os.rename(staging.getPath(), entry.getPath());
        syncDirectory(DIRECTORY);
        // The journal directory may also have been created since the last sync.
        syncDirectory(PARENT_DIRECTORY);
    }

    private static void syncDirectory(File directory) throws ErrnoException {
        final FileDescriptor descriptor = Os.open(directory.getPath(),
                OsConstants.O_RDONLY | OsConstants.O_CLOEXEC | OsConstants.O_NOFOLLOW, 0);
        try {
            if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) {
                throw new ErrnoException("open journal directory", OsConstants.ENOTDIR);
            }
            Os.fsync(descriptor);
        } finally {
            Os.close(descriptor);
        }
    }

    void clear(File entry) throws Exception {
        Os.remove(entry.getPath());
    }

    static String currentBoot() {
        try (FileInputStream input = new FileInputStream("/proc/sys/kernel/random/boot_id")) {
            final String boot = new String(AndroidUiAction.read(input, 128), StandardCharsets.UTF_8).trim();
            return boot.matches(NONCE_PATTERN) ? boot : null;
        } catch (Exception unavailable) {
            // Without a boot identity, absence alone cannot settle an insert.
            return null;
        }
    }

    @Override
    public void close() throws java.io.IOException {
        try { lock.release(); }
        finally { lockFile.close(); }
    }
}
