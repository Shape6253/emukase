import { shellCommand } from "./transport";
import type { EmulatorUiContext } from "./emulator-ui";

// English is embedded in Kotlin; other translations live in the installed APK.
const ENGLISH = {
  "action.back": "Back",
  "action.import": "Import",
  "setup.button.next": "Next",
  "setup.button.letsGo": "Let's Go",
  "setup.button.applyFinish": "Apply & Finish",
  "setup.button.choose": "Choose",
  "setup.button.pickDifferentFolder": "Pick a different folder",
  "setup.button.pickRomsFolder": "Pick ROMs Folder",
  "setup.button.addAnotherFolder": "Add Another Folder",
  "setup.page.welcome.title": "Welcome",
  "setup.welcome.heading": "Welcome to ARMSX2 setup!",
  "setup.step.appData.title": "App Data Folder",
  "setup.page.bios.title": "Select your BIOS",
  "setup.page.roms.title": "Select ROMs folder",
  "setup.status.biosSelected": "BIOS selected",
  "setup.bios.selectTitle": "Select BIOS",
  "games.overflow.openNavigation": "Open navigation",
  "games.overflow.setup": "Setup / Change Folders",
  "bios.boot.title": "Boot BIOS",
} as const;

export type Armsx2LabelKey = keyof typeof ENGLISH;
export type Armsx2Labels = ReadonlyMap<Armsx2LabelKey, ReadonlySet<string>>;

/** Read all shipped translations, without assuming or changing the app's language. */
export async function readArmsx2Labels(context: EmulatorUiContext): Promise<Armsx2Labels> {
  const paths = (await context.device.shell(shellCommand("pm", "path", "--user", String(context.user), "com.armsx2"))).trim().split(/\r?\n/);
  const apk = paths.length === 1 ? /^package:(\/data\/app\/[^\r\n]+\/base\.apk)$/.exec(paths[0] ?? "")?.[1] : undefined;
  if (!apk || apk.split("/").some((part) => part === "." || part === "..")) throw new Error("ARMSX2's installed resources could not be located.");
  const keys = Object.keys(ENGLISH) as Armsx2LabelKey[];
  const patterns = keys.flatMap((key) => ["-e", JSON.stringify(key)]);
  const marker = `emukase-armsx2-labels-${crypto.randomUUID()}`;
  const script = ["set -eu", "set -o pipefail",
    `${shellCommand("unzip", "-p", apk, "assets/i18n/*.json")} | ${shellCommand("grep", "-F", ...patterns)}`,
    shellCommand("printf", "%s", marker),
  ].join("\n");
  const output = await context.device.shell(shellCommand("sh", "-c", script));
  context.signal?.throwIfAborted();
  if (output.length > 262_144 || !output.endsWith(marker)) throw new Error("ARMSX2's language resources could not be read.");
  const labels = new Map<Armsx2LabelKey, Set<string>>(keys.map((key) => [key, new Set([ENGLISH[key]])]));
  for (const line of output.slice(0, -marker.length).trim().split(/\r?\n/)) {
    const value: unknown = JSON.parse(`{${line.trim().replace(/,$/, "")}}`);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) throw new Error("ARMSX2 returned invalid language resources.");
    for (const key of keys) {
      const text: unknown = (value as Record<string, unknown>)[key];
      if (typeof text === "string" && text.length > 0 && text.length <= 512 && !/[\x00-\x1f\x7f]/.test(text)) labels.get(key)?.add(text);
    }
  }
  return labels;
}
