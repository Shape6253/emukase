import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.Process;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** Version-independent wrapper over the MediaStore IContentProvider binder. */
final class MediaStoreProvider {
    /** Lowest SDK with the provider fallback (Android 11). Keep TS constant in sync. */
    static final int MIN_SDK = 30;
    private final Object backend;
    private final Object[] auth;
    private final Method query;
    private final Method insert;
    private final Method delete;
    private final Method open;

    private MediaStoreProvider(Object backend, Object[] auth, Method query, Method insert, Method delete, Method open) {
        this.backend = backend;
        this.auth = auth;
        this.query = query;
        this.insert = insert;
        this.delete = delete;
        this.open = open;
    }

    static MediaStoreProvider attach(Object backend) throws Exception {
        final Class<?> providerType = Class.forName("android.content.IContentProvider");
        final Class<?> cancellation = Class.forName("android.os.ICancellationSignal");
        if (Build.VERSION.SDK_INT >= 31) {
            final Class<?> attribution = Class.forName("android.content.AttributionSource");
            final Class<?> builderType = Class.forName("android.content.AttributionSource$Builder");
            final Object builder = builderType.getConstructor(int.class).newInstance(Process.myUid());
            builderType.getMethod("setPackageName", String.class).invoke(builder, "com.android.shell");
            final Object source = builderType.getMethod("build").invoke(builder);
            return new MediaStoreProvider(backend, new Object[] { source },
                    providerType.getMethod("query", attribution, Uri.class, String[].class, Bundle.class, cancellation),
                    providerType.getMethod("insert", attribution, Uri.class, ContentValues.class, Bundle.class),
                    providerType.getMethod("delete", attribution, Uri.class, Bundle.class),
                    providerType.getMethod("openFile", attribution, Uri.class, String.class, cancellation));
        }
        if (Build.VERSION.SDK_INT == 30) {
            final Object[] auth = new Object[] { "com.android.shell", null };
            return new MediaStoreProvider(backend, auth,
                    providerType.getMethod("query", String.class, String.class, Uri.class,
                            String[].class, Bundle.class, cancellation),
                    providerType.getMethod("insert", String.class, String.class, Uri.class,
                            ContentValues.class, Bundle.class),
                    providerType.getMethod("delete", String.class, String.class, Uri.class, Bundle.class),
                    providerType.getMethod("openFile", String.class, String.class, Uri.class,
                            String.class, cancellation, IBinder.class));
        }
        // Older releases only need read-only descriptors (MediaStoreStat); folder
        // creation is gated to Android 11+ before attach.
        return new MediaStoreProvider(backend, new Object[] { "com.android.shell" }, null, null, null,
                providerType.getMethod("openFile", String.class, Uri.class, String.class,
                        cancellation, IBinder.class));
    }

    private static Object invoke(Method method, Object backend, Object[] auth, Object[] args) throws Exception {
        final Object[] call = new Object[auth.length + args.length];
        System.arraycopy(auth, 0, call, 0, auth.length);
        System.arraycopy(args, 0, call, auth.length, args.length);
        try {
            return method.invoke(backend, call);
        } catch (InvocationTargetException exception) {
            final Throwable cause = exception.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw exception;
        }
    }

    Cursor query(Uri uri, String[] projection, Bundle args) throws Exception {
        if (query == null) throw new UnsupportedOperationException("MediaStore query is unavailable.");
        return (Cursor) invoke(query, backend, auth, new Object[] { uri, projection, args, null });
    }

    Uri insert(Uri uri, ContentValues values) throws Exception {
        if (insert == null) throw new UnsupportedOperationException("MediaStore insert is unavailable.");
        return (Uri) invoke(insert, backend, auth, new Object[] { uri, values, null });
    }

    Object delete(Uri uri) throws Exception {
        if (delete == null) throw new UnsupportedOperationException("MediaStore delete is unavailable.");
        return invoke(delete, backend, auth, new Object[] { uri, null });
    }

    ParcelFileDescriptor open(Uri uri) throws Exception {
        // Modern openFile has no observer; legacy takes a trailing null binder.
        if (Build.VERSION.SDK_INT >= 31) {
            return (ParcelFileDescriptor) invoke(open, backend, auth, new Object[] { uri, "r", null });
        }
        return (ParcelFileDescriptor) invoke(open, backend, auth, new Object[] { uri, "r", null, null });
    }
}
