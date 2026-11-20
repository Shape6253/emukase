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
            final String action = request.optString("action", "click");
            final boolean focusAction = action.equals("focus");
            final boolean scrollAction = action.equals("scroll-forward") || action.equals("scroll-backward");
            final boolean emulator = emulatorOwner(owner);
            final boolean treeAction = emulator || owner.equals("org.es_de.frontend");
            final boolean picker = owner.equals("com.android.documentsui") || owner.equals("com.google.android.documentsui");
            if (!(action.equals("click") || focusAction && picker || scrollAction && emulator)
                    || picker && !request.has("document")) {
                throw new IllegalArgumentException();
            }
            if (user < 0 || !(picker
                    || owner.equals("com.android.packageinstaller")
                    || owner.equals("com.google.android.packageinstaller")
                    || treeAction)) throw new IllegalArgumentException();
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
                    int item = 0;
                    for (AccessibilityNodeInfo node : found) {
                        // The XML snapshot excludes invisible children. A view-ID
                        // query can still return an outgoing picker breadcrumb.
                        if (picker && !node.isVisibleToUser()) continue;
                        if (item >= expected.length()) return "ui-action:stale:guard-count";
                        if (!matches(node, expected.getJSONObject(item++), owner)) return "ui-action:stale:guard-identity";
                    }
                    if (item != expected.length()) return "ui-action:stale:guard-count";
                } finally { recycle(found); }
            }
            final JSONObject expected = request.getJSONObject("source");
            if (treeAction) source = AndroidUiHierarchy.find(root, request, owner);
            else {
                final List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(expected.getString("id"));
                try {
                    for (AccessibilityNodeInfo node : found) {
                        if (!matches(node, expected, owner)) continue;
                        if (source != null) return "ui-action:stale:ambiguous-source";
                        source = AccessibilityNodeInfo.obtain(node);
                    }
                } finally { recycle(found); }
            }
            if (source == null) return "ui-action:stale:source";
            target = AccessibilityNodeInfo.obtain(source);
            final JSONArray ancestors = request.getJSONArray("ancestors");
            if (ancestors.length() > 32) throw new IllegalArgumentException();
            for (int index = 0; index < ancestors.length(); index++) {
                final AccessibilityNodeInfo parent = target.getParent();
                target.recycle();
                target = parent;
                if (target == null || !matches(target, ancestors.getJSONObject(index), owner, treeAction)) return "ui-action:stale:ancestor";
            }
            final boolean focusedDocument = !focusAction && request.has("document") && request.optBoolean("allowFocusedOffscreen") && target.isFocused();
            if (!target.isEnabled() || !(focusAction ? target.isFocusable() : scrollAction ? target.isScrollable() : target.isClickable())
                    || (!focusedDocument && (!target.isVisibleToUser() || !source.isVisibleToUser()))) return "ui-action:stale:visibility";
            final Rect bounds = new Rect();
            target.getBoundsInScreen(bounds);
            if (bounds.isEmpty() && !focusedDocument) return "ui-action:stale:bounds";
            final AccessibilityNodeInfo.AccessibilityAction accessibilityAction = focusAction
                    ? AccessibilityNodeInfo.AccessibilityAction.ACTION_FOCUS : action.equals("scroll-forward")
                    ? AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD : action.equals("scroll-backward")
                    ? AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD : AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK;
            if (!target.getActionList().contains(accessibilityAction)) {
                return "ui-action:unsupported";
            }
            final JSONObject document = picker ? request.getJSONObject("document") : null;
            final String token = document == null ? null : document.getString("token");
            final String directory = document == null ? null : document.getString("directory");
            if (document != null) {
                if (!resumedDocument(token, directory, user, owner)) return "ui-action:stale:directory";
                if (!focusedAndUnlocked(automation, target.getWindowId(), user)) return "ui-action:stale:focus";
                if (!directory.equals(AndroidDocumentIdentity.directory(token, user))) return "ui-action:stale:directory";
            }
            // DocumentsUI can reuse a row in the same directory while the dump runs.
            if (!source.refresh() || !matches(source, expected, owner, treeAction)
                    || !target.refresh() || !matches(target, ancestors.length() == 0 ? expected
                            : ancestors.getJSONObject(ancestors.length() - 1), owner, treeAction)) return "ui-action:stale:source";
            if (focusedDocument && !target.isFocused()) return "ui-action:stale:focus";
            if (focusAction && !target.isFocusable()) return "ui-action:stale:focus";
            if (!focusedDocument && (!target.isVisibleToUser() || !source.isVisibleToUser())) return "ui-action:stale:visibility";
            if (scrollAction && !target.isScrollable()) return "ui-action:stale:source";
            if (document == null && !focusedAndUnlocked(automation, target.getWindowId(), user)) return "ui-action:stale:focus";
            // Even false can mean app-specific handling. The host must observe, never blindly retry.
            return target.performAction(accessibilityAction.getId())
                    ? (focusAction ? "ui-action:focused" : scrollAction ? "ui-action:scrolled" : "ui-action:clicked") : "ui-action:unconfirmed";
        } catch (Exception exception) {
            return "ERROR: Android UI action failed (" + exception.getClass().getSimpleName() + ").";
        } finally {
            if (target != null) target.recycle();
            if (source != null) source.recycle();
            if (root != null) root.recycle();
        }
    }

    static boolean matches(AccessibilityNodeInfo node, JSONObject expected, String owner) throws Exception {
        return matches(node, expected, owner, false);
    }

    static boolean matches(AccessibilityNodeInfo node, JSONObject expected, String owner, boolean xmlLabels) throws Exception {
        return owner.equals(text(node.getPackageName()))
                && expected.getString("id").equals(text(node.getViewIdResourceName()))
                && expected.getString("text").equals(label(node.getText(), xmlLabels))
                && expected.getString("description").equals(label(node.getContentDescription(), xmlLabels))
                && expected.getString("className").equals(text(node.getClassName()))
                && expected.getBoolean("enabled") == node.isEnabled()
                && expected.getBoolean("clickable") == node.isClickable()
                && expected.getBoolean("checked") == node.isChecked()
                && expected.getBoolean("selected") == node.isSelected();
    }

    /** Match the UTF-16 characters replaced by AccessibilityNodeInfoDumper in XML labels. */
    private static String label(CharSequence value, boolean xmlLabels) {
        final String raw = text(value);
        if (!xmlLabels) return raw;
        StringBuilder normalized = null;
        for (int index = 0; index < raw.length(); index++) {
            final char c = raw.charAt(index);
            if ((c >= 0x01 && c <= 0x08) || c == 0x0b || c == 0x0c
                    || (c >= 0x0e && c <= 0x1f) || (c >= 0x7f && c <= 0x84)
                    || (c >= 0x86 && c <= 0x9f) || (c >= 0xfdd0 && c <= 0xfddf)) {
                if (normalized == null) normalized = new StringBuilder(raw);
                normalized.setCharAt(index, '.');
            }
        }
        return normalized == null ? raw : normalized.toString();
    }

    /** Match the integrations using reviewed app-tree actions on the host. */
    private static boolean emulatorOwner(String owner) {
        return owner.equals("org.azahar_emu.azahar") || owner.equals("me.magnum.melonds");
    }

    private static boolean focusedAndUnlocked(UiAutomation automation, int id, int user) throws Exception {
        requireUser(user);
        return focused(automation, id) && interactive() && !keyguardLocked();
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

    private static boolean resumedDocument(String token, String directory, int user, String owner) throws Exception {
        if (!token.matches("[a-f0-9]{1,16}") || !directory.startsWith("primary:")
                || directory.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new IllegalArgumentException();
        return AndroidDocumentIdentity.resumed(token, user, owner);
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
