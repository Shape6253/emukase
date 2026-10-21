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

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;

/** Replace a stopped PPSSPP's indexed INI in one provider session. */
public final class PpssppConfig {
    private static final Uri FILES = Uri.parse("content://media/external/file?includePending=1");
    private static final int MAX_BYTES = 131072;
    private final Object provider;
    private final Object source;
    private final Method query;
    private final Method insert;
    private final Method update;
    private final Method delete;
    private final Method open;
    private final int user;

    private PpssppConfig(Object provider, int user) throws Exception {
        this.provider = provider;
        this.user = user;
        final Class<?> type = Class.forName("android.content.IContentProvider");
        final Class<?> attribution = Class.forName("android.content.AttributionSource");
        final Class<?> builderType = Class.forName("android.content.AttributionSource$Builder");
        final Object builder = builderType.getConstructor(int.class).newInstance(Process.myUid());
        builderType.getMethod("setPackageName", String.class).invoke(builder, "com.android.shell");
        source = builderType.getMethod("build").invoke(builder);
        final Class<?> cancellation = Class.forName("android.os.ICancellationSignal");
        query = type.getMethod("query", attribution, Uri.class, String[].class, Bundle.class, cancellation);
        insert = type.getMethod("insert", attribution, Uri.class, ContentValues.class, Bundle.class);
        update = type.getMethod("update", attribution, Uri.class, ContentValues.class, Bundle.class);
        delete = type.getMethod("delete", attribution, Uri.class, Bundle.class);
        open = type.getMethod("openFile", attribution, Uri.class, String.class, cancellation);
    }

    public static void main(String[] args) {
        try {
            if (args.length != 1 || !args[0].matches("/data/local/tmp/emukase-ppsspp-[a-f0-9-]{36}/request\\.json")) {
                throw new IllegalArgumentException("Invalid configuration request.");
            }
            if (Build.VERSION.SDK_INT < 31) {
                System.out.println("ppsspp-config:unsupported");
                return;
            }
            final JSONObject request;
            try (FileInputStream input = new FileInputStream(new File(args[0]))) {
                request = new JSONObject(new String(read(input, MAX_BYTES * 4), StandardCharsets.UTF_8));
            }
            final int user = request.getInt("user");
            final String path = request.getString("path");
            if (request.length() != 4 || !(request.get("user") instanceof Integer)
                    || user < 0 || !path.startsWith("/storage/emulated/" + user + "/")
                    || !path.endsWith("/PSP/SYSTEM/ppsspp.ini") || path.length() > 2048
                    || path.matches("(?s).*[\\x00-\\x1f\\x7f].*")
                    || Arrays.asList(path.split("/")).contains("..")
                    || Arrays.asList(path.split("/")).contains(".") || path.contains("//")
                    || path.startsWith("/storage/emulated/" + user + "/Android/")) {
                throw new IllegalArgumentException("Invalid PPSSPP settings path.");
            }
            final byte[] original = request.getString("original").getBytes(StandardCharsets.UTF_8);
            final byte[] replacement = request.getString("replacement").getBytes(StandardCharsets.UTF_8);
            if (original.length == 0 || replacement.length == 0 || original.length > MAX_BYTES
                    || replacement.length > MAX_BYTES || request.getString("original").indexOf('\0') >= 0
                    || request.getString("replacement").indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid INI size.");
            requireUser(user);
            final Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
            final Class<?> managerType = Class.forName("android.app.IActivityManager");
            final IBinder token = new Binder();
            final Object holder = managerType.getMethod("getContentProviderExternal", String.class, int.class,
                    IBinder.class, String.class).invoke(manager, "media", user, token, "*cmd*");
            if (holder == null) throw new IllegalStateException("MediaStore unavailable.");
            try {
                final Object provider = holder.getClass().getField("provider").get(holder);
                new PpssppConfig(provider, user).replace(path, original, replacement);
            } finally {
                managerType.getMethod("removeContentProviderExternalAsUser", String.class, IBinder.class, int.class)
                        .invoke(manager, "media", token, user);
            }
            System.out.println("ppsspp-config:updated");
        } catch (Exception exception) {
            final Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            System.out.println("ERROR: PPSSPP settings update failed (" + cause.getClass().getSimpleName() + ").");
        }
        System.exit(0);
    }

    private void replace(String path, byte[] original, byte[] replacement) throws Exception {
        final String directory = path.substring(0, path.lastIndexOf('/') + 1);
        final String temporary = "emukase-config-" + UUID.randomUUID();
        final String backup = directory + temporary + ".ini";
        final Record previous = find("_data=? COLLATE NOCASE AND (format IS NULL OR format != 12289)", path);
        if (previous == null || previous.pending || !previous.path.equals(path)
                || !Arrays.equals(contents(previous), original)) throw new IllegalStateException("INI changed.");
        Uri pending = null;
        boolean renamed = false;
        boolean published = false;
        try {
            requireUser(user);
            final ContentValues values = new ContentValues();
            values.put("_display_name", temporary + ".bin");
            values.put("mime_type", "application/octet-stream");
            values.put("relative_path", directory.substring(("/storage/emulated/" + user + "/").length()));
            values.put("is_pending", 1);
            pending = (Uri) insert.invoke(provider, source, FILES, values, null);
            if (pending == null || !"media".equals(pending.getAuthority())
                    || !pending.getPath().matches("/external/file/[1-9][0-9]*")) {
                throw new IllegalStateException("Invalid pending record.");
            }
            final Record inserted = byId(pending.getLastPathSegment());
            if (inserted == null || !inserted.pending || !inserted.path.startsWith(directory)
                    || inserted.path.substring(directory.length()).contains("/")) {
                throw new IllegalStateException("Unexpected pending destination.");
            }
            try (FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor(pending, "w"))) {
                output.write(replacement);
                output.flush();
                output.getFD().sync();
            }
            requireStopped();
            final Record current = byId(previous.id);
            if (current == null || current.pending || !current.path.equals(path)
                    || !Arrays.equals(contents(current), original)) throw new IllegalStateException("INI changed before publication.");
            requireUser(user);
            renamed = true;
            rename(previous, backup, previous.pending);
            final Record fresh = byId(pending.getLastPathSegment());
            if (fresh == null) throw new IllegalStateException("Pending INI disappeared.");
            rename(fresh, path, false);
            final Record completed = byId(pending.getLastPathSegment());
            if (completed == null || completed.pending || !Arrays.equals(contents(completed), replacement)) {
                throw new IllegalStateException("Replacement bytes were not retained.");
            }
            requireUser(user);
            published = true;
            remove(previous.uri());
        } finally {
            if (!published) {
                if (pending != null) remove(pending);
                if (renamed) {
                    final Record recover = byId(previous.id);
                    if (recover == null || !recover.path.equals(backup) && !recover.path.equals(path)) {
                        throw new IllegalStateException("Original INI recovery failed.");
                    }
                    if (!recover.path.equals(path)) rename(recover, path, previous.pending);
                }
            }
        }
    }

