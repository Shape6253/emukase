import { assertAndroidUser } from "./android-user";
import { OBTAINIUM_PACKAGE } from "./obtainium-ui-anchors";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export function parseObtainiumInstallLabels(output: string): ReadonlySet<string> {
  if (!output.trim() || output.length > 8_388_608) throw new Error("Obtainium's translations are missing or too large.");
  const labels = new Set<string>();
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  // unzip emits one JSON object per asset. Frame each object before parsing it.
  for (let index = 0; index < output.length; index++) {
    const character = output[index];
    if (start < 0) {
      if (character?.trim() === "") continue;
      if (character !== "{") throw new Error("Obtainium's translation assets are invalid.");
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
    } else if (character === "\"") quoted = true;
    else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") {
      depth--;
      if (depth !== 0) continue;
      const value: unknown = JSON.parse(output.slice(start, index + 1));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Obtainium's translation asset is not an object.");
      }
      if ("install" in value) {
        const label = value.install;
        if (typeof label !== "string" || !label.trim() || label.length > 128 || /[\x00-\x1f]/.test(label)) {
          throw new Error("Obtainium's install action label is invalid.");
        }
        labels.add(label.trim());
      }
      start = -1;
    }
  }
  if (start >= 0 || !labels.size) throw new Error("Obtainium's install action translations were not confirmed.");
  return labels;
}

export async function readObtainiumInstallLabels(
  device: DeviceTransport, user: number, signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  await assertAndroidUser(device, user, signal);
  const output = await device.shell(shellCommand("pm", "path", "--user", String(user), OBTAINIUM_PACKAGE));
  const lines = output.trim().split(/\r?\n/);
  const paths = lines.map((line) => /^package:(\/[^\x00-\x1f]+\.apk)$/.exec(line)?.[1]);
  const bases = paths.filter((path) => path?.endsWith("/base.apk"));
  const path = paths.length === 1 ? paths[0] : bases.length === 1 ? bases[0] : undefined;
  if (paths.some((entry) => !entry) || !path) throw new Error("Obtainium's installed APK path was not confirmed.");
  checkAbort(signal);
  const translations = await device.shell(shellCommand("unzip", "-p", path, "assets/flutter_assets/assets/translations/*.json"));
  await assertAndroidUser(device, user, signal);
  return parseObtainiumInstallLabels(translations);
}
