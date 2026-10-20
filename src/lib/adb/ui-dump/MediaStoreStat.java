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
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** Read real filesystem metadata through a provider-owned, read-only descriptor. */
public final class MediaStoreStat {
    private MediaStoreStat() {}

    public static void main(String[] args) {
        try {
            if (args.length != 2 || !args[0].matches("0|[1-9][0-9]{0,8}")
                    || !args[1].matches("[1-9][0-9]{0,18}")) {
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
                readStat(provider, user, id);
            } finally {
                if (scopedRelease) release.invoke(manager, "media", token, user);
                else release.invoke(manager, "media", token);
            }
        } catch (Exception exception) {
            System.out.println("ERROR: Android MediaStore stat failed (" + exception.getClass().getSimpleName() + ").");
        }
        System.exit(0);
    }

    private static void readStat(Object provider, int user, long id) throws Exception {
        final Uri uri = Uri.parse("content://media/external/file/" + id + "?includePending=1");
        try (ParcelFileDescriptor descriptor = openFile(provider, uri)) {
            if (descriptor == null) throw new IllegalStateException("Missing MediaStore descriptor.");
            final StructStat stat = Os.fstat(descriptor.getFileDescriptor());
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
