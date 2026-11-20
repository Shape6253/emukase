import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONArray;
import org.json.JSONObject;

/** Match the reviewed visible tree before returning a node by its position.
 * This also works for virtual IDs and native preference rows without IDs. */
@SuppressWarnings("deprecation")
final class AndroidUiHierarchy {
    private final JSONArray expected;
    private final int sourceIndex;
    private final String owner;
    private int index;
    private AccessibilityNodeInfo source;

    private AndroidUiHierarchy(JSONObject request, String owner) throws Exception {
        expected = request.getJSONArray("hierarchy");
        sourceIndex = request.getInt("sourceIndex");
        this.owner = owner;
        if (expected.length() < 1 || expected.length() > 8192 || sourceIndex < 0 || sourceIndex >= expected.length()
                || request.has("document")) {
            throw new IllegalArgumentException("Invalid reviewed UI hierarchy.");
        }
    }

    static AccessibilityNodeInfo find(AccessibilityNodeInfo root, JSONObject request, String owner) throws Exception {
        final AndroidUiHierarchy review = new AndroidUiHierarchy(request, owner);
        boolean accepted = false;
        try {
            accepted = review.visit(root, -1, 0) && review.index == review.expected.length();
            return accepted ? review.source : null;
        } finally {
            if (!accepted && review.source != null) review.source.recycle();
        }
    }

    private boolean visit(AccessibilityNodeInfo node, int parent, int depth) throws Exception {
        if (depth > 64 || index >= expected.length()) return false;
        final int current = index++;
        final JSONObject identity = expected.getJSONObject(current);
        if (!AndroidUiAction.matches(node, identity, owner)
                || node.isFocusable() != identity.getBoolean("focusable")
                || node.isScrollable() != identity.getBoolean("scrollable")
                || (parent < 0 ? !identity.isNull("parent") : identity.getInt("parent") != parent)) return false;
        if (current == sourceIndex) source = AccessibilityNodeInfo.obtain(node);
        for (int childIndex = 0; childIndex < node.getChildCount(); childIndex++) {
            final AccessibilityNodeInfo child = node.getChild(childIndex);
            if (child == null) return false;
            try {
                if (child.isVisibleToUser() && !visit(child, current, depth + 1)) return false;
            } finally { child.recycle(); }
        }
        return true;
    }
}
