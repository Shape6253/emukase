import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import java.io.FileNotFoundException;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read real filesystem metadata through a provider-owned, read-only descriptor. */
public final class MediaStoreStat {
    private MediaStoreStat() {}

    public static void main(String[] args) {
        try {
            if (args.length == 2 && args[0].equals("--entries")) {
                readEntries(args[1]);
                System.exit(0);
                return;
            }
            if (args.length < 2 || args.length > 5 || !args[0].matches("0|[1-9][0-9]{0,8}")
                    || !args[1].matches("[1-9][0-9]{0,18}")
                    || (args.length >= 3 && !args[2].matches("[A-Za-z0-9_.-]{1,64}"))
                    || (args.length >= 4 && !args[3].matches("[1-3]"))
                    || (args.length == 5 && !args[4].equals("parent"))) {
                throw new IllegalArgumentException("Invalid MediaStore stat identity.");
            }
            final int user = Integer.parseInt(args[0]);
            final long id = Long.parseLong(args[1]);
            requireUser(user);
            final Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
            final Class<?> managerType = Class.forName("android.app.IActivityManager");
            final IBinder token = new Binder();
            final boolean scopedRelease = Build.VERSION.SDK_INT >= 29;
            final Method release = scopedRelease
                    ? managerType.getMethod("removeContentProviderExternalAsUser", String.class, IBinder.class, int.class)
                    : managerType.getMethod("removeContentProviderExternal", String.class, IBinder.class);
            final Object holder = scopedRelease
                    ? managerType.getMethod("getContentProviderExternal", String.class, int.class, IBinder.class, String.class)
                            .invoke(manager, "media", user, token, "*cmd*")
                    : managerType.getMethod("getContentProviderExternal", String.class, int.class, IBinder.class)
                            .invoke(manager, "media", user, token);
            if (holder == null) throw new IllegalStateException("MediaStore is unavailable.");
            try {
                final Object provider = holder.getClass().getField("provider").get(holder);
                readStat(provider, user, id, args.length >= 3 ? args[2] : null,
                        args.length >= 4 ? Integer.parseInt(args[3]) : 1, args.length == 5);
            } finally {
                if (scopedRelease) release.invoke(manager, "media", token, user);
                else release.invoke(manager, "media", token);
            }
        } catch (Exception exception) {
            System.out.println("ERROR: Android MediaStore stat failed (" + exception.getClass().getSimpleName() + ").");
        }
        System.exit(0);
    }

