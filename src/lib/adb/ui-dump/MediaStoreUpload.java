import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Batch upload metadata around the existing cancellable content stream. */
public final class MediaStoreUpload {
    private static final Uri FILES = Uri.parse("content://media/external/file?includePending=1");
    private final Object provider;
    private final Object source;
    private final Method query;
    private final Method insert;
    private final Method update;
    private final Method delete;
    private final Method open;
    private final JSONObject request;
    private final File journal;
    private final int user;
    private final String directory;
    private final String destination;
    private final String temporary;
    private final String backup;
    private final long bytes;

    private MediaStoreUpload(Object provider, JSONObject request, File journal) throws Exception {
        this.provider = provider;
        this.request = request;
        this.journal = journal;
        user = request.getInt("user");
        directory = request.getString("directory");
        destination = directory + "/" + request.getString("name");
        temporary = request.getString("temporary");
        bytes = request.getLong("bytes");
        final String name = request.getString("name");
        final int dot = name.lastIndexOf('.');
        backup = directory + "/" + temporary.replace("emukase-upload-", "emukase-replaced-")
                .replaceFirst("\\.bin$", "") + (dot < 0 ? "" : name.substring(dot));
        final Class<?> type = Class.forName("android.content.IContentProvider");
        final Class<?> attribution = Class.forName("android.content.AttributionSource");
        final Class<?> builderType = Class.forName("android.content.AttributionSource$Builder");
        final Object builder = builderType.getConstructor(int.class).newInstance(Process.myUid());
        builderType.getMethod("setPackageName", String.class).invoke(builder, "com.android.shell");
        source = builderType.getMethod("build").invoke(builder);
        query = type.getMethod("query", attribution, Uri.class, String[].class, Bundle.class,
                Class.forName("android.os.ICancellationSignal"));
        insert = type.getMethod("insert", attribution, Uri.class, ContentValues.class, Bundle.class);
        update = type.getMethod("update", attribution, Uri.class, ContentValues.class, Bundle.class);
        delete = type.getMethod("delete", attribution, Uri.class, Bundle.class);
        open = type.getMethod("openFile", attribution, Uri.class, String.class, Class.forName("android.os.ICancellationSignal"));
    }

    public static void main(String[] args) {
        try {
            if (args.length != 2 || !args[0].matches("begin|finish|abort")
                    || !args[1].matches("/data/local/tmp/emukase-media-upload-[a-f0-9-]{36}/request\\.json")) {
                throw new IllegalArgumentException("Invalid upload request.");
            }
            if (Build.VERSION.SDK_INT < 31) {
                System.out.println(args[0].equals("abort") ? "media-upload:cleaned" : "media-upload:unsupported");
                return;
            }
            final File requestFile = new File(args[1]);
            final JSONObject request = readJson(requestFile);
            validate(request);
            final int user = request.getInt("user");
            requireUser(user);
            final Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
            final Class<?> type = Class.forName("android.app.IActivityManager");
            final IBinder token = new Binder();
            final Object holder = type.getMethod("getContentProviderExternal", String.class, int.class,
                    IBinder.class, String.class).invoke(manager, "media", user, token, "*cmd*");
            if (holder == null) throw new IllegalStateException("MediaStore unavailable.");
            try {
                final MediaStoreUpload upload = new MediaStoreUpload(holder.getClass().getField("provider").get(holder),
                        request, new File(requestFile.getParentFile(), "state.json"));
                if (args[0].equals("begin")) upload.begin();
                else if (args[0].equals("finish")) upload.finish();
                else {
                    upload.rollback();
                    System.out.println("media-upload:cleaned");
                }
            } finally {
                type.getMethod("removeContentProviderExternalAsUser", String.class, IBinder.class, int.class)
                        .invoke(manager, "media", token, user);
            }
        } catch (Exception exception) {
            final Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            System.out.println("ERROR: Android provider upload failed (" + cause.getClass().getSimpleName() + ").");
        }
        System.exit(0);
    }

    private static void validate(JSONObject request) throws Exception {
        final int user = request.getInt("user");
        final String directory = request.getString("directory");
        final String prefix = "/storage/emulated/" + user + "/";
        final String name = request.getString("name");
        final String mime = request.optString("mimeType", "");
        if (!(request.get("user") instanceof Integer)
                || !(request.get("bytes") instanceof Integer || request.get("bytes") instanceof Long)
                || !(request.get("directory") instanceof String) || !(request.get("name") instanceof String)
                || !(request.get("temporary") instanceof String) || !(request.get("mimeType") instanceof String)
                || user < 0 || !directory.startsWith(prefix)
                || directory.length() > 2048 || directory.contains("//") || directory.endsWith("/")
                || directory.matches("(?s).*[\\x00-\\x1f\\x7f].*")
                || Arrays.asList(directory.substring(prefix.length()).split("/")).contains("Android")
                || Arrays.asList(directory.split("/")).contains("..") || Arrays.asList(directory.split("/")).contains(".")
                || name.isEmpty() || name.equals(".") || name.equals("..") || name.getBytes(StandardCharsets.UTF_8).length > 255
                || name.matches("(?s).*[\\x00-\\x1f\\x7f/\\\\\"*:<>?|].*")
                || !request.getString("temporary").matches("emukase-upload-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.bin")
                || request.getLong("bytes") < 0 || request.getLong("bytes") > 9007199254740991L
                || !(request.get("replaceExisting") instanceof Boolean)
                || !mime.isEmpty() && !mime.matches("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")) {
            throw new IllegalArgumentException("Invalid upload destination.");
        }
    }

