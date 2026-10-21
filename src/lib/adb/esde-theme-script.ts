import { shellCommand } from "./transport";
import { ELEMENTERIAL_THEME } from "./esde-theme-source";
import type { EsdeContext } from "./esde-types";

/** ES-DE invokes Android event scripts through sh in its own app context. */
export function esdeThemeStartupScript(context: EsdeContext, token: string, script: string, journal: string, archive?: string): string {
  const parent = `${context.workspace.esde}/themes`;
  const staging = `${parent}/emukase-elementerial-${token}_DISABLED`;
  const destination = `${parent}/${ELEMENTERIAL_THEME.directory}`;
  const unpacked = `${staging}/unpacked/${ELEMENTERIAL_THEME.directory}-${ELEMENTERIAL_THEME.revision}`;
  const receipt = JSON.stringify({ schema: 1, revision: ELEMENTERIAL_THEME.revision, sha256: ELEMENTERIAL_THEME.sha256, files: ELEMENTERIAL_THEME.files });
  return [
    "#!/system/bin/sh", "set -eu", "umask 077", "emukase_theme_step=starting",
    "status() {",
    `  ${shellCommand("printf", `{"schema":1,"token":"${token}","phase":"%s","step":"%s"}\n`)} "$1" "$emukase_theme_step" > ${shellCommand(`${journal}.tmp`)}`,
    `  ${shellCommand("mv", "-f", `${journal}.tmp`, journal)}`,
    "}",
    "cleanup() {",
    "  emukase_theme_code=$?", "  trap - EXIT HUP INT TERM",
    "  if test \"$emukase_theme_code\" -ne 0; then status failed; fi",
    `  ${shellCommand("rm", "-f", script)}`,
    `  ${shellCommand("rm", "-rf", staging)}`,
    ...(archive ? [`  ${shellCommand("rm", "-f", archive)}`] : []),
    "  exit \"$emukase_theme_code\"", "}", "trap cleanup EXIT", "trap 'exit 130' HUP INT TERM",
    // The UID pins the hook to this profile during the network transfer too.
    `test "$(( $(id -u) / 100000 ))" -eq ${context.user}`,
    shellCommand("test", "!", "-e", destination), shellCommand("test", "!", "-L", destination),
    shellCommand("mkdir", "-p", parent), shellCommand("mkdir", staging),
    "emukase_theme_step=downloading", "status downloading",
    ...(!archive ? [shellCommand("curl", "--fail", "--silent", "--show-error", "--proto", "=https",
      "--connect-timeout", "15", "--max-time", "180", "--max-filesize", String(ELEMENTERIAL_THEME.bytes),
      "--output", `${staging}/theme.zip`, ELEMENTERIAL_THEME.url)] : []),
    `emukase_theme_archive=${shellCommand(archive ?? `${staging}/theme.zip`)}`,
    "emukase_theme_step=checking", "status checking",
    `test "$(wc -c < "$emukase_theme_archive")" -eq ${ELEMENTERIAL_THEME.bytes}`,
    `test "$(sha256sum "$emukase_theme_archive" | cut -d ' ' -f 1)" = ${shellCommand(ELEMENTERIAL_THEME.sha256)}`,
    "emukase_theme_step=extracting", "status extracting",
    `${shellCommand("unzip", "-q")} "$emukase_theme_archive" ${shellCommand("-d", `${staging}/unpacked`)}`,
    `test -z "$( ${shellCommand("find", unpacked, "-type", "l", "-print")} )"`,
    `test "$( ${shellCommand("find", unpacked, "-type", "f", "-print")} | wc -l )" -eq ${ELEMENTERIAL_THEME.files}`,
    shellCommand("grep", "-Fq", `<variant name="${ELEMENTERIAL_THEME.variant}">`, `${unpacked}/capabilities.xml`),
    shellCommand("test", "-s", `${unpacked}/theme.xml`),
    `${shellCommand("printf", "%s", receipt)} > ${shellCommand(`${unpacked}/emukase-theme.json`)}`,
    // Flush the complete tree once, then rename within the same filesystem.
    "emukase_theme_step=publishing", "status publishing", "sync",
    shellCommand("test", "!", "-e", destination), shellCommand("mv", "-nT", unpacked, destination),
    shellCommand("test", "!", "-e", unpacked), shellCommand("test", "-s", `${destination}/emukase-theme.json`),
    "status complete", "",
  ].join("\n");
}
