import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Build;
import android.os.IBinder;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/** Addressed actions only: an uncertain result must never replay a confirmation. */
@SuppressWarnings("deprecation")
final class AndroidUiAction {
    private AndroidUiAction() {}

    static String run(UiAutomation automation, String path) {
        AccessibilityNodeInfo root = null;
        AccessibilityNodeInfo source = null;
        AccessibilityNodeInfo target = null;
        try {
            final File file = new File(path);
            if (file.length() <= 0 || file.length() > 65536L) throw new IllegalArgumentException();
            final JSONObject request;
            try (FileInputStream input = new FileInputStream(file)) {
                request = new JSONObject(new String(read(input, 65536), StandardCharsets.UTF_8));
            }
            final int user = request.getInt("user");
            final String owner = request.getString("packageName");
            if (user < 0 || !(owner.equals("com.android.documentsui")
                    || owner.equals("com.google.android.documentsui")
                    || owner.equals("com.android.packageinstaller")
                    || owner.equals("com.google.android.packageinstaller"))) throw new IllegalArgumentException();
            requireUser(user);
            if (!interactive() || keyguardLocked()) return "ui-action:locked";
            AndroidUiDump.clearCache(automation);
            root = automation.getRootInActiveWindow();
            if (root == null || !owner.contentEquals(text(root.getPackageName()))
                    || root.getWindowId() != request.getInt("windowId")
                    || !focused(automation, root.getWindowId())) return "ui-action:stale:window";
            final AccessibilityWindowInfo window = root.getWindow();
            if (window == null) return "ui-action:stale:missing-window";
            try {
                if (Build.VERSION.SDK_INT >= 30 && window.getDisplayId() != 0) return "ui-action:stale:display";
            } finally { window.recycle(); }
            if (rotation() != request.getInt("rotation")) return "ui-action:stale:rotation";
            final JSONArray guards = request.getJSONArray("guards");
            if (guards.length() > 64) throw new IllegalArgumentException();
            for (int index = 0; index < guards.length(); index++) {
                final JSONObject guard = guards.getJSONObject(index);
                final List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(guard.getString("id"));
                try {
                    final JSONArray expected = guard.getJSONArray("nodes");
                    if (found.size() != expected.length()) return "ui-action:stale:guard-count";
                    for (int item = 0; item < found.size(); item++) {
                        if (!matches(found.get(item), expected.getJSONObject(item), owner)) return "ui-action:stale:guard-identity";
                    }
                } finally { recycle(found); }
            }
            final JSONObject expected = request.getJSONObject("source");
            final List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(expected.getString("id"));
            try {
                for (AccessibilityNodeInfo node : found) {
                    if (!matches(node, expected, owner)) continue;
                    if (source != null) return "ui-action:stale:ambiguous-source";
                    source = AccessibilityNodeInfo.obtain(node);
                }
            } finally { recycle(found); }
            if (source == null) return "ui-action:stale:source";
            target = AccessibilityNodeInfo.obtain(source);
            final JSONArray ancestors = request.getJSONArray("ancestors");
            if (ancestors.length() > 32) throw new IllegalArgumentException();
            for (int index = 0; index < ancestors.length(); index++) {
                final AccessibilityNodeInfo parent = target.getParent();
                target.recycle();
                target = parent;
                if (target == null || !matches(target, ancestors.getJSONObject(index), owner)) return "ui-action:stale:ancestor";
            }
            final boolean focusedDocument = request.has("document") && request.optBoolean("allowFocusedOffscreen") && target.isFocused();
            if (!target.isEnabled() || !target.isClickable()
                    || (!focusedDocument && (!target.isVisibleToUser() || !source.isVisibleToUser()))) return "ui-action:stale:visibility";
            final Rect bounds = new Rect();
            target.getBoundsInScreen(bounds);
            if (bounds.isEmpty() && !focusedDocument) return "ui-action:stale:bounds";
            if (!target.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)) {
                return "ui-action:unsupported";
            }
            // Recheck focus and profile after directory/guard queries. No coordinates or global keys.
            requireUser(user);
            if (!focused(automation, target.getWindowId()) || !interactive() || keyguardLocked()) return "ui-action:stale:focus";
            if (request.has("document") && !documentMatches(request.getJSONObject("document"), user)) return "ui-action:stale:directory";
            if (!source.refresh() || !matches(source, expected, owner)
                    || !target.refresh() || !matches(target, ancestors.length() == 0 ? expected
                            : ancestors.getJSONObject(ancestors.length() - 1), owner)) return "ui-action:stale:source";
            if (focusedDocument && !target.isFocused()) return "ui-action:stale:focus";
            // Even false can mean app-specific handling. The host must observe, never blindly retry.
            return target.performAction(AccessibilityNodeInfo.ACTION_CLICK) ? "ui-action:clicked" : "ui-action:unconfirmed";
        } catch (Exception exception) {
            return "ERROR: Android UI action failed (" + exception.getClass().getSimpleName() + ").";
        } finally {
            if (target != null) target.recycle();
            if (source != null) source.recycle();
            if (root != null) root.recycle();
        }
    }

    private static boolean matches(AccessibilityNodeInfo node, JSONObject expected, String owner) throws Exception {
        return owner.equals(text(node.getPackageName()))
                && expected.getString("id").equals(text(node.getViewIdResourceName()))
                && expected.getString("text").equals(text(node.getText()))
                && expected.getString("description").equals(text(node.getContentDescription()))
                && expected.getString("className").equals(text(node.getClassName()))
                && expected.getBoolean("enabled") == node.isEnabled()
                && expected.getBoolean("clickable") == node.isClickable();
    }

    private static boolean focused(UiAutomation automation, int id) {
        final List<AccessibilityWindowInfo> windows = automation.getWindows();
        try {
            int focused = 0;
            boolean expected = false;
            for (AccessibilityWindowInfo window : windows) {
                if (!window.isFocused()) continue;
                focused++;
                expected = window.getId() == id && window.isActive()
                        && window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION;
            }
            return focused == 1 && expected;
        } finally {
            for (AccessibilityWindowInfo window : windows) window.recycle();
        }
    }

    private static boolean documentMatches(JSONObject document, int user) throws Exception {
        final String token = document.getString("token");
        final String directory = document.getString("directory");
        if (!token.matches("[a-f0-9]{1,16}") || !directory.startsWith("primary:")
                || directory.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new IllegalArgumentException();
        return directory.equals(AndroidDocumentIdentity.directory(token, user));
    }

    private static void requireUser(int user) throws Exception {
        if (!Integer.valueOf(user).equals(Class.forName("android.app.ActivityManager")
                .getMethod("getCurrentUser").invoke(null))) throw new IllegalStateException();
    }

    private static boolean interactive() throws Exception {
        final IBinder binder = (IBinder) Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class).invoke(null, "power");
        final Object power = Class.forName("android.os.IPowerManager$Stub")
                .getMethod("asInterface", IBinder.class).invoke(null, binder);
        return Boolean.TRUE.equals(Class.forName("android.os.IPowerManager").getMethod("isInteractive").invoke(power));
    }

    private static boolean keyguardLocked() throws Exception {
        final Object manager = Class.forName("android.view.WindowManagerGlobal")
                .getMethod("getWindowManagerService").invoke(null);
        return !Boolean.FALSE.equals(Class.forName("android.view.IWindowManager")
                .getMethod("isKeyguardLocked").invoke(manager));
    }

    private static int rotation() throws Exception {
        final Class<?> type = Class.forName("android.hardware.display.DisplayManagerGlobal");
        final Object manager = type.getMethod("getInstance").invoke(null);
        final android.view.Display display = (android.view.Display) type.getMethod("getRealDisplay", int.class).invoke(manager, 0);
        if (display == null) throw new IllegalStateException();
        return display.getRotation();
    }

    static byte[] read(java.io.InputStream input, int limit) throws Exception {
        final ByteArrayOutputStream output = new ByteArrayOutputStream();
        final byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IllegalArgumentException();
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String text(CharSequence value) { return value == null ? "" : value.toString(); }

    private static void recycle(List<AccessibilityNodeInfo> nodes) {
        for (AccessibilityNodeInfo node : nodes) node.recycle();
    }
}