    private Record find(String selection, String argument) throws Exception {
        final Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
        args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] { argument });
        try (Cursor cursor = (Cursor) query.invoke(provider, source, FILES,
                new String[] { "_id", "_data", "is_pending" }, args, null)) {
            if (cursor == null) throw new IllegalStateException("Missing cursor.");
            if (!cursor.moveToFirst()) return null;
            final Record record = new Record(cursor.getString(0), cursor.getString(1), cursor.getInt(2) == 1);
            if (cursor.moveToNext()) throw new IllegalStateException("Ambiguous configuration identity.");
            return record;
        }
    }

    private Record byId(String id) throws Exception { return find("_id=?", id); }

    private void rename(Record record, String path, boolean pending) throws Exception {
        final ContentValues values = new ContentValues();
        values.put("_display_name", path.substring(path.lastIndexOf('/') + 1));
        values.put("is_pending", pending ? 1 : 0);
        if (!Integer.valueOf(1).equals(update.invoke(provider, source, record.uri(), values, null))) {
            throw new IllegalStateException("Rename was not accepted.");
        }
        final Record after = byId(record.id);
        if (after == null || !after.path.equals(path) || after.pending != pending) {
            throw new IllegalStateException("Rename destination did not match.");
        }
    }

    private void remove(Uri uri) throws Exception {
        if (!Integer.valueOf(1).equals(delete.invoke(provider, source, uri, null))) {
            throw new IllegalStateException("Configuration cleanup failed.");
        }
    }

    private ParcelFileDescriptor descriptor(Uri uri, String mode) throws Exception {
        final ParcelFileDescriptor descriptor = (ParcelFileDescriptor) open.invoke(provider, source, uri, mode, null);
        if (descriptor == null) throw new IllegalStateException("No file descriptor.");
        return descriptor;
    }

    private byte[] contents(Record record) throws Exception {
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor(record.uri(), "r"))) {
            return read(input, MAX_BYTES);
        }
    }

    private static byte[] read(InputStream input, int limit) throws Exception {
        final ByteArrayOutputStream output = new ByteArrayOutputStream();
        final byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IllegalStateException("Oversized configuration.");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private void requireStopped() throws Exception {
        requireUser(user);
        final java.lang.Process process = new ProcessBuilder("ps").start();
        final String output;
        try (InputStream input = process.getInputStream()) {
            output = new String(read(input, 2097152), StandardCharsets.UTF_8);
        }
        if (process.waitFor() != 0) throw new IllegalStateException("Cannot inspect PPSSPP process.");
        final String[] lines = output.trim().split("\\r?\\n");
        final String[] header = lines[0].trim().split("\\s+");
        if (header.length < 3 || !(header[0].equals("USER") || header[0].equals("UID"))
                || !header[1].equals("PID") || !header[header.length - 1].equals("NAME")) {
            throw new IllegalStateException("Cannot confirm process ownership.");
        }
        for (String line : lines) {
            final String[] fields = line.trim().split("\\s+");
            if (fields.length > 1 && fields[fields.length - 1].equals("org.ppsspp.ppsspp")) {
                final String owner = fields[0];
                if (!fields[1].matches("[1-9][0-9]*") || !owner.matches("(?:[0-9]+|u[0-9]+_[ai][0-9]+)")) {
                    throw new IllegalStateException("Cannot confirm PPSSPP process ownership.");
                }
                if (owner.startsWith("u" + user + "_")
                        || owner.matches("[0-9]+") && Long.parseLong(owner) / 100000 == user) {
                    throw new IllegalStateException("PPSSPP is running.");
                }
            }
        }
    }

    private static void requireUser(int user) throws Exception {
        if (!Integer.valueOf(user).equals(Class.forName("android.app.ActivityManager")
                .getMethod("getCurrentUser").invoke(null))) throw new IllegalStateException("Android profile changed.");
    }

    private static final class Record {
        final String id;
        final String path;
        final boolean pending;
        Record(String id, String path, boolean pending) { this.id = id; this.path = path; this.pending = pending; }
        Uri uri() { return Uri.parse("content://media/external/file/" + id + "?includePending=1"); }
    }
}
