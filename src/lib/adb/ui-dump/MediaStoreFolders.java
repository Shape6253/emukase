import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Query and create indexed folders without the content shell command. */
public final class MediaStoreFolders {
    private static final Uri FILES = Uri.parse("content://media/external/file");
    private static final int DIRECTORY_FORMAT = 12289;
    private static final int BATCH_LIMIT = 32;
    private static final int MAX_FOLDER_PATH_LENGTH = 2048;
    private static final String MARKER_PREFIX = "emukase-folder-";
    private static final String MARKER_EXTENSION = ".bin";
    // Record readers also handle marker paths, including during journal recovery.
    private static final int MAX_RECORD_PATH_LENGTH = MAX_FOLDER_PATH_LENGTH + 1 + MARKER_PREFIX.length()
            + 36 + 1 + String.valueOf(BATCH_LIMIT - 1).length() + MARKER_EXTENSION.length();
    private static final int REQUEST_LIMIT = 262144;

    private MediaStoreFolders() {}

    public static void main(String[] args) {
        try {
            if (args.length != 2 || !args[0].matches("query|create")
                    || !args[1].matches("/data/local/tmp/emukase-media-folders-[a-f0-9-]{36}/request\\.json")) {
                throw new IllegalArgumentException("Invalid MediaStore folder request.");
            }
            if (Build.VERSION.SDK_INT < MediaStoreProvider.MIN_SDK) {
                System.out.println("media-folders:unsupported");
                return;
            }
            final JSONObject request = readJson(new File(args[1]));
            final int user = request.getInt("user");
            final JSONArray paths = request.getJSONArray("paths");
            validate(user, paths, args[0].equals("create"));
            requireUser(user);
            final Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
            final Class<?> type = Class.forName("android.app.IActivityManager");
            final IBinder token = new Binder();
            final Object holder = type.getMethod("getContentProviderExternal", String.class, int.class,
                    IBinder.class, String.class).invoke(manager, "media", user, token, "*cmd*");
            if (holder == null) throw new IllegalStateException("MediaStore is unavailable.");
            try {
                final MediaStoreProvider provider;
                try {
                    provider = MediaStoreProvider.attach(holder.getClass().getField("provider").get(holder));
                } catch (ReflectiveOperationException | UnsupportedOperationException error) {
                    // The session could not attach at all; no operation was attempted.
                    System.out.println("media-folders:unsupported");
                    return;
                }
                if (args[0].equals("query")) {
                    System.out.println("media-folders:" + queryPaths(provider, user, paths));
                } else {
                    System.out.println("media-folders:" + recoverAndCreate(provider, user, paths));
                }
            } finally {
                type.getMethod("removeContentProviderExternalAsUser", String.class, IBinder.class, int.class)
                        .invoke(manager, "media", token, user);
            }
        } catch (Exception exception) {
            final Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            System.out.println("ERROR: Android MediaStore folders failed (" + cause.getClass().getSimpleName() + ").");
        }
        System.exit(0);
    }

    private static void validate(int user, JSONArray paths, boolean create) throws Exception {
        if (user < 0 || paths.length() < 1 || paths.length() > BATCH_LIMIT) {
            throw new IllegalArgumentException("Invalid MediaStore folder batch.");
        }
        final String prefix = "/storage/emulated/" + user + "/";
        final Set<String> unique = new HashSet<>();
        for (int index = 0; index < paths.length(); index++) {
            if (!(paths.get(index) instanceof String)) throw new IllegalArgumentException("Invalid MediaStore path.");
            final String path = paths.getString(index);
            if (!path.startsWith(prefix) || path.length() > MAX_FOLDER_PATH_LENGTH || !unique.add(path)
                    || path.matches("(?s).*[\\x00-\\x1f\\x7f\"*:<>?\\\\|].*")
                    || path.contains("//") || path.endsWith("/")) {
                throw new IllegalArgumentException("Invalid MediaStore path.");
            }
            final String relative = path.substring(prefix.length());
            final List<String> parts = Arrays.asList(relative.split("/"));
            if (relative.isEmpty() || parts.contains(".") || parts.contains("..")) {
                throw new IllegalArgumentException("Invalid MediaStore path.");
            }
            if (!create) continue;
            if (relative.contains(".") || parts.contains("Android")) {
                throw new IllegalArgumentException("Invalid MediaStore folder path.");
            }
            for (String part : parts) {
                if (part.getBytes(StandardCharsets.UTF_8).length > 255) {
                    throw new IllegalArgumentException("Invalid MediaStore folder name.");
                }
            }
        }
    }

