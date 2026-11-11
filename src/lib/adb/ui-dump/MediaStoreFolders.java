import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.lang.reflect.Method;
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
    private static final int REQUEST_LIMIT = 262144;

    private MediaStoreFolders() {}

    public static void main(String[] args) {
        try {
            if (args.length != 2 || !args[0].matches("query|create")
                    || !args[1].matches("/data/local/tmp/emukase-media-folders-[a-f0-9-]{36}/request\\.json")) {
                throw new IllegalArgumentException("Invalid MediaStore folder request.");
            }
            if (Build.VERSION.SDK_INT < 31) {
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
                final Object provider = holder.getClass().getField("provider").get(holder);
                final Class<?> providerType = Class.forName("android.content.IContentProvider");
                final Class<?> attribution = Class.forName("android.content.AttributionSource");
                final Class<?> builderType = Class.forName("android.content.AttributionSource$Builder");
                final Object builder = builderType.getConstructor(int.class).newInstance(Process.myUid());
                builderType.getMethod("setPackageName", String.class).invoke(builder, "com.android.shell");
                final Object source = builderType.getMethod("build").invoke(builder);
                final Class<?> cancellation = Class.forName("android.os.ICancellationSignal");
                final Method query = providerType.getMethod("query", attribution, Uri.class, String[].class, Bundle.class, cancellation);
                if (args[0].equals("query")) {
                    System.out.println("media-folders:" + queryPaths(query, provider, source, user, paths));
                } else {
                    final Method insert = providerType.getMethod("insert", attribution, Uri.class, ContentValues.class, Bundle.class);
                    final Method delete = providerType.getMethod("delete", attribution, Uri.class, Bundle.class);
                    System.out.println("media-folders:" + createFolders(query, insert, delete, provider, source, user, paths));
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
            if (!path.startsWith(prefix) || path.length() > 2048 || !unique.add(path)
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

    private static JSONArray queryPaths(Method query, Object provider, Object source, int user, JSONArray paths) throws Exception {
        final String[] requested = new String[paths.length()];
        final Set<String> expected = new HashSet<>();
        for (int index = 0; index < requested.length; index++) {
            requested[index] = paths.getString(index);
            expected.add(requested[index]);
        }
        requireUser(user);
        final Map<String, Record> records = queryByPaths(query, provider, source, requested, expected);
        final JSONArray result = new JSONArray();
        for (String path : requested) {
            final Record record = records.get(path);
            if (record != null) result.put(record.json());
        }
        requireUser(user);
        return result;
    }

    private static JSONArray createFolders(Method query, Method insert, Method delete,
            Object provider, Object source, int user, JSONArray paths) throws Exception {
        final String[] folders = new String[paths.length()];
        final Set<String> expected = new HashSet<>();
        for (int index = 0; index < folders.length; index++) {
            folders[index] = paths.getString(index);
            expected.add(folders[index]);
        }
        final List<Temp> temps = new ArrayList<>();
        try {
            requireUser(user);
            final Map<String, Record> existing = queryByPaths(query, provider, source, folders, expected);
            for (String folder : folders) {
                final Record record = existing.get(folder);
                if (record != null && record.format != DIRECTORY_FORMAT) {
                    throw new IllegalStateException("Path is occupied by a file: " + folder);
                }
                // Insert on every requested folder, including an already indexed one.
                // Inserting recreates a directory whose MediaStore row outlived the
                // physical directory, which a plain record check cannot detect.
                final Temp temp = new Temp(folder, "emukase-folder-" + UUID.randomUUID() + ".bin", null);
                temps.add(temp);
                insertFolder(insert, provider, source, user, temp);
            }
            requireUser(user);
            final String[] names = new String[temps.size()];
            final Set<String> expectedNames = new HashSet<>();
            for (int index = 0; index < temps.size(); index++) {
                names[index] = temps.get(index).name;
                expectedNames.add(names[index]);
            }
            final Map<String, Record> inserted = queryByNames(query, provider, source, names, expectedNames);
            for (Temp temp : temps) {
                final Record record = inserted.get(temp.name);
                if (record == null) {
                    final Map<String, Record> folder = queryByPaths(query, provider, source,
                            new String[] { temp.folder }, new HashSet<>(Arrays.asList(temp.folder)));
                    if (folder.get(temp.folder) == null || folder.get(temp.folder).format != DIRECTORY_FORMAT) {
                        throw new IllegalStateException("MediaStore did not create the folder: " + temp.folder);
                    }
                    continue;
                }
                if (record.format == DIRECTORY_FORMAT || record.bytes > 0
                        || !parent(record.path).equals(temp.folder) || !temp.name.equals(record.name)) {
                    throw new IllegalStateException("Unexpected temporary MediaStore record.");
                }
                temp.id = record.id;
            }
        } catch (Exception error) {
            try {
                cleanup(delete, query, provider, source, user, temps);
            } catch (Exception cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
        cleanup(delete, query, provider, source, user, temps);
        requireUser(user);
        final Map<String, Record> completed = queryByPaths(query, provider, source, folders, expected);
        final JSONArray result = new JSONArray();
        for (String folder : folders) {
            final Record record = completed.get(folder);
            if (record == null || record.format != DIRECTORY_FORMAT) {
                throw new IllegalStateException("MediaStore did not index the folder: " + folder);
            }
            result.put(record.json());
        }
        return result;
    }

    private static void insertFolder(Method insert, Object provider, Object source, int user, Temp temp) throws Exception {
        final ContentValues values = new ContentValues();
        values.put("_display_name", temp.name);
        values.put("mime_type", "application/octet-stream");
        values.put("relative_path", temp.folder.substring(("/storage/emulated/" + user + "/").length()) + "/");
        requireUser(user);
        final Uri uri = (Uri) insert.invoke(provider, source, FILES, values, null);
        final String id = uri == null ? null : uri.getLastPathSegment();
        if (id != null && !id.matches("[1-9][0-9]{0,18}")) {
            throw new IllegalStateException("Invalid MediaStore insertion.");
        }
        temp.id = id;
    }

    private static void cleanup(Method delete, Method query, Object provider, Object source, int user,
            List<Temp> temps) throws Exception {
        Exception failure = null;
        for (Temp temp : temps) {
            try {
                requireUser(user);
                final Record record = temp.id == null
                        ? findByName(query, provider, source, temp.name)
                        : findById(query, provider, source, temp.id);
                if (record == null) continue;
                if (record.format == DIRECTORY_FORMAT || record.bytes > 0
                        || !parent(record.path).equals(temp.folder) || !temp.name.equals(record.name)) {
                    throw new IllegalStateException("Temporary record identity changed.");
                }
                if (!Integer.valueOf(1).equals(delete.invoke(provider, source, record.uri(), null))
                        || findById(query, provider, source, record.id) != null) {
                    throw new IllegalStateException("Temporary record cleanup failed.");
                }
                temp.id = null;
            } catch (Exception error) {
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            }
        }
        if (failure != null) throw failure;
    }

    private static Map<String, Record> queryByPaths(Method query, Object provider, Object source,
            String[] paths, Set<String> expected) throws Exception {
        return query(query, provider, source, "_data", paths, expected, true);
    }

    private static Map<String, Record> queryByNames(Method query, Object provider, Object source,
            String[] names, Set<String> expected) throws Exception {
        return query(query, provider, source, "_display_name", names, expected, false);
    }

    private static Map<String, Record> query(Method query, Object provider, Object source, String column,
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
        final Map<String, Record> records = new HashMap<>();
        try (Cursor cursor = (Cursor) query.invoke(provider, source, FILES,
                new String[] { "_id", "_data", "_display_name", "format", "_size" }, args, null)) {
            if (cursor == null) throw new IllegalStateException("Missing MediaStore cursor.");
            while (cursor.moveToNext()) {
                final String path = cursor.getString(1);
                final String name = cursor.getString(2);
                if (requireFormat && cursor.isNull(3)) throw new IllegalStateException("Missing MediaStore format.");
                final Record record = new Record(cursor.getString(0), path,
                        cursor.isNull(3) ? -1 : cursor.getInt(3), name, cursor.isNull(4) ? -1 : cursor.getLong(4));
                if (!expected.contains(requireFormat ? record.path : record.name)
                        || records.put(requireFormat ? record.path : record.name, record) != null) {
                    throw new IllegalStateException("Unexpected MediaStore record.");
                }
            }
        }
        return records;
    }

    private static Record findById(Method query, Object provider, Object source, String id) throws Exception {
        if (!id.matches("[1-9][0-9]{0,18}")) throw new IllegalArgumentException("Invalid MediaStore record ID.");
        final Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "_id=?");
        args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] { id });
        try (Cursor cursor = (Cursor) query.invoke(provider, source, FILES,
                new String[] { "_id", "_data", "_display_name", "format", "_size" }, args, null)) {
            if (cursor == null) throw new IllegalStateException("Missing MediaStore cursor.");
            if (!cursor.moveToFirst()) return null;
            final Record record = new Record(cursor.getString(0), cursor.getString(1),
                    cursor.isNull(3) ? -1 : cursor.getInt(3), cursor.getString(2), cursor.isNull(4) ? -1 : cursor.getLong(4));
            if (cursor.moveToNext()) throw new IllegalStateException("Ambiguous MediaStore record.");
            return record;
        }
    }

    private static Record findByName(Method query, Object provider, Object source, String name) throws Exception {
        final Map<String, Record> records = queryByNames(query, provider, source,
                new String[] { name }, new HashSet<>(Arrays.asList(name)));
        return records.get(name);
    }

    private static String parent(String path) {
        final int slash = path.lastIndexOf('/');
        if (slash <= 0) throw new IllegalArgumentException("Invalid MediaStore path.");
        return path.substring(0, slash);
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

    private static final class Temp {
        final String folder;
        final String name;
        String id;
        Temp(String folder, String name, String id) {
            this.folder = folder;
            this.name = name;
            this.id = id;
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
                    || path == null || path.length() > 2048 || !path.startsWith("/")
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
