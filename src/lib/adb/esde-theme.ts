import { parseEsdeSettings } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";

export function verifyEsdeThemeSelection(profile: EsdeConfigurationProfile, log: string, library: "loaded" | "empty"): void {
  const theme = parseEsdeSettings(profile.settings ?? "").get("Theme")?.value;
  if (theme === undefined || library === "empty") return;
  const loaded = [...log.matchAll(/Finished loading theme "([^"\r\n]+)"/g)].map((match) => match[1]);
  if (loaded.length !== 1 || loaded[0] !== theme) throw new Error("ES-DE did not load the requested theme after restart; configuration was not reported as complete.");
}
