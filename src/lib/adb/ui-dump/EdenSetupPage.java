import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/** ViewPager2 exposes each page's adapter position as its accessibility column. */
@SuppressWarnings("deprecation")
final class EdenSetupPage {
    private static final String PACKAGE = "dev.eden.eden_emulator";
    private static final String PAGER = PACKAGE + ":id/viewPager2";
    private static final String CONFIRMATION = PACKAGE + ":id/text_confirmation";

    private EdenSetupPage() {}

    static String read(AccessibilityNodeInfo root) {
        if (!PACKAGE.equals(String.valueOf(root.getPackageName()))) return null;
        final List<AccessibilityNodeInfo> pagers = root.findAccessibilityNodeInfosByViewId(PAGER);
        try {
            if (pagers.size() != 1 || !pagers.get(0).isVisibleToUser()) return null;
            final AccessibilityNodeInfo pager = pagers.get(0);
            // The recycler can be retained or omitted from the accessibility tree.
            if (pager.getChildCount() == 1) {
                final AccessibilityNodeInfo child = pager.getChild(0);
                if (child != null) {
                    try {
                        if (child.getCollectionItemInfo() == null) return settledPage(child);
                    } finally { child.recycle(); }
                }
            }
            return settledPage(pager);
        } finally {
            for (AccessibilityNodeInfo pager : pagers) pager.recycle();
        }
    }

    private static String settledPage(AccessibilityNodeInfo viewport) {
        final Rect visible = new Rect();
        final Rect bounds = new Rect();
        viewport.getBoundsInScreen(visible);
        if (visible.isEmpty()) return null;
        String page = null;
        for (int i = 0; i < viewport.getChildCount(); i++) {
            final AccessibilityNodeInfo item = viewport.getChild(i);
            if (item == null) continue;
            try {
                if (!item.isVisibleToUser()) continue;
                final AccessibilityNodeInfo.CollectionItemInfo info = item.getCollectionItemInfo();
                if (info == null || info.getRowIndex() != 0) continue;
                item.getBoundsInScreen(bounds);
                final int index = info.getColumnIndex();
                if (index < 0 || index > 2 || bounds.left != visible.left || bounds.right != visible.right) continue;
                if (page != null) return null;
                page = index == 1 && hasConfirmation(item) ? "1 complete" : String.valueOf(index);
            } finally { item.recycle(); }
        }
        return page;
    }

    private static boolean hasConfirmation(AccessibilityNodeInfo item) {
        final List<AccessibilityNodeInfo> found = item.findAccessibilityNodeInfosByViewId(CONFIRMATION);
        try {
            return found.size() == 1 && found.get(0).isVisibleToUser();
        } finally {
            for (AccessibilityNodeInfo confirmation : found) confirmation.recycle();
        }
    }
}
