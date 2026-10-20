This Android 8+ shell helper reads the current accessibility hierarchy without
`uiautomator dump`'s one-second idle wait. It uses Android's existing XML dumper;
foreground, profile, XML and action checks remain in `android-ui.ts`.
`android-ui-dump.ts` keeps one helper connection for the operation and uses
private request/response FIFOs to read each fresh tree without reconnecting
accessibility on every screen. The helper clears the accessibility cache before
each read. IPC has a maximum response time; it never waits for an idle UI.
Interactive windows are included so non-focusable app dropdowns are read above
their editor. Only application windows owned by the active app can replace its root.
Transport scopes on the same USB connection share this helper during native
import handoffs, and the final scope releases it.

Each capture reads screen/lock state, plus the profile and foreground around
the XML dump, in one ADB shell call. Actions still verify the current snapshot
before input. The host closes the helper and removes its FIFOs, DEX and XML
on success, failure or cancellation; a five-minute inactivity limit also
releases accessibility if the host disconnects before cleanup.
Before capturing after four minutes without a request, the host replaces the
session so long uploads cannot leave it using an expired helper. Transport
leases stay attached to the replacement until the final scope releases it.

Rebuild with JDK 17, Android 34's platform JAR and D8:

```sh
UI_DUMP_BUILD_DIR=$(mktemp -d)
javac --release 8 -Xlint:all -classpath "$UI_DUMP_ANDROID_JAR" \
  -d "$UI_DUMP_BUILD_DIR" src/lib/adb/ui-dump/AndroidUiDump.java
java -cp "$UI_DUMP_D8_JAR" com.android.tools.r8.D8 --release --min-api 26 \
  --lib "$UI_DUMP_ANDROID_JAR" --output "$UI_DUMP_BUILD_DIR" \
  "$UI_DUMP_BUILD_DIR"/*.class
cp "$UI_DUMP_BUILD_DIR/classes.dex" src/lib/adb/ui-dump/compiled.dex
shasum -a 256 src/lib/adb/ui-dump/compiled.dex
```

Update `HELPER_SHA256` in `android-ui-dump.ts` with the rebuilt artifact's digest.
