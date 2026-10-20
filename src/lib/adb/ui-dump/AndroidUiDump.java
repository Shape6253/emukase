import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class AndroidUiDump {
    private AndroidUiDump() {}

    public static void main(String[] args) {
        HandlerThread thread = null;
        UiAutomation automation = null;
        boolean connected = false;
        try {
            final boolean session = args.length == 2 && args[0].equals("--serve")
                    && args[1].matches("/data/local/tmp/emukase-ui-session-[a-f0-9-]{36}");
            if (!session && (args.length != 1 || !validRequest(args[0]))) {
                throw new IllegalArgumentException("Invalid UI dump arguments.");
            }
            thread = new HandlerThread("EmukaseUiDump");
            thread.start();
            final Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
            final Object connection = Class.forName("android.app.UiAutomationConnection")
                    .getConstructor().newInstance();
            automation = UiAutomation.class.getConstructor(Looper.class, connectionType)
                    .newInstance(thread.getLooper(), connection);
            UiAutomation.class.getMethod("connect", int.class).invoke(automation,
                    UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            connected = true;
            final AccessibilityServiceInfo info = automation.getServiceInfo();
            if (info == null) throw new IllegalStateException("Accessibility is unavailable.");
            info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                    | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);
            if (session) serve(automation, args[1], thread);
            else System.out.println(request(automation, args[0]));
        } catch (Exception exception) {
            System.out.println(failure(exception));
        } finally {
            if (connected) {
                try {
                    UiAutomation.class.getMethod("disconnect").invoke(automation);
                } catch (Exception exception) { /* The process is exiting. */ }
            }
            if (thread != null) thread.quitSafely();
        }
        System.exit(0);
    }

    private static void serve(UiAutomation automation, String directory, HandlerThread thread)
            throws Exception {
        final Handler handler = new Handler(thread.getLooper());
        // Release accessibility after an interrupted USB session, even without host cleanup.
        final Runnable expire = () -> System.exit(0);
        while (true) {
            handler.removeCallbacks(expire);
            handler.postDelayed(expire, 300000L);
            final String request;
            try (FileInputStream input = new FileInputStream(new File(directory, "request"))) {
                final StringBuilder line = new StringBuilder();
                int value;
                while ((value = input.read()) != -1 && value != '\n') {
                    if (line.length() >= 256) throw new IllegalArgumentException("UI request is too large.");
                    line.append((char) value);
                }
                request = line.toString();
            }
            final boolean stop = request.equals("stop");
            final String response = stop ? "stopped" : request.equals("ready") ? "ready"
                    : request(automation, request);
            try (FileOutputStream output = new FileOutputStream(new File(directory, "response"))) {
                output.write((response + "\n").getBytes(StandardCharsets.UTF_8));
            }
            if (stop) return;
        }
    }

    private static boolean validRequest(String value) {
        return value.matches("/data/local/tmp/emukase-ui-[a-f0-9-]{1,64}\\.xml")
                || value.matches("/data/local/tmp/emukase-ui-action-[a-f0-9-]{36}\\.json");
    }

    private static String request(UiAutomation automation, String value) {
        if (value.matches("/data/local/tmp/emukase-ui-action-[a-f0-9-]{36}\\.json")) {
            return AndroidUiAction.run(automation, value);
        }
        return dump(automation, value);
    }

    static void clearCache(UiAutomation automation) throws Exception {
        final Class<?> clientType = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
        final Object client = clientType.getMethod("getInstance").invoke(null);
        try {
            clientType.getMethod("clearCache").invoke(client);
        } catch (NoSuchMethodException exception) {
            final Object id = UiAutomation.class.getMethod("getConnectionId").invoke(automation);
            clientType.getMethod("clearCache", int.class).invoke(client, id);
        }
    }

    @SuppressWarnings("deprecation")
    private static String dump(UiAutomation automation, String path) {
        AccessibilityNodeInfo root = null;
        try {
            if (!path.matches("/data/local/tmp/emukase-ui-[a-f0-9-]{1,64}\\.xml")) {
                throw new IllegalArgumentException("Invalid UI dump path.");
            }
            final File output = new File(path);
            if (output.exists()) throw new IllegalArgumentException("UI dump path already exists.");
            // Reusing the connection must never reuse a previous screen's cached nodes.
            clearCache(automation);
            root = automation.getRootInActiveWindow();
            if (root == null) {
                throw new WindowUnavailable();
            }
            // Non-focusable dropdowns can cover the active editor without
            // becoming its active window. Read the uppermost interactive
            // application window owned by the same app instead of its backdrop.
            final CharSequence owner = root.getPackageName();
            final List<AccessibilityWindowInfo> windows = automation.getWindows();
            try {
                for (AccessibilityWindowInfo window : windows) {
                    if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                    if (window.getId() == root.getWindowId()) break;
                    final AccessibilityNodeInfo candidate = window.getRoot();
                    if (candidate == null) throw new WindowUnavailable();
                    if (owner != null && owner.equals(candidate.getPackageName())) {
                        root.recycle();
                        root = candidate;
                        break;
                    }
                    candidate.recycle();
                }
            } finally {
                for (AccessibilityWindowInfo window : windows) window.recycle();
            }
            final Class<?> managerType = Class.forName("android.hardware.display.DisplayManagerGlobal");
            final Object manager = managerType.getMethod("getInstance").invoke(null);
            final Display display = (Display) managerType.getMethod("getRealDisplay", int.class)
                    .invoke(manager, Display.DEFAULT_DISPLAY);
            if (display == null) throw new IllegalStateException("Primary display is unavailable.");
            final Point size = new Point();
            display.getRealSize(size);
            Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper")
                    .getMethod("dumpWindowToFile", AccessibilityNodeInfo.class, File.class,
                            int.class, int.class, int.class)
                    .invoke(null, root, output, display.getRotation(), size.x, size.y);
            if (!output.isFile() || output.length() == 0 || output.length() > 2097152L) {
                throw new IllegalStateException("UI dump is missing or too large.");
            }
            return "UI hierarchy dumped to: " + path + "\nUI window: " + root.getWindowId();
        } catch (WindowUnavailable exception) {
            return "ERROR: null root node returned by UiTestAutomationBridge.";
        } catch (Exception exception) {
            return failure(exception);
        } finally {
            if (root != null) root.recycle();
        }
    }

    private static String failure(Exception exception) {
        return "ERROR: Android UI snapshot failed (" + exception.getClass().getSimpleName() + ").";
    }

    private static final class WindowUnavailable extends Exception {
        private static final long serialVersionUID = 1L;
    }
}
