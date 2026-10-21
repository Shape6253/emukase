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
the XML dump, in one ADB shell call. Legacy input verifies the complete current
snapshot. DocumentsUI and PackageInstaller can instead address a reviewed control
through `AndroidUiAction`: the helper rechecks the profile, lock, focused primary
window ID, rotation, control identity and semantic guards before `ACTION_CLICK`.
DocumentsUI also verifies the exact activity token's primary-storage docId through
`AndroidDocumentIdentity`; folder names alone never identify the current directory.
A focused document row found by the existing safe title-prefix search can be
activated without coordinates or ENTER, even when its title is clipped. Search
and fallback navigation stay in TypeScript; the DEX never opens a new picker or
fabricates an emulator callback. Action requests use private, bounded JSON files
removed by the request shell's exit trap. Dispatched actions are never replayed
after an uncertain response. The host closes the helper and removes its FIFOs, DEX and XML
on success, failure or cancellation; a five-minute inactivity limit also
releases accessibility if the host disconnects before cleanup.
Before capturing after four minutes without a request, the host replaces the
session so long uploads cannot leave it using an expired helper. Transport
leases stay attached to the replacement until the final scope releases it.

The same DEX also includes `MediaStoreStat`, a separate one-shot entry point.
It opens a shared file through MediaStore in read-only mode and uses `fstat`
for its actual size and modification time, including pending SAF records whose
cached MediaStore metadata is null. It validates the selected user before and
after reading, closes the descriptor, and does not connect to accessibility.
With a third argument containing a document name, it reads the parent directory
through that descriptor and returns a short search prefix. The complete sibling
listing bounds the title highlighter even when shell cannot traverse a secondary
profile's storage path. Only the prefix is returned; sibling names stay on Android.

Rebuild with JDK 17, Android 34's platform JAR and D8:

```sh
UI_DUMP_BUILD_DIR=$(mktemp -d)
javac --release 8 -Xlint:all -classpath "$UI_DUMP_ANDROID_JAR" \
  -d "$UI_DUMP_BUILD_DIR" src/lib/adb/ui-dump/*.java
java -cp "$UI_DUMP_D8_JAR" com.android.tools.r8.D8 --release --min-api 26 \
  --lib "$UI_DUMP_ANDROID_JAR" --output "$UI_DUMP_BUILD_DIR" \
  "$UI_DUMP_BUILD_DIR"/*.class
cp "$UI_DUMP_BUILD_DIR/classes.dex" src/lib/adb/ui-dump/compiled.dex
shasum -a 256 src/lib/adb/ui-dump/compiled.dex
```

Update `HELPER_SHA256` in `android-ui-dump.ts` with the rebuilt artifact's digest.