    private static JSONArray queryPaths(MediaStoreProvider provider, int user, JSONArray paths) throws Exception {
        final String[] requested = new String[paths.length()];
        final Set<String> expected = new HashSet<>();
        for (int index = 0; index < requested.length; index++) {
            requested[index] = paths.getString(index);
            expected.add(requested[index]);
        }
        requireUser(user);
        final Map<String, Record> records = queryByPaths(provider, requested, expected);
        final JSONArray result = new JSONArray();
        for (String path : requested) {
            final Record record = records.get(path);
            if (record != null) result.put(record.json());
        }
        requireUser(user);
        return result;
    }

    private static long markerSlots(JSONArray paths) {
        return (1L << paths.length()) - 1;
    }

    private static List<Temp> markers(JSONArray paths, String nonce, long slots) throws Exception {
        if (!nonce.matches(MediaStoreFolderJournal.NONCE_PATTERN)) {
            throw new IllegalArgumentException("Invalid folder operation nonce.");
        }
        final List<Temp> temps = new ArrayList<>();
        for (int index = 0; index < paths.length(); index++) {
            final long slot = 1L << index;
            if ((slots & slot) != 0) {
                temps.add(new Temp(paths.getString(index), MARKER_PREFIX + nonce + "-" + index + MARKER_EXTENSION, slot));
            }
        }
        return temps;
    }

    private static JSONArray recoverAndCreate(MediaStoreProvider provider, int user, JSONArray paths) throws Exception {
        try (MediaStoreFolderJournal journal = new MediaStoreFolderJournal(user)) {
            final String boot = MediaStoreFolderJournal.currentBoot();
            for (File entry : journal.entries()) {
                final JSONObject previous = journal.read(entry);
                if (previous.getInt("user") != user) throw new IllegalStateException("Folder operation belongs to another profile.");
                final JSONArray pending = previous.getJSONArray("paths");
                validate(user, pending, true);
                final long all = markerSlots(pending);
                final long slots = previous.has("remaining") ? previous.getLong("remaining") : all;
                final long inFlight = previous.has("inFlight") ? previous.getLong("inFlight") : slots;
                if (slots <= 0 || (slots & ~all) != 0 || (inFlight & ~slots) != 0) {
                    throw new IllegalStateException("Invalid recovery marker slots.");
                }
                final String oldBoot = previous.optString("boot");
                final boolean knownBoot = oldBoot.matches(MediaStoreFolderJournal.NONCE_PATTERN);
                // A missing row on this boot may still be committed by MediaStore.
                final boolean mayStillInsert = !knownBoot || boot == null || oldBoot.equals(boot);
                final CleanupResult result = cleanup(provider, user, markers(pending, previous.getString("nonce"), slots),
                        mayStillInsert ? inFlight : 0);
                if (result.remaining != slots || result.inFlight != inFlight || (!knownBoot && boot != null)) {
                    if (!knownBoot && boot != null) previous.put("boot", boot);
                    finishCleanup(journal, entry, previous, result);
                } else if (result.failure != null) throw result.failure;
            }
            final String nonce = UUID.randomUUID().toString();
            return createFolders(provider, user, paths, nonce, boot, journal);
        }
    }

