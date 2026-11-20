import android.net.Uri;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Verify the exact picker activity's primary-storage directory before addressed input. */
final class AndroidDocumentIdentity {
    private static final String ACTIVITY_RECORD = "ActivityRecord\\{([a-f0-9]+) u(\\d+) (\\S+) t\\d+\\}[ \\t]*\\r?$";
    private static final Pattern FOCUSED_RESUMED = Pattern.compile("(?m)^[ \\t]*ResumedActivity: " + ACTIVITY_RECORD);
    private static final Pattern TASK_RESUMED = Pattern.compile("(?m)^[ \\t]*topResumedActivity=" + ACTIVITY_RECORD);

    private AndroidDocumentIdentity() {}

    static boolean resumed(String token, int user, String owner) throws Exception {
        return resumedFromDump(activityDump("activities"), token, user, owner);
    }

    static boolean resumedFromDump(String output, String token, int user, String owner) {
        // AOSP reports the focused activity separately from each task's resumed activity.
        Matcher resumed = FOCUSED_RESUMED.matcher(output);
        if (!resumed.find()) {
            resumed = TASK_RESUMED.matcher(output);
            if (!resumed.find()) return false;
        }
        final String component = resumed.group(3).replace("/.", "/" + owner + ".");
        return token.equals(resumed.group(1)) && String.valueOf(user).equals(resumed.group(2))
                && (owner + "/com.android.documentsui.picker.PickActivity").equals(component) && !resumed.find();
    }

    static String directory(String token, int user) throws Exception {
        if (!token.matches("[a-f0-9]{1,16}")) throw new IllegalArgumentException();
        final String output = activityDump(token);
        String arguments = null;
        for (String line : output.split("\\r?\\n")) {
            if (!line.contains("mArguments=Bundle[{root=Root{")) continue;
            if (arguments != null) return null;
            arguments = line;
        }
        if (arguments == null || !arguments.contains("root=Root{userId=" + user
                + ", authority=com.android.externalstorage.documents, rootId=primary,")
                || !arguments.contains("mimeType=vnd.android.document/directory,")) return null;
        final Matcher document = Pattern.compile("document=DocumentInfo\\{docId=(primary:.*), userId=(\\d+), name=").matcher(arguments);
        final Matcher uri = Pattern.compile("@ content://com\\.android\\.externalstorage\\.documents/document/([^\\s},\\]]+)").matcher(arguments);
        if (!document.find() || !uri.find() || !String.valueOf(user).equals(document.group(2))
                || !document.group(1).equals(Uri.decode(uri.group(1))) || !validDirectory(document.group(1))) return null;
        return document.group(1);
    }

    private static String activityDump(String filter) throws Exception {
        // Run as this shell helper, not through UiAutomation's OEM-dependent stdout pipe.
        final Process process = new ProcessBuilder("/system/bin/dumpsys", "-t", "2", "activity", filter)
                .redirectErrorStream(true).start();
        try (InputStream input = process.getInputStream()) {
            return new String(AndroidUiAction.read(input, 2097152), StandardCharsets.UTF_8);
        } finally { process.destroy(); }
    }

    private static boolean validDirectory(String value) {
        if (!value.startsWith("primary:") || value.matches("(?s).*[\\x00-\\x1f\\x7f].*")) return false;
        if (value.equals("primary:")) return true;
        for (String part : value.substring(8).split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return true;
    }
}
