import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.File;

public final class AndroidUiDump {
    private AndroidUiDump() {}

    @SuppressWarnings("deprecation")
    public static void main(String[] args) {
        HandlerThread thread = null;
        UiAutomation automation = null;
        AccessibilityNodeInfo root = null;
        boolean connected = false;
        try {
            if (args.length != 1 || !args[0].matches("/data/local/tmp/emukase-ui-[a-f0-9-]{1,64}\\.xml")) {
                throw new IllegalArgumentException("Invalid UI dump path.");
            }
            final File output = new File(args[0]);
            if (output.exists()) throw new IllegalArgumentException("UI dump path already exists.");
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
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            automation.setServiceInfo(info);
            // Read the live tree immediately. The caller verifies a second snapshot before input.
            root = automation.getRootInActiveWindow();
            if (root == null || !root.refresh()) {
                throw new WindowUnavailable();
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
            System.out.println("UI hierarchy dumped to: " + args[0]);
        } catch (WindowUnavailable exception) {
            System.out.println("ERROR: null root node returned by UiTestAutomationBridge.");
        } catch (Exception exception) {
            System.out.println("ERROR: Android UI snapshot failed ("
                    + exception.getClass().getSimpleName() + ").");
        } finally {
            if (root != null) root.recycle();
            if (connected) {
                try {
                    UiAutomation.class.getMethod("disconnect").invoke(automation);
                } catch (Exception exception) { /* The process is exiting. */ }
            }
            if (thread != null) thread.quitSafely();
        }
        System.exit(0);
    }

    private static final class WindowUnavailable extends Exception {
        private static final long serialVersionUID = 1L;
    }
}