    private static JSONArray createFolders(MediaStoreProvider provider, int user, JSONArray paths, String nonce,
            String boot, MediaStoreFolderJournal journal) throws Exception {
        final String[] folders = new String[paths.length()];
        final Set<String> expected = new HashSet<>();
        for (int index = 0; index < folders.length; index++) {
            folders[index] = paths.getString(index);
            expected.add(folders[index]);
        }
        final List<Temp> temps = new ArrayList<>();
        long slots = 0;
        requireUser(user);
        final Map<String, Record> existing = queryByPaths(provider, folders, expected);
        for (Temp temp : markers(paths, nonce, markerSlots(paths))) {
            final Record record = existing.get(temp.folder);
            if (record != null) {
                if (record.format != DIRECTORY_FORMAT) {
                    throw new IllegalStateException("Path is occupied by a file: " + temp.folder);
                }
                try {
                    // An indexed directory that still exists needs no temp row.
                    verifyFolderDescriptor(provider, user, record);
                    continue;
                } catch (MissingFolder exception) { /* Recreate a stale directory below. */ }
            }
            temps.add(temp);
            slots |= temp.slot;
        }
        if (temps.isEmpty()) {
            final JSONArray result = new JSONArray();
            for (String folder : folders) result.put(existing.get(folder).json());
            return result;
        }
        final JSONObject operation = new JSONObject().put("user", user).put("nonce", nonce)
                .put("paths", paths).put("remaining", slots).put("boot", boot);
        final File entry = journal.begin(nonce, operation);
        try {
            for (Temp temp : temps) insertFolder(provider, user, temp);
            requireUser(user);
            final String[] names = new String[temps.size()];
            final Set<String> expectedNames = new HashSet<>();
            for (int index = 0; index < temps.size(); index++) {
                names[index] = temps.get(index).name;
                expectedNames.add(names[index]);
            }
            final Map<String, Record> inserted = queryByNames(provider, names, expectedNames);
            for (Temp temp : temps) {
                final Record record = inserted.get(temp.name);
                if (record == null) {
                    // A stale row can outlive its directory when insert fails.
                    // Confirm the physical directory through the provider descriptor.
                    requireIndexedFolder(provider, user, temp.folder, "MediaStore did not create the folder: ");
                    continue;
                }
                if (!isMarker(record, temp, temp.folder + "/" + temp.name)) {
                    throw new IllegalStateException("Unexpected temporary MediaStore record.");
                }
                temp.id = record.id;
            }
        } catch (Exception error) {
            long inFlight = 0;
            long cleanupFailed = 0;
            for (Temp temp : temps) {
                if (!temp.insertStarted) break;
                if (!temp.insertFinished) {
                    // The failed Binder call may still commit after the helper exits.
                    inFlight = temp.slot;
                    break;
                }
                try {
                    cleanupMarker(provider, user, temp);
                } catch (Exception cleanup) {
                    cleanupFailed |= temp.slot;
                    error.addSuppressed(cleanup);
                }
            }
            final long remaining = inFlight | cleanupFailed;
            try {
                saveRemaining(journal, entry, operation, remaining, inFlight);
            } catch (Exception journalFailure) {
                error.addSuppressed(journalFailure);
            }
            throw error;
        }
        finishCleanup(journal, entry, operation, cleanup(provider, user, temps, 0));
        requireUser(user);
        final Map<String, Record> completed = queryByPaths(provider, folders, expected);
        final JSONArray result = new JSONArray();
        for (String folder : folders) {
            final Record record = completed.get(folder);
            if (record == null || record.format != DIRECTORY_FORMAT) {
                throw new IllegalStateException("MediaStore did not index the folder: " + folder);
            }
            // The row can outlive its directory (stale index or race between
            // cleanup and this final check). Confirm the physical directory
            // through the provider descriptor before reporting success.
            verifyFolderDescriptor(provider, user, record);
            result.put(record.json());
        }
        return result;
    }

    /** Fail unless the folder is indexed and its provider descriptor is a directory. */
    private static void requireIndexedFolder(MediaStoreProvider provider, int user, String folder, String prefix) throws Exception {
        final Map<String, Record> found = queryByPaths(provider,
                new String[] { folder }, new HashSet<>(Arrays.asList(folder)));
        final Record record = found.get(folder);
        if (record == null || record.format != DIRECTORY_FORMAT) {
            throw new IllegalStateException(prefix + folder);
        }
        verifyFolderDescriptor(provider, user, record);
    }

    private static void insertFolder(MediaStoreProvider provider, int user, Temp temp) throws Exception {
        final ContentValues values = new ContentValues();
        values.put("_display_name", temp.name);
        values.put("mime_type", "application/octet-stream");
        values.put("relative_path", temp.folder.substring(("/storage/emulated/" + user + "/").length()) + "/");
        requireUser(user);
        temp.insertStarted = true;
        final Uri uri = provider.insert(FILES, values);
        temp.insertFinished = true;
        final String id = uri == null ? null : uri.getLastPathSegment();
        if (id != null && !id.matches("[1-9][0-9]{0,18}")) {
            throw new IllegalStateException("Invalid MediaStore insertion.");
        }
        temp.id = id;
    }

    private static void verifyFolderDescriptor(MediaStoreProvider provider, int user, Record folder) throws Exception {
        requireUser(user);
        try (ParcelFileDescriptor descriptor = provider.open(
                Uri.parse("content://media/external/file/" + folder.id + "?includePending=1"))) {
            if (descriptor == null) throw new IllegalStateException("Missing MediaStore descriptor.");
            final String resolved = Os.readlink("/proc/self/fd/" + descriptor.getFd());
            if (!resolved.equals(folder.path)
                    && !resolved.equals(folder.path.replaceFirst("^/storage/emulated/", "/mnt/user/" + user + "/emulated/"))) {
                throw new IllegalStateException("MediaStore folder identity changed.");
            }
            final StructStat stat = Os.fstat(descriptor.getFileDescriptor());
            if (!OsConstants.S_ISDIR(stat.st_mode)) {
                throw new IllegalStateException("MediaStore path is not a directory.");
            }
        } catch (FileNotFoundException exception) {
            if (exception.getMessage() != null && exception.getMessage().contains("ENOENT")) {
                throw new MissingFolder();
            }
            throw exception;
        }
        requireUser(user);
    }

