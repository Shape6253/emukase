import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONArray;
import org.json.JSONObject;

/** Compose has no stable view ID for wizard buttons. Match the entire reviewed
 * visible tree before returning its addressed button to the shared action guard. */
@SuppressWarnings("deprecation")
final class EsdeUiAction {
    private final JSONArray expected;
    private final int sourceIndex;
    private int index;
    private AccessibilityNodeInfo source;

    private EsdeUiAction(JSONObject request) throws Exception {
        expected = request.getJSONArray("hierarchy");
        sourceIndex = request.getInt("sourceIndex");
        if (expected.length() < 1 || expected.length() > 8192 || sourceIndex < 0 || sourceIndex >= expected.length()
                || request.has("document") || request.getJSONArray("ancestors").length() != 0) {
            throw new IllegalArgumentException("Invalid ES-DE wizard hierarchy.");
        }
    }

    static AccessibilityNodeInfo find(AccessibilityNodeInfo root, JSONObject request) throws Exception {
        final EsdeUiAction review = new EsdeUiAction(request);
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
        if (!AndroidUiAction.matches(node, identity, "org.es_de.frontend")
                || node.isFocusable() != identity.getBoolean("focusable")
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
