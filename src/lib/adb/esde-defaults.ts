import { parseEsdeSettings } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";
import { ESDE_THEME } from "./esde-theme-source";

export function assertEsdeSystemLanguage(source: string): void {
  const settings = parseEsdeSettings(source);
  for (const key of ["ApplicationLanguage", "ThemeLanguage"]) {
    const setting = settings.get(key);
    if (setting?.type !== "string" || setting.value !== "automatic") throw new Error("ES-DE is not configured to follow the system language. Run configuration to restore automatic language selection.");
  }
}

/** Use the configured theme's default view unless a profile explicitly selects a
 * different theme. Always follow Android's language on subsequent launches. */
export function withEsdeDefaults(profile: EsdeConfigurationProfile): EsdeConfigurationProfile {
  const source = profile.settings ?? "";
  const settings = parseEsdeSettings(source);
  for (const key of ["ApplicationLanguage", "ThemeLanguage"]) {
    if (settings.has(key) && settings.get(key)?.type !== "string") throw new Error(`Invalid ES-DE language setting type: ${key}.`);
  }
  const entries = [...settings.values()].filter((setting) => !["ApplicationLanguage", "ThemeLanguage"].includes(setting.name))
    .map((setting) => source.slice(setting.node.start, setting.node.end));
  if (!settings.has("Theme")) entries.push(`<string name="Theme" value="${ESDE_THEME.directory}" />`);
  if ((settings.get("Theme")?.value ?? ESDE_THEME.directory) === ESDE_THEME.directory) {
    for (const [name, value] of [["ThemeVariant", ESDE_THEME.variant], ["ThemeColorScheme", ""], ["ThemeFontSize", ""]]) {
      if (!settings.has(name)) entries.push(`<string name="${name}" value="${value}" />`);
    }
  }
  entries.push('<string name="ApplicationLanguage" value="automatic" />', '<string name="ThemeLanguage" value="automatic" />');
  return { ...profile, settings: entries.join("\n") };
}
