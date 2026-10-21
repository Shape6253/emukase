import { loadAndroidUiDump } from "./android-ui-dump";
import { androidUserProcessPid, assertAndroidUser } from "./android-user";
import type { EmulatorUiContext } from "./emulator-ui";
import { cleanQueryOutput } from "./media-store";
import { shellCommand } from "./transport";

/** Keep the pending file, backup, byte comparisons and publication on Android.
 * Only a pre-mutation unsupported response permits the older CLI path. */
export async function updatePpssppSettings(
  context: EmulatorUiContext, path: string, original: string, replacement: string,
): Promise<boolean> {
  const { device, user, signal } = context;
  signal?.throwIfAborted();
  if (await androidUserProcessPid(device, "org.ppsspp.ppsspp", user, signal)) {
    throw new Error("PPSSPP must remain stopped while updating its game folder.");
  }
  const directory = `/data/local/tmp/emukase-ppsspp-${crypto.randomUUID()}`;
  const dex = `${directory}/helper.dex`;
  const request = `${directory}/request.json`;
  const cleanup = `${shellCommand("rm", "-f", dex, request)}\n${shellCommand("rmdir", directory)}`;
  try {
    await device.shell(shellCommand("sh", "-c", `umask 077\n${shellCommand("mkdir", directory)}`));
    await device.push(await loadAndroidUiDump(signal), dex, { signal });
    await device.push(new TextEncoder().encode(JSON.stringify({ user, path, original, replacement })), request, { signal });
    await assertAndroidUser(device, user, signal);
    const output = cleanQueryOutput(await device.shell(shellCommand("sh", "-c", [
      "set -eu", shellCommand("trap", cleanup, "EXIT"), shellCommand("chmod", "400", dex, request),
      shellCommand("env", `CLASSPATH=${dex}`, "app_process", "/", "PpssppConfig", request),
    ].join("\n"))));
    signal?.throwIfAborted();
    if (output === "ppsspp-config:unsupported") return false;
    if (output !== "ppsspp-config:updated") throw new Error(`Android did not confirm PPSSPP's settings update. ${output}`);
    return true;
  } finally {
    await (device.restorationDevice ?? device).shell(cleanup).catch(() => {});
  }
}
