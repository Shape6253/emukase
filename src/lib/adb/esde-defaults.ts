import { parseEsdeSettings } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";

export function assertEsdeSystemLanguage(source: string): void {
  const settings = parseEsdeSettings(source);
  for (const key of ["ApplicationLanguage", "ThemeLanguage"]) {
    const setting = settings.get(key);
    if (setting?.type !== "string" || setting.value !== "automatic") throw new Error("ES-DE is not configured to follow the system language. Run configuration to restore automatic language selection.");
  }
}

/** Follow Android's language on every launch, not the browser's language or a
 * locale copied from another device. Preserve the theme unless explicitly imported. */
export function withEsdeDefaults(profile: EsdeConfigurationProfile): EsdeConfigurationProfile {
  const source = profile.settings ?? "";
  const settings = parseEsdeSettings(source);
  for (const key of ["ApplicationLanguage", "ThemeLanguage"]) {
    if (settings.has(key) && settings.get(key)?.type !== "string") throw new Error(`Invalid ES-DE language setting type: ${key}.`);
  }
  const entries = [...settings.values()].filter((setting) => !["ApplicationLanguage", "ThemeLanguage"].includes(setting.name))
    .map((setting) => source.slice(setting.node.start, setting.node.end));
  entries.push('<string name="ApplicationLanguage" value="automatic" />', '<string name="ThemeLanguage" value="automatic" />');
  return { ...profile, settings: entries.join("\n") };
}