    private void begin() throws Exception {
        if (journal.exists()) throw new IllegalStateException("Upload already started.");
        final Record previous = request.getBoolean("replaceExisting")
                ? find("_data=? COLLATE NOCASE AND (format IS NULL OR format != 12289)", destination) : null;
        if (previous != null && (previous.pending || !parent(previous.path).equals(directory))) {
            throw new IllegalStateException("Existing file is not ready for replacement.");
        }
        final JSONObject state = new JSONObject();
        state.put("previous", previous == null ? JSONObject.NULL : previous.json());
        if (previous != null) state.put("originalStamp", stamp(previous));
        state.put("published", false);
        save(state);
        requireUser(user);
        final ContentValues values = new ContentValues();
        values.put("_display_name", temporary);
        values.put("mime_type", "application/octet-stream");
        values.put("relative_path", directory.substring(("/storage/emulated/" + user + "/").length()) + "/");
        values.put("is_pending", 1);
        final Uri uri = (Uri) insert.invoke(provider, source, FILES, values, null);
        if (uri == null || !"media".equals(uri.getAuthority()) || uri.getPath() == null
                || !uri.getPath().matches("/external/file/[1-9][0-9]*")) throw new IllegalStateException("Invalid pending URI.");
        final Record pending = byId(uri.getLastPathSegment());
        requirePending(pending);
        state.put("pending", pending.json());
        save(state);
        System.out.println("media-upload:pending:" + pending.id);
    }

