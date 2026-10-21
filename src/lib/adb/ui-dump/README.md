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
DocumentsUI can also focus a reviewed visible row with `ACTION_FOCUS`, retaining
the same exact directory guard before title search. A confirmed navigation or
focus result supplies the next snapshot instead of immediately dumping it again.
ES-DE's Compose onboarding buttons use the same action guard, with every visible
node and its parent matched against the reviewed hierarchy by `EsdeUiAction`.
This addresses buttons without view IDs or a sequence of TAB/ENTER events.
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
Its `--entries` mode checks up to 64 indexed files or directories in one provider
session. Descriptor paths and the active profile must match the requested
identities before `fstat` results are accepted. No file contents are read and
no `/dev/full` access is needed, including on firmware that blocks that node.
With a third argument containing a document name, it reads the parent directory
through that descriptor and returns a short search prefix. The complete sibling
listing bounds the title highlighter even when shell cannot traverse a secondary
profile's storage path. Only the prefix is returned; sibling names stay on Android.
An optional fourth argument requests a minimum prefix length. A fifth `parent`
argument lists the volume root through its indexed child directory, after
checking the descriptor's resolved path against the pinned profile and child
name. The standard library root prefers `Emu`; renamed root folders use at most
two characters. Shorter sibling names still reduce the safe query length.

`PpssppConfig` replaces a stopped PPSSPP's INI through a single MediaStore
provider session on Android 12 and later. Its bounded private JSON request
contains the pinned profile, exact path, original bytes and replacement bytes.
The helper creates a pending file, checks the original bytes and stopped app
again, backs up the old record, publishes and reads back the replacement, then
removes the backup. A failure before verified publication removes the new file
and restores the original name. An uncertain response is never replayed; only
an explicit pre-mutation unsupported result permits the legacy content CLI path.
It does not connect to accessibility or launch PPSSPP.

`MediaStoreUpload` batches support-upload metadata for Eden and Vita3K on
Android 12 and later. `begin` records the original file identity and creates a
pending row; the existing transport streams the file directly to that URI.
`finish` checks the actual descriptor size and the original file's inode and
nanosecond modification time, retains a backup during publication, verifies
the saved path, size and MIME type, then deletes the backup. `abort` removes
the partial row and restores the original name, or preserves an already
verified publication. A private metadata journal makes cleanup repeatable after
an uncertain response. Only an explicit unsupported result before row creation
permits the legacy CLI path; uploads with a host publication callback retain
that path too. The request and journal never contain the uploaded payload.

`EsdeConfig` saves up to four ES-DE configuration files or native-app descriptors
per request on Android 12 and later through one MediaStore provider session. Original byte comparisons,
stopped-app checks, pending publication and readback remain on the device.
Each existing file gets a permanent verified `.bak` copy, and each replacement
has a durable JSON recovery record under the workspace's `setup/esde` directory.
Writes sync their own descriptors rather than the entire filesystem. The previous
provider record survives until the replacement is verified, and a failed
publication restores its name. An uncertain response is never replayed.
The same entry point saves onboarding recovery records without stopping ES-DE
and reads shared-text batches after scanning them through the provider. Recovery
updates compare the prior record's identity and bytes before publication. The
host uploads the DEX once per configuration run, shares it across journals,
menu reads and imports, and removes its private files on exit. Small metadata
requests use one guarded shell call. Legacy Android versions and host recovery
callbacks retain the existing per-file import path; recovery callbacks still
run after device persistence and before the corresponding UI action. File reads
remain fresh across app restarts.

Rebuild with JDK 17 or later, Android 34's platform JAR and D8:

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
