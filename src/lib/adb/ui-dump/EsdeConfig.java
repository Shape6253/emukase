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
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** Small configuration batches keep byte checks and durable recovery on Android. */
public final class EsdeConfig {
    private static final Uri FILES = Uri.parse("content://media/external/file?includePending=1");
    private static final int MAX_BYTES = 2097152;
    private final Object provider;
    private final Object source;
    private final Method query;
    private final Method insert;
    private final Method update;
    private final Method delete;
    private final Method open;
    private final int user;

    private EsdeConfig(Object provider, int user) throws Exception {
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
            if (args.length != 1 || !args[0].matches("/data/local/tmp/emukase-esde-[a-f0-9-]{36}/request\\.json")) {
                throw new IllegalArgumentException("Invalid configuration request.");
            }
            if (Build.VERSION.SDK_INT < 31) {
                System.out.println("esde-config:unsupported");
                return;
            }
            final JSONObject request;
            try (InputStream input = new FileInputStream(args[0])) {
                request = new JSONObject(new String(read(input, 48 * 1024 * 1024), StandardCharsets.UTF_8));
            }
            if (!(request.get("user") instanceof Integer) || request.getInt("user") < 0) {
                throw new IllegalArgumentException("Invalid Android profile.");
            }
            final int user = request.getInt("user");
            final String recovery = request.getString("recovery");
            validatePath(recovery + "/record.json", user);
            final String operation = request.getString("operation");
            if (!(operation.equals("apply") || operation.equals("recovery") || operation.equals("read"))) {
                throw new IllegalArgumentException("Invalid helper operation.");
            }
            final JSONArray changes = operation.equals("apply") ? request.getJSONArray("changes") : new JSONArray();
            if (operation.equals("apply") && (changes.length() < 1 || changes.length() > 4)) throw new IllegalArgumentException("Invalid batch size.");
            final Set<String> paths = new HashSet<>();
            for (int i = 0; i < changes.length(); i++) {
                final JSONObject change = changes.getJSONObject(i);
                if (!(change.get("path") instanceof String) || !(change.get("token") instanceof String)
                        || !(change.get("applied") instanceof String)
                        || change.get("original") != JSONObject.NULL && !(change.get("original") instanceof String)) {
                    throw new IllegalArgumentException("Invalid configuration change.");
                }
                final String path = change.getString("path");
                validatePath(path, user);
                if (!paths.add(path.toLowerCase(java.util.Locale.ROOT)) || !(path.endsWith(".xml") || path.endsWith(".app"))
                        || !change.getString("token").matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")) {
                    throw new IllegalArgumentException("Invalid configuration identity.");
                }
                if (!change.isNull("original")) text(change.getString("original"));
                text(change.getString("applied"));
            }
            requireUser(user);
            final Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
            final Class<?> managerType = Class.forName("android.app.IActivityManager");
            final IBinder token = new Binder();
            final Object holder = managerType.getMethod("getContentProviderExternal", String.class, int.class,
                    IBinder.class, String.class).invoke(manager, "media", user, token, "*cmd*");
            if (holder == null) throw new IllegalStateException("MediaStore unavailable.");
            final String result;
            try {
                final EsdeConfig config = new EsdeConfig(holder.getClass().getField("provider").get(holder), user);
                if (operation.equals("recovery")) {
                    config.recovery(recovery, request.getJSONObject("record"));
                    result = "esde-recovery:verified";
                } else if (operation.equals("read")) {
                    result = "esde-read:" + config.readFiles(request.getJSONArray("paths"), request.getInt("maxBytes"));
                } else {
                    for (int i = 0; i < changes.length(); i++) config.apply(changes.getJSONObject(i), recovery);
                    result = "esde-config:verified";
                }
            } finally {
                managerType.getMethod("removeContentProviderExternalAsUser", String.class, IBinder.class, int.class)
                        .invoke(manager, "media", token, user);
            }
            System.out.println(result);
        } catch (Exception exception) {
            final Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            System.out.println("ERROR: ES-DE configuration batch failed (" + cause.getClass().getSimpleName() + "). Backups and recovery records were retained.");
        }
        System.exit(0);
    }

    /** Live onboarding journals use the same verified publication as config files,
     * without requiring ES-DE to be stopped or spawning content CLI processes. */
    private void recovery(String directory, JSONObject record) throws Exception {
        final String token = record.getString("token");
        if (!token.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
                || record.getInt("schema") != 1 || record.getInt("user") != user
                || !record.getString("stage").matches("[a-z][a-z-]{0,63}")
                || !record.getString("phase").matches("intent|verified|uncertain")) {
            throw new IllegalArgumentException("Invalid recovery identity.");
        }
        final JSONObject details = record.getJSONObject("details");
        final java.util.Iterator<String> keys = details.keys();
        while (keys.hasNext()) {
            final Object value = details.get(keys.next());
            if (!(value instanceof String || value instanceof Number || value instanceof Boolean)) {
                throw new IllegalArgumentException("Invalid recovery details.");
            }
        }
        final String path = directory + "/" + token + ".json";
        final Record previous = find("_data=? COLLATE NOCASE AND (format IS NULL OR format != 12289)", path);
        final byte[] original = previous == null ? null : contents(previous);
        if (original != null) {
            final JSONObject before = new JSONObject(new String(original, StandardCharsets.UTF_8));
            if (!token.equals(before.getString("token")) || before.getInt("user") != user
                    || !record.getString("stage").equals(before.getString("stage"))) {
                throw new IllegalStateException("Recovery identity changed.");
            }
        }
        replace(path, original, text(record.toString()), false);
    }

    private JSONObject readFiles(JSONArray paths, int limit) throws Exception {
        if (paths.length() < 1 || paths.length() > 16 || limit < 1 || limit > MAX_BYTES) {
            throw new IllegalArgumentException("Invalid read batch.");
        }
        final Set<String> unique = new HashSet<>();
        for (int i = 0; i < paths.length(); i++) {
            if (!(paths.get(i) instanceof String)) throw new IllegalArgumentException("Invalid read path.");
            validatePath(paths.getString(i), user);
            if (!unique.add(paths.getString(i))) throw new IllegalArgumentException("Duplicate read path.");
        }
        final Method call = Class.forName("android.content.IContentProvider").getMethod("call",
                Class.forName("android.content.AttributionSource"), String.class, String.class, String.class, Bundle.class);
        final JSONObject result = new JSONObject();
        for (int i = 0; i < paths.length(); i++) {
            final String path = paths.getString(i);
            requireUser(user);
            if (!(call.invoke(provider, source, "media", "scan_file", path, null) instanceof Bundle)) {
                throw new IllegalStateException("MediaStore scan did not complete.");
            }
            final Record record = find("_data=? COLLATE NOCASE AND (format IS NULL OR format != 12289)", path);
            if (record == null) result.put(path, JSONObject.NULL);
            else {
                if (record.pending || !record.path.equals(path)) throw new IllegalStateException("File identity changed.");
                try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor(record.uri(), "r"))) {
                    final byte[] bytes = read(input, limit);
                    final String value = new String(bytes, StandardCharsets.UTF_8);
                    if (!Arrays.equals(bytes, text(value))) throw new IllegalStateException("Invalid UTF-8 file.");
                    result.put(path, value);
                }
            }
        }
        requireUser(user);
        return result;
    }

    private void apply(JSONObject change, String recovery) throws Exception {
        final String path = change.getString("path");
        final String token = change.getString("token");
        final byte[] original = change.isNull("original") ? null : text(change.getString("original"));
        final byte[] applied = text(change.getString("applied"));
        final String backup = original == null ? "" : path + ".emukase-" + token + ".bak";
        final String journal = recovery + "/" + token + ".json";
        requireStopped();
        requireOriginal(path, original);
        if (original != null) replace(backup, null, original, false);
        final JSONObject details = new JSONObject();
        details.put("path", path);
        details.put("backupPath", backup);
        details.put("originalHash", original == null ? "" : hash(original));
        details.put("appliedHash", hash(applied));
        final JSONObject record = new JSONObject();
        record.put("schema", 1);
        record.put("token", token);
        record.put("user", user);
        record.put("stage", "config-import");
        record.put("phase", "intent");
        record.put("details", details);
        byte[] evidence = record.toString().getBytes(StandardCharsets.UTF_8);
        replace(journal, null, evidence, false);
        try {
            replace(path, original, applied, true);
            record.put("phase", "verified");
            replace(journal, evidence, record.toString().getBytes(StandardCharsets.UTF_8), false);
        } catch (Exception failure) {
            try {
                record.put("phase", "uncertain");
                replace(journal, evidence, record.toString().getBytes(StandardCharsets.UTF_8), false);
            } catch (Exception recoveryFailure) { failure.addSuppressed(recoveryFailure); }
            throw failure;
        }
    }

    /** Keep the previous record until publication and byte verification complete.
     * Recovery backup copies and intents are independent, permanently retained files. */
    private void replace(String path, byte[] original, byte[] replacement, boolean stopped) throws Exception {
        final Record previous = requireOriginal(path, original);
        final String directory = path.substring(0, path.lastIndexOf('/') + 1);
        final String temporary = "emukase-config-" + UUID.randomUUID();
        final int dot = path.lastIndexOf('.');
        final String oldPath = directory + temporary + (dot > path.lastIndexOf('/') ? path.substring(dot) : "");
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
            if (pending == null || !"media".equals(pending.getAuthority()) || pending.getPath() == null
                    || !pending.getPath().matches("/external/file/[1-9][0-9]*")) {
                throw new IllegalStateException("Invalid pending record.");
            }
            final Record inserted = find("_id=?", pending.getLastPathSegment());
            if (inserted == null || !inserted.pending || !parent(inserted.path).equals(directory)) {
                throw new IllegalStateException("Unexpected pending destination.");
            }
            try (FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor(pending, "w"))) {
                output.write(replacement);
                output.flush();
                output.getFD().sync();
            }
            if (stopped) requireStopped();
            final Record current = requireOriginal(path, original);
            if (previous != null && (current == null || !current.id.equals(previous.id))) {
                throw new IllegalStateException("Original file identity changed.");
            }
            if (previous != null) {
                renamed = true;
                rename(previous, oldPath, false);
            }
            final Record fresh = find("_id=?", pending.getLastPathSegment());
            if (fresh == null) throw new IllegalStateException("Pending file disappeared.");
            rename(fresh, path, false);
            requireOriginal(path, replacement);
            requireUser(user);
            published = true;
            if (previous != null) remove(previous.uri());
        } finally {
            if (!published) {
                requireUser(user);
                if (pending != null) remove(pending);
                if (renamed && previous != null) {
                    final Record recover = find("_id=?", previous.id);
                    if (recover == null || !recover.path.equals(oldPath) && !recover.path.equals(path)) {
                        throw new IllegalStateException("Original file recovery failed.");
                    }
                    if (!recover.path.equals(path)) rename(recover, path, false);
                }
            }
        }
    }

    private Record requireOriginal(String path, byte[] expected) throws Exception {
        final Record record = find("_data=? COLLATE NOCASE AND (format IS NULL OR format != 12289)", path);
        if (expected == null ? record != null : record == null || record.pending || !record.path.equals(path)
                || !Arrays.equals(contents(record), expected)) throw new IllegalStateException("Configuration bytes changed.");
        return record;
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

    private void rename(Record record, String path, boolean pending) throws Exception {
        requireUser(user);
        final ContentValues values = new ContentValues();
        values.put("_display_name", path.substring(path.lastIndexOf('/') + 1));
        values.put("is_pending", pending ? 1 : 0);
        if (!Integer.valueOf(1).equals(update.invoke(provider, source, record.uri(), values, null))) {
            throw new IllegalStateException("Rename was not accepted.");
        }
        final Record after = find("_id=?", record.id);
        if (after == null || !after.path.equals(path) || after.pending != pending) {
            throw new IllegalStateException("Rename destination did not match.");
        }
    }

    private void remove(Uri uri) throws Exception {
        requireUser(user);
        if (!Integer.valueOf(1).equals(delete.invoke(provider, source, uri, null))) {
            throw new IllegalStateException("Configuration cleanup failed.");
        }
    }

    private ParcelFileDescriptor descriptor(Uri uri, String mode) throws Exception {
        requireUser(user);
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
        final byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IllegalStateException("Oversized configuration.");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static byte[] text(String value) {
        final byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES || value.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid configuration text.");
        return bytes;
    }

    private static String parent(String path) { return path.substring(0, path.lastIndexOf('/') + 1); }

    private static void validatePath(String path, int user) {
        if (!path.startsWith("/storage/emulated/" + user + "/") || path.length() > 2048
                || path.matches("(?s).*[\\x00-\\x1f\\x7f].*") || path.contains("//") || path.endsWith("/")
                || Arrays.asList(path.split("/")).contains("..") || Arrays.asList(path.split("/")).contains(".")
                || path.startsWith("/storage/emulated/" + user + "/Android/")) {
            throw new IllegalArgumentException("Invalid configuration path.");
        }
    }

    private static String hash(byte[] bytes) throws Exception {
        final StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private void requireStopped() throws Exception {
        requireUser(user);
        final java.lang.Process process = new ProcessBuilder("ps").start();
        final String output;
        try (InputStream input = process.getInputStream()) {
            output = new String(read(input, MAX_BYTES), StandardCharsets.UTF_8);
        }
        if (process.waitFor() != 0) throw new IllegalStateException("Cannot inspect ES-DE process.");
        final String[] lines = output.trim().split("\\r?\\n");
        final String[] header = lines[0].trim().split("\\s+");
        if (header.length < 3 || !(header[0].equals("USER") || header[0].equals("UID"))
                || !header[1].equals("PID") || !header[header.length - 1].equals("NAME")) {
            throw new IllegalStateException("Cannot confirm process ownership.");
        }
        for (String line : lines) {
            final String[] fields = line.trim().split("\\s+");
            if (fields.length > 1 && fields[fields.length - 1].equals("org.es_de.frontend")) {
                final String owner = fields[0];
                if (!fields[1].matches("[1-9][0-9]*") || !owner.matches("(?:[0-9]+|u[0-9]+_[ai][0-9]+)")) {
                    throw new IllegalStateException("Cannot confirm ES-DE process ownership.");
                }
                if (owner.startsWith("u" + user + "_") || owner.matches("[0-9]+") && Long.parseLong(owner) / 100000 == user) {
                    throw new IllegalStateException("ES-DE is running.");
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