    private void finish() throws Exception {
        boolean published = false;
        try {
            final JSONObject state = readJson(journal);
            if (state.getBoolean("published")) throw new IllegalStateException("Upload already published.");
            final Record pending = byId(state.getJSONObject("pending").getString("id"));
            requirePending(pending);
            try (ParcelFileDescriptor descriptor = descriptor(pending)) {
                final StructStat stat = Os.fstat(descriptor.getFileDescriptor());
                if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_size != bytes) {
                    throw new IllegalStateException("Incomplete upload.");
                }
            }
            final JSONObject original = state.optJSONObject("previous");
            final Record previous = original == null ? null : byId(original.getString("id"));
            if (original != null) {
                if (previous == null || !previous.path.equals(original.getString("path")) || previous.pending
                        || !stamp(previous).equals(state.getString("originalStamp"))) {
                    throw new IllegalStateException("Original file changed during upload.");
                }
                rename(previous, backup, previous.pending, null);
            }
            rename(pending, destination, false, request.optString("mimeType", ""));
            final Record completed = byId(pending.id);
            if (completed == null || completed.pending || !completed.path.equals(destination) || completed.bytes != bytes) {
                throw new IllegalStateException("Published destination or size did not match.");
            }
            state.put("published", true);
            save(state);
            published = true;
            if (previous != null) remove(previous.id);
            System.out.println("media-upload:published");
        } finally {
            if (!published) rollback();
        }
    }

    private void rollback() throws Exception {
        final JSONObject state = journal.exists() ? readJson(journal) : new JSONObject();
        final JSONObject pendingState = state.optJSONObject("pending");
        final Record pending = pendingState == null ? find("_display_name=?", temporary) : byId(pendingState.getString("id"));
        final JSONObject previousState = state.optJSONObject("previous");
        if (state.optBoolean("published", false)) {
            if (pending == null || pending.pending || !pending.path.equals(destination) || pending.bytes != bytes) {
                throw new IllegalStateException("Published file changed before cleanup.");
            }
        } else if (pending != null) {
            // Publication can append a collision suffix before verification
            // rejects it. The journal still owns this exact newly inserted ID.
            if (!parent(pending.path).equals(directory)) {
                throw new IllegalStateException("Partial file identity changed.");
            }
            remove(pending.id);
        }
        if (previousState != null) {
            final Record previous = byId(previousState.getString("id"));
            final String originalPath = previousState.getString("path");
            if (!parent(originalPath).equals(directory)) throw new IllegalStateException("Invalid original file identity.");
            if (previous == null) {
                if (!state.optBoolean("published", false)) throw new IllegalStateException("Original file is missing.");
            } else if (state.optBoolean("published", false)) {
                if (!previous.path.equals(backup)) throw new IllegalStateException("Backup identity changed.");
                remove(previous.id);
            } else if (previous.path.equals(backup)) {
                rename(previous, originalPath, previousState.getBoolean("pending"), null);
            } else if (!previous.path.equals(originalPath)) throw new IllegalStateException("Original file identity changed.");
        }
    }

    private Record find(String selection, String argument) throws Exception {
        final Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
        args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] { argument });
        try (Cursor cursor = (Cursor) query.invoke(provider, source, FILES,
                new String[] { "_id", "_data", "_size", "is_pending", "mime_type" }, args, null)) {
            if (cursor == null) throw new IllegalStateException("Missing upload cursor.");
            if (!cursor.moveToFirst()) return null;
            final Record record = new Record(cursor.getString(0), cursor.getString(1), cursor.isNull(2) ? -1 : cursor.getLong(2),
                    cursor.getInt(3) == 1, cursor.getString(4));
            if (cursor.moveToNext()) throw new IllegalStateException("Ambiguous upload record.");
            return record;
        }
    }

    private Record byId(String id) throws Exception {
        if (!id.matches("[1-9][0-9]{0,18}")) throw new IllegalArgumentException("Invalid upload record ID.");
        return find("_id=?", id);
    }

    private void rename(Record record, String path, boolean pending, String mime) throws Exception {
        requireUser(user);
        final ContentValues values = new ContentValues();
        values.put("_display_name", path.substring(path.lastIndexOf('/') + 1));
        values.put("is_pending", pending ? 1 : 0);
        if (mime != null && !mime.isEmpty()) values.put("mime_type", mime);
        if (!Integer.valueOf(1).equals(update.invoke(provider, source, record.uri(), values, null))) {
            throw new IllegalStateException("Upload rename failed.");
        }
        final Record after = byId(record.id);
        if (after == null || !after.path.equals(path) || after.pending != pending
                || mime != null && !mime.isEmpty() && !mime.equals(after.mime)) {
            throw new IllegalStateException("Upload rename was not confirmed.");
        }
    }

    private void remove(String id) throws Exception {
        requireUser(user);
        final Record record = byId(id);
        if (record == null) return;
        if (!parent(record.path).equals(directory)) throw new IllegalStateException("Upload cleanup escaped its directory.");
        if (!Integer.valueOf(1).equals(delete.invoke(provider, source, record.uri(), null)) || byId(id) != null) {
            throw new IllegalStateException("Upload cleanup failed.");
        }
    }

    private ParcelFileDescriptor descriptor(Record record) throws Exception {
        final ParcelFileDescriptor descriptor = (ParcelFileDescriptor) open.invoke(provider, source, record.uri(), "r", null);
        if (descriptor == null) throw new IllegalStateException("Missing upload descriptor.");
        return descriptor;
    }

    private String stamp(Record record) throws Exception {
        try (ParcelFileDescriptor descriptor = descriptor(record)) {
            final StructStat stat = Os.fstat(descriptor.getFileDescriptor());
            if (!OsConstants.S_ISREG(stat.st_mode)) throw new IllegalStateException("Original is not a regular file.");
            return stat.st_dev + ":" + stat.st_ino + ":" + stat.st_size + ":" + stat.st_mtim.tv_sec + ":" + stat.st_mtim.tv_nsec;
        }
    }

    private void requirePending(Record record) throws Exception {
        if (record == null || !record.pending || !temporaryPath(record.path)) {
            throw new IllegalStateException("Unexpected pending file identity.");
        }
    }

    private boolean temporaryPath(String path) {
        if (!parent(path).equals(directory)) return false;
        final String name = path.substring(path.lastIndexOf('/') + 1);
        return name.equals(temporary) || name.matches("\\.pending-[0-9]+-" + temporary.replace(".", "\\."));
    }

    private static String parent(String path) { return path.substring(0, path.lastIndexOf('/')); }

    private void save(JSONObject state) throws Exception {
        final File temporary = new File(journal.getParentFile(), "state.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(state.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        Os.rename(temporary.getPath(), journal.getPath());
    }

    private static JSONObject readJson(File file) throws Exception {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(file)) {
            final byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > 16384) throw new IllegalArgumentException("Oversized upload request.");
                bytes.write(buffer, 0, count);
            }
        }
        return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
    }

    private static void requireUser(int user) throws Exception {
        if (!Integer.valueOf(user).equals(Class.forName("android.app.ActivityManager")
                .getMethod("getCurrentUser").invoke(null))) throw new IllegalStateException("Android profile changed.");
    }

    private static final class Record {
        final String id;
        final String path;
        final long bytes;
        final boolean pending;
        final String mime;
        Record(String id, String path, long bytes, boolean pending, String mime) {
            this.id = id; this.path = path; this.bytes = bytes; this.pending = pending; this.mime = mime;
        }
        Uri uri() { return Uri.parse("content://media/external/file/" + id + "?includePending=1"); }
        JSONObject json() throws Exception {
            return new JSONObject().put("id", id).put("path", path).put("bytes", bytes).put("pending", pending);
        }
    }
}