    private static CleanupResult cleanup(MediaStoreProvider provider, int user, List<Temp> temps, long inFlight) {
        Exception failure = null;
        long remaining = 0;
        for (Temp temp : temps) {
            try {
                if (!cleanupMarker(provider, user, temp)) remaining |= inFlight & temp.slot;
            } catch (Exception error) {
                remaining |= temp.slot;
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            }
        }
        return new CleanupResult(remaining, inFlight & remaining, failure);
    }

    private static void finishCleanup(MediaStoreFolderJournal journal, File entry,
            JSONObject operation, CleanupResult result) throws Exception {
        try {
            saveRemaining(journal, entry, operation, result.remaining, result.inFlight);
        } catch (Exception journalFailure) {
            if (result.failure == null) throw journalFailure;
            result.failure.addSuppressed(journalFailure);
        }
        if (result.failure != null) throw result.failure;
    }

    private static void saveRemaining(MediaStoreFolderJournal journal, File entry,
            JSONObject operation, long remaining, long inFlight) throws Exception {
        if (remaining == 0) journal.clear(entry);
        else journal.write(entry, operation.put("remaining", remaining).put("inFlight", inFlight));
    }

    /** Return false when no record has appeared at the expected identity. */
    private static boolean cleanupMarker(MediaStoreProvider provider, int user, Temp temp) throws Exception {
        requireUser(user);
        final String path = temp.folder + "/" + temp.name;
        final Record record = temp.id == null ? findMarkerByPath(provider, path) : findById(provider, temp.id);
        if (record == null) return false;
        // A moved or repurposed record is no longer owned by this journal.
        if (!isMarker(record, temp, path)) return true;
        final Bundle match = new Bundle();
        match.putString(ContentResolver.QUERY_ARG_SQL_SELECTION,
                "_data COLLATE BINARY=? AND _display_name=? AND (format IS NULL OR format<>?) AND (_size IS NULL OR _size=0)");
        match.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS,
                new String[] { record.path, temp.name, String.valueOf(DIRECTORY_FORMAT) });
        // This helper never writes marker bytes. Do not delete disk data,
        // even if a file appeared at the same path after the read.
        final Uri metadataOnly = record.uri().buildUpon().appendQueryParameter("deletedata", "false").build();
        final Object deleted = provider.delete(metadataOnly, match);
        final Record remaining = findById(provider, record.id);
        if ((!Integer.valueOf(0).equals(deleted) && !Integer.valueOf(1).equals(deleted))
                || isMarker(remaining, temp, path)) {
            throw new IllegalStateException("Temporary record cleanup failed.");
        }
        temp.id = null;
        return true;
    }

    private static boolean isMarker(Record record, Temp temp, String path) {
        return record != null && record.path.equals(path) && record.name.equals(temp.name)
                && record.format != DIRECTORY_FORMAT && record.bytes <= 0;
    }

    private static Map<String, Record> queryByPaths(MediaStoreProvider provider,
            String[] paths, Set<String> expected) throws Exception {
        return query(provider, "_data", paths, expected, true);
    }

    private static Map<String, Record> queryByNames(MediaStoreProvider provider,
            String[] names, Set<String> expected) throws Exception {
        return query(provider, "_display_name", names, expected, false);
    }

    private static Map<String, Record> query(MediaStoreProvider provider, String column,
            String[] values, Set<String> expected, boolean requireFormat) throws Exception {
        if (values.length == 0) return new HashMap<>();
        final StringBuilder selection = new StringBuilder(column).append(" IN (");
        for (int index = 0; index < values.length; index++) {
            if (index > 0) selection.append(',');
            selection.append('?');
        }
        selection.append(')');
        final Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection.toString());
        args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, values);
        final boolean byPath = column.equals("_data");
        final Map<String, Record> records = new HashMap<>();
        try (Cursor cursor = provider.query(FILES,
                new String[] { "_id", "_data", "_display_name", "format", "_size" }, args)) {
            if (cursor == null) throw new IllegalStateException("Missing MediaStore cursor.");
            while (cursor.moveToNext()) {
                final String path = cursor.getString(1);
                final String name = cursor.getString(2);
                if (requireFormat && cursor.isNull(3)) throw new IllegalStateException("Missing MediaStore format.");
                final Record record = new Record(cursor.getString(0), path,
                        cursor.isNull(3) ? -1 : cursor.getInt(3), name, cursor.isNull(4) ? -1 : cursor.getLong(4));
                final String key = byPath ? record.path : record.name;
                if (!expected.contains(key) || records.put(key, record) != null) {
                    throw new IllegalStateException("Unexpected MediaStore record.");
                }
            }
        }
        return records;
    }

    private static Record findById(MediaStoreProvider provider, String id) throws Exception {
        if (!id.matches("[1-9][0-9]{0,18}")) throw new IllegalArgumentException("Invalid MediaStore record ID.");
        return findUnique(provider, "_id=?", id);
    }

    private static Record findMarkerByPath(MediaStoreProvider provider, String path) throws Exception {
        // Use the path index for candidates and match the original casing before reading a row.
        return findUnique(provider, "_data=? AND _data COLLATE BINARY=?", path, path);
    }

    private static Record findUnique(MediaStoreProvider provider, String selection, String... arguments) throws Exception {
        final Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
        args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arguments);
        try (Cursor cursor = provider.query(FILES,
                new String[] { "_id", "_data", "_display_name", "format", "_size" }, args)) {
            if (cursor == null) throw new IllegalStateException("Missing MediaStore cursor.");
            if (!cursor.moveToFirst()) return null;
            final Record record = new Record(cursor.getString(0), cursor.getString(1),
                    cursor.isNull(3) ? -1 : cursor.getInt(3), cursor.getString(2), cursor.isNull(4) ? -1 : cursor.getLong(4));
            if (cursor.moveToNext()) throw new IllegalStateException("Ambiguous MediaStore record.");
            return record;
        }
    }

    private static final class MissingFolder extends Exception {
        private static final long serialVersionUID = 1L;
    }

    private static JSONObject readJson(File file) throws Exception {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(file)) {
            final byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > REQUEST_LIMIT) throw new IllegalArgumentException("Oversized folder request.");
                bytes.write(buffer, 0, count);
            }
        }
        return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
    }

    private static void requireUser(int user) throws Exception {
        if (!Integer.valueOf(user).equals(Class.forName("android.app.ActivityManager")
                .getMethod("getCurrentUser").invoke(null))) {
            throw new IllegalStateException("Android profile changed.");
        }
    }

    private static final class CleanupResult {
        final long remaining;
        final long inFlight;
        final Exception failure;

        CleanupResult(long remaining, long inFlight, Exception failure) {
            this.remaining = remaining;
            this.inFlight = inFlight;
            this.failure = failure;
        }
    }

    private static final class Temp {
        final String folder;
        final String name;
        final long slot;
        String id;
        boolean insertStarted;
        boolean insertFinished;
        Temp(String folder, String name, long slot) {
            this.folder = folder;
            this.name = name;
            this.slot = slot;
        }
    }

    private static final class Record {
        final String id;
        final String path;
        final int format;
        final String name;
        final long bytes;
        Record(String id, String path, int format, String name, long bytes) {
            if (id == null || !id.matches("[1-9][0-9]{0,18}")
                    || path == null || path.length() > MAX_RECORD_PATH_LENGTH || !path.startsWith("/")
                    || path.matches("(?s).*[\\x00-\\x1f\\x7f].*")
                    || path.contains("//") || path.endsWith("/")
                    || Arrays.asList(path.split("/")).contains(".") || Arrays.asList(path.split("/")).contains("..")
                    || format < -1 || format > 65535 || bytes < -1) {
                throw new IllegalArgumentException("Invalid MediaStore record.");
            }
            final String display = name == null ? path.substring(path.lastIndexOf('/') + 1) : name;
            if (display.isEmpty() || display.length() > 255 || display.matches("(?s).*[\\x00-\\x1f\\x7f/].*")) {
                throw new IllegalArgumentException("Invalid MediaStore record.");
            }
            this.id = id;
            this.path = path;
            this.format = format;
            this.name = display;
            this.bytes = bytes;
        }
        Uri uri() {
            return Uri.parse("content://media/external/file/" + id);
        }
        JSONObject json() throws Exception {
            return new JSONObject().put("id", id).put("path", path).put("format", format);
        }
    }
}