    private static void readEntries(String path) throws Exception {
        if (Build.VERSION.SDK_INT < 31 || !path.matches("/data/local/tmp/emukase-media-entries-[a-f0-9-]{36}/request\\.json")) {
            throw new IllegalArgumentException("Invalid entry metadata request.");
        }
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(path)) {
            final byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > 1048576) throw new IllegalArgumentException("Entry request is too large.");
                bytes.write(buffer, 0, count);
            }
        }
        final JSONObject request = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        if (!(request.get("user") instanceof Integer) || request.getInt("user") < 0) throw new IllegalArgumentException("Invalid Android profile.");
        final int user = request.getInt("user");
        final JSONArray records = request.getJSONArray("records");
        if (records.length() < 1 || records.length() > 64) throw new IllegalArgumentException("Invalid entry batch.");
        final Set<String> ids = new HashSet<>();
        for (int index = 0; index < records.length(); index++) {
            final JSONObject record = records.getJSONObject(index);
            final String entryPath = record.getString("path");
            final String id = record.getString("id");
            if (!(record.get("id") instanceof String) || !(record.get("path") instanceof String)
                    || !id.matches("[1-9][0-9]{0,18}") || !ids.add(id)
                    || !entryPath.startsWith("/storage/emulated/" + user + "/") || entryPath.length() > 2048
                    || entryPath.matches("(?s).*[\\x00-\\x1f\\x7f].*") || entryPath.contains("//") || entryPath.endsWith("/")
                    || java.util.Arrays.asList(entryPath.split("/")).contains(".") || java.util.Arrays.asList(entryPath.split("/")).contains("..")) {
                throw new IllegalArgumentException("Invalid entry identity.");
            }
        }
        requireUser(user);
        final Object manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
        final Class<?> type = Class.forName("android.app.IActivityManager");
        final IBinder token = new Binder();
        final Object holder = type.getMethod("getContentProviderExternal", String.class, int.class, IBinder.class, String.class)
                .invoke(manager, "media", user, token, "*cmd*");
        if (holder == null) throw new IllegalStateException("MediaStore unavailable.");
        final JSONObject states = new JSONObject();
        try {
            final Object provider = holder.getClass().getField("provider").get(holder);
            for (int index = 0; index < records.length(); index++) {
                requireUser(user);
                final JSONObject record = records.getJSONObject(index);
                final String id = record.getString("id");
                try (ParcelFileDescriptor descriptor = openFile(provider, Uri.parse("content://media/external/file/" + id + "?includePending=1"))) {
                    if (descriptor == null) throw new IllegalStateException("Missing entry descriptor.");
                    final String resolved = Os.readlink("/proc/self/fd/" + descriptor.getFd());
                    final String expected = record.getString("path");
                    if (!resolved.equals(expected) && !resolved.equals(expected.replaceFirst("^/storage/emulated/", "/mnt/user/" + user + "/emulated/"))) {
                        throw new IllegalStateException("Entry descriptor identity changed.");
                    }
                    final StructStat stat = Os.fstat(descriptor.getFileDescriptor());
                    states.put(id, OsConstants.S_ISDIR(stat.st_mode) ? "directory" : OsConstants.S_ISREG(stat.st_mode) ? "file" : "failed");
                } catch (FileNotFoundException exception) {
                    if (exception.getMessage() == null || !exception.getMessage().contains("ENOENT")) throw exception;
                    states.put(id, "missing");
                }
            }
            requireUser(user);
        } finally {
            type.getMethod("removeContentProviderExternalAsUser", String.class, IBinder.class, int.class).invoke(manager, "media", token, user);
        }
        System.out.println("media-entries:" + states);
    }

    private static void readStat(Object provider, int user, long id, String name, int minimum, boolean parent) throws Exception {
        final Uri uri = Uri.parse("content://media/external/file/" + id + "?includePending=1");
        try (ParcelFileDescriptor descriptor = openFile(provider, uri)) {
            if (descriptor == null) throw new IllegalStateException("Missing MediaStore descriptor.");
            final StructStat stat = Os.fstat(descriptor.getFileDescriptor());
            if (name != null) {
                if (!OsConstants.S_ISDIR(stat.st_mode)) throw new IllegalStateException("Not a directory.");
                // The provider's descriptor reaches the selected profile even
                // when its FUSE path is inaccessible in shell's mount namespace.
                final String descriptorPath = "/proc/self/fd/" + descriptor.getFd();
                if (parent) {
                    final String resolved = Os.readlink(descriptorPath);
                    if (!resolved.equals("/storage/emulated/" + user + "/" + name)
                            && !resolved.equals("/mnt/user/" + user + "/emulated/" + user + "/" + name)) {
                        throw new IllegalStateException("The root child directory does not match.");
                    }
                }
                final String[] names = new File(descriptorPath + (parent ? "/.." : "")).list();
                if (names == null || names.length == 0 || names.length > 65536) {
                    throw new IllegalStateException("Directory names are unavailable.");
                }
                boolean found = false;
                int limit = parent ? Math.min(name.length(), minimum == 3 ? 3 : 2) : name.length();
                for (String entry : names) {
                    if (entry.equals(name)) found = true;
                    limit = Math.min(limit, entry.length());
                }
                if (!found || limit == 0) throw new IllegalStateException("Document name is unavailable.");
                String prefix = name.substring(0, limit);
                for (int length = Math.min(minimum, limit); length < limit; length++) {
                    final String candidate = name.substring(0, length);
                    boolean ambiguous = false;
                    for (String entry : names) {
                        if (!entry.equals(name) && entry.regionMatches(true, 0, candidate, 0, length)) {
                            ambiguous = true;
                            break;
                        }
                    }
                    if (!ambiguous) {
                        prefix = candidate;
                        break;
                    }
                }
                requireUser(user);
                System.out.println("media-prefix:" + user + ":" + id + ":" + name + ":" + prefix);
                return;
            }
            if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_size < 0 || stat.st_mtime < 0) {
                throw new IllegalStateException("Invalid regular-file metadata.");
            }
            requireUser(user);
            System.out.println("media-stat:" + user + ":" + id + ":" + stat.st_mtime + ":" + stat.st_size);
        } catch (FileNotFoundException exception) {
            if (exception.getMessage() == null || !exception.getMessage().contains("ENOENT")) throw exception;
            requireUser(user);
            System.out.println("media-missing:" + user + ":" + id);
        }
    }

    private static ParcelFileDescriptor openFile(Object provider, Uri uri) throws Exception {
        final Class<?> type = Class.forName("android.content.IContentProvider");
        final Class<?> cancellation = Class.forName("android.os.ICancellationSignal");
        try {
            // Match the platform content CLI's explicit API-version signatures.
            if (Build.VERSION.SDK_INT >= 31) {
                final Class<?> attribution = Class.forName("android.content.AttributionSource");
                final Class<?> builderType = Class.forName("android.content.AttributionSource$Builder");
                final Object builder = builderType.getConstructor(int.class).newInstance(Process.myUid());
                builderType.getMethod("setPackageName", String.class).invoke(builder, "com.android.shell");
                final Object source = builderType.getMethod("build").invoke(builder);
                return (ParcelFileDescriptor) type.getMethod("openFile", attribution, Uri.class, String.class, cancellation)
                        .invoke(provider, source, uri, "r", null);
            }
            if (Build.VERSION.SDK_INT == 30) {
                return (ParcelFileDescriptor) type.getMethod("openFile", String.class, String.class, Uri.class,
                        String.class, cancellation, IBinder.class).invoke(provider, null, null, uri, "r", null, null);
            }
            return (ParcelFileDescriptor) type.getMethod("openFile", String.class, Uri.class, String.class,
                    cancellation, IBinder.class).invoke(provider, null, uri, "r", null, null);
        } catch (InvocationTargetException exception) {
            final Throwable cause = exception.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw exception;
        }
    }

    private static void requireUser(int user) throws Exception {
        final Object current = Class.forName("android.app.ActivityManager")
                .getMethod("getCurrentUser").invoke(null);
        if (!(current instanceof Integer) || ((Integer) current).intValue() != user) {
            throw new IllegalStateException("The selected Android profile changed.");
        }
    }
}
