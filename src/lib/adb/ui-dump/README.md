This Android 8+ shell helper reads the current accessibility hierarchy without
`uiautomator dump`'s one-second idle wait. It uses Android's existing XML dumper;
foreground, profile, XML and action checks remain in `android-ui.ts`.
`android-ui-dump.ts` captures the profile and foreground around the XML dump
in one ADB shell call, removing separate USB round trips while preserving
the observations' order and cleaning up the temporary XML on exit.

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
