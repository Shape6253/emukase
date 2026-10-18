import { appendEsdeXml, editEsdeXml, esdeXmlIdentity, esdeXmlRoot, esdeXmlText, escapeEsdeXml, parseEsdeXml } from "./esde-xml";
import type { EsdeXmlNode } from "./esde-xml";

export interface EsdeConfigurationProfile {
  /** Native es_settings.xml, either flat or wrapped in <settings>. */
  settings?: string;
  /** Native command labels, not translated UI captions or emulator array indices. */
  alternativeEmulators?: Readonly<Record<string, string>>;
  customSystems?: string;
  findRules?: string;
  /** Only mappings for GUIDs already present on the target are replaced. */
  input?: string;
}

export interface EsdeSetting {
  name: string;
  type: "bool" | "int" | "float" | "string";
  value: string;
  node: EsdeXmlNode;
}

export function parseEsdeSettings(source: string): ReadonlyMap<string, EsdeSetting> {
  const roots = parseEsdeXml(source);
  const nodes = roots.length === 1 && roots[0]?.name === "settings" ? roots[0].children : roots;
  const result = new Map<string, EsdeSetting>();
  for (const node of nodes) {
    const { name, value } = node.attributes;
    const type = node.name;
    if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || value === undefined
      || !["bool", "int", "float", "string"].includes(type) || Object.keys(node.attributes).length !== 2
      || node.children.length || esdeXmlText(source, node).trim() || result.has(name)) {
      throw new Error("ES-DE settings contain an invalid or duplicate entry.");
    }
    if (type === "bool" && !["true", "false"].includes(value)) throw new Error(`Invalid boolean setting: ${name}.`);
    if (type === "int" && (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))
      || Number(value) < -2_147_483_648 || Number(value) > 2_147_483_647)) throw new Error(`Invalid integer setting: ${name}.`);
    if (type === "float" && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
      || !Number.isFinite(Number(value)))) throw new Error(`Invalid float setting: ${name}.`);
    result.set(name, { name, type: type as EsdeSetting["type"], value, node });
  }
  return result;
}

/** The target's app-generated settings are the schema; no version allowlist or
 * frozen list of setting names is needed. Unknown/type-changed keys fail closed. */
export function mergeEsdeSettings(existing: string, imported: string, controllerNavigationVerified = false): string {
  const current = parseEsdeSettings(existing);
  const desired = parseEsdeSettings(imported);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [name, setting] of desired) {
    if (name === "ROMDirectory") throw new Error("Android's ROM directory must be selected through ES-DE, not es_settings.xml.");
    const target = current.get(name);
    if (!target || target.type !== setting.type) throw new Error(`This ES-DE installation does not expose ${name} with type ${setting.type}.`);
    if (name === "InputTouchOverlay" && setting.value === "false" && !controllerNavigationVerified) {
      throw new Error("Verify controller navigation before disabling ES-DE's touch overlay.");
    }
    if (target.value === setting.value || (["int", "float"].includes(setting.type) && Number(target.value) === Number(setting.value))) continue;
    edits.push({ start: target.node.start, end: target.node.end,
      text: `<${setting.type} name="${escapeEsdeXml(name)}" value="${escapeEsdeXml(setting.value)}" />` });
  }
  return editEsdeXml(existing, edits);
}

export function validateEsdeSystemId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid ES-DE system ID.");
}

export function validateEsdeEmulatorLabel(label: string): void {
  if (!label.trim() || label.length > 256 || /[\x00-\x1f\x7f]/.test(label)) throw new Error("Invalid ES-DE emulator label.");
}

function systemName(source: string, node: EsdeXmlNode): string {
  const names = node.children.filter((child) => child.name === "name");
  if (names.length !== 1 || !names[0]) throw new Error("An ES-DE system must have one name.");
  const name = esdeXmlText(source, names[0]).trim();
  validateEsdeSystemId(name);
  return name;
}

function definitionDocument(source: string, kind: "systems" | "rules"): { root: EsdeXmlNode; exclusive?: EsdeXmlNode } {
  if (kind === "rules") return { root: esdeXmlRoot(source, "ruleList") };
  const roots = parseEsdeXml(source);
  const systems = roots.filter((node) => node.name === "systemList");
  const markers = roots.filter((node) => node.name === "loadExclusive");
  const root = systems[0];
  const exclusive = markers[0];
  if (systems.length !== 1 || !root || markers.length > 1 || roots.length !== systems.length + markers.length
    || exclusive && (Object.keys(exclusive.attributes).length || exclusive.children.length || esdeXmlText(source, exclusive).trim())) {
    throw new Error("Expected an ES-DE systemList document with at most one empty loadExclusive marker.");
  }
  return { root, exclusive };
}

/** Preserve other systems/rules instead of replacing the complete bundled or user configuration. */
export function mergeEsdeDefinitions(existing: string, imported: string, kind: "systems" | "rules"): string {
  const allowed = kind === "systems" ? ["system"] : ["emulator", "core"];
  const currentDocument = definitionDocument(existing, kind);
  const incomingDocument = definitionDocument(imported, kind);
  const root = currentDocument.root;
  const incoming = incomingDocument.root;
  const keyed = (source: string, nodes: readonly EsdeXmlNode[]): Map<string, EsdeXmlNode> => {
    const result = new Map<string, EsdeXmlNode>();
    for (const node of nodes) {
      const name = kind === "systems" ? systemName(source, node) : node.attributes.name;
      if (!allowed.includes(node.name) || !name || !/^[\w-]+$/.test(name) || result.has(`${node.name}:${name}`)) {
        throw new Error("Invalid or duplicate ES-DE system/find-rule definition.");
      }
      if (kind === "systems") {
        for (const field of ["fullname", "path", "extension", "command"]) {
          const entries = node.children.filter((child) => child.name === field);
          if (!entries.length || (field !== "command" && entries.length !== 1)
            || entries.some((entry) => !esdeXmlText(source, entry).trim())) throw new Error(`ES-DE system is missing ${field}.`);
        }
      }
      result.set(`${node.name}:${name}`, node);
    }
    return result;
  };
  const current = keyed(existing, root.children);
  const desired = keyed(imported, incoming.children);
  const edits: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  if (incomingDocument.exclusive && !currentDocument.exclusive) {
    const marker = incomingDocument.exclusive;
    edits.push({ start: root.start, end: root.start, text: `${imported.slice(marker.start, marker.end)}\n` });
  }
  for (const [key, node] of desired) {
    const text = imported.slice(node.start, node.end);
    const previous = current.get(key);
    if (previous && esdeXmlIdentity(existing, previous) !== esdeXmlIdentity(imported, node)) edits.push({ start: previous.start, end: previous.end, text });
    else if (previous) continue;
    else additions.push(text);
  }
  const merged = editEsdeXml(existing, edits);
  return additions.length ? appendEsdeXml(merged, definitionDocument(merged, kind).root, additions.join("\n")) : merged;
}

export function esdeUsesExclusiveSystems(source: string): boolean {
  return definitionDocument(source, "systems").exclusive !== undefined;
}

export function esdeEmulatorLabels(source: string, system: string): ReadonlySet<string> {
  validateEsdeSystemId(system);
  const root = definitionDocument(source, "systems").root;
  const matches = root.children.filter((node) => node.name === "system" && systemName(source, node) === system);
  if (matches.length > 1) throw new Error("Duplicate ES-DE system definition.");
  const labels = matches[0]?.children.filter((node) => node.name === "command").flatMap((node) =>
    node.attributes.label ? [node.attributes.label] : []) ?? [];
  if (new Set(labels).size !== labels.length) throw new Error("Ambiguous ES-DE command label.");
  return new Set(labels);
}

export function esdeDefinesSystem(source: string, system: string): boolean {
  validateEsdeSystemId(system);
  return definitionDocument(source, "systems").root.children.some((node) => node.name === "system" && systemName(source, node) === system);
}

export function esdeSystemPath(source: string, system: string): string {
  validateEsdeSystemId(system);
  const matches = definitionDocument(source, "systems").root.children.filter((node) => node.name === "system" && systemName(source, node) === system);
  const paths = matches[0]?.children.filter((node) => node.name === "path") ?? [];
  if (matches.length !== 1 || paths.length !== 1 || !paths[0]) throw new Error(`ES-DE system ${system} must define one ROM path.`);
  const path = esdeXmlText(source, paths[0]).trim();
  if (!path) throw new Error(`ES-DE system ${system} has an empty ROM path.`);
  return path;
}

export function mergeEsdeAlternativeEmulator(existing: string, label: string): string {
  validateEsdeEmulatorLabel(label);
  const roots = parseEsdeXml(existing);
  const games = roots.filter((node) => node.name === "gameList");
  const root = games[0];
  if (games.length !== 1 || !root || roots.some((node) => !["gameList", "alternativeEmulator"].includes(node.name))) {
    throw new Error("Unsupported ES-DE gamelist format.");
  }
  const alternatives = [...roots.filter((node) => node.name === "alternativeEmulator"),
    ...root.children.filter((node) => node.name === "alternativeEmulator")];
  if (alternatives.length > 1) throw new Error("Duplicate alternative emulator selection.");
  const previous = alternatives[0];
  const selection = `<alternativeEmulator><label>${escapeEsdeXml(label)}</label></alternativeEmulator>`;
  if (!previous) return editEsdeXml(existing, [{ start: root.start, end: root.start, text: `${selection}\n` }]);
  const labels = previous.children.filter((node) => node.name === "label");
  if (labels.length !== 1 || !labels[0]) throw new Error("Invalid alternative emulator selection.");
  const current = esdeXmlText(existing, labels[0]);
  // Use the document-level location accepted by older ES-DE releases too.
  // A matching nested label must still be moved before verification can pass.
  if (!roots.includes(previous)) return editEsdeXml(existing, [
    { start: previous.start, end: previous.end, text: "" },
    { start: root.start, end: root.start, text: `${selection}\n` },
  ]);
  if (current === label) return existing;
  return editEsdeXml(existing, [{ start: previous.start, end: previous.end, text: selection }]);
}

export function mergeEsdeInput(existing: string, imported: string): string {
  const root = esdeXmlRoot(existing, "inputList");
  const incoming = esdeXmlRoot(imported, "inputList");
  const identities = new Set<string>();
  const edits = incoming.children.flatMap((node) => {
    const guid = node.attributes.deviceGUID;
    const type = node.attributes.type;
    if (node.name !== "inputConfig" || type !== "controller" || !guid || !/^[a-f\d]{32}$/i.test(guid)
      || identities.has(guid.toLowerCase()) || !node.children.length) {
      throw new Error("Import only unique controller mappings with a valid SDL GUID.");
    }
    identities.add(guid.toLowerCase());
    const matches = root.children.filter((entry) => entry.name === "inputConfig"
      && entry.attributes.deviceGUID?.toLowerCase() === guid.toLowerCase() && entry.attributes.type === type);
    if (matches.length !== 1 || !matches[0]) throw new Error("The imported controller GUID is not configured on this device.");
    const target = matches[0];
    const names = new Set<string>();
    const mappings = node.children.map((mapping) => {
      const { name, type: inputType, id, value } = mapping.attributes;
      if (mapping.name !== "input" || mapping.children.length || !name || !/^[a-z][a-z0-9_]*$/i.test(name)
        || names.has(name) || !inputType || !["button", "axis", "key"].includes(inputType)
        || id === undefined || !/^\d+$/.test(id) || Number(id) > 2_147_483_647
        || value === undefined || !/^-?\d+$/.test(value) || Math.abs(Number(value)) > 2_147_483_647
        || Object.keys(mapping.attributes).length !== 4 || esdeXmlText(imported, mapping).trim()) {
        throw new Error("Invalid or duplicate ES-DE controller input mapping.");
      }
      names.add(name);
      return mapping;
    });
    let replacement = existing.slice(target.start, target.end);
    const localRoot = esdeXmlRoot(replacement, "inputConfig");
    const localEdits: { start: number; end: number; text: string }[] = [];
    const additions: string[] = [];
    for (const mapping of mappings) {
      const previous = localRoot.children.filter((entry) => entry.name === "input" && entry.attributes.name === mapping.attributes.name);
      if (previous.length > 1) throw new Error("Ambiguous target controller input mapping.");
      const current = previous[0];
      const text = imported.slice(mapping.start, mapping.end);
      if (!current) additions.push(text);
      else if (esdeXmlIdentity(replacement, current) !== esdeXmlIdentity(imported, mapping)) {
        localEdits.push({ start: current.start, end: current.end, text });
      }
    }
    replacement = editEsdeXml(replacement, localEdits);
    if (additions.length) replacement = appendEsdeXml(replacement, esdeXmlRoot(replacement, "inputConfig"), additions.join("\n"));
    return replacement === existing.slice(target.start, target.end) ? [] : [{ start: target.start, end: target.end, text: replacement }];
  });
  return editEsdeXml(existing, edits);
}

export function validateEsdeProfile(profile: EsdeConfigurationProfile): void {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)
    || Object.keys(profile).some((key) => !["settings", "alternativeEmulators", "customSystems", "findRules", "input"].includes(key))) {
    throw new Error("Invalid ES-DE configuration profile.");
  }
  for (const key of ["settings", "customSystems", "findRules", "input"] as const) {
    if (profile[key] !== undefined && typeof profile[key] !== "string") throw new Error("ES-DE profile files must contain XML text.");
  }
  if (profile.settings !== undefined) {
    const settings = parseEsdeSettings(profile.settings);
    if (!settings.size) throw new Error("The imported ES-DE settings file is empty.");
    if (settings.has("ROMDirectory")) throw new Error("Android's ROM directory must be selected through ES-DE, not es_settings.xml.");
  }
  if (profile.customSystems !== undefined) mergeEsdeDefinitions("<systemList />", profile.customSystems, "systems");
  if (profile.findRules !== undefined) mergeEsdeDefinitions("<ruleList />", profile.findRules, "rules");
  if (profile.input !== undefined) mergeEsdeInput(profile.input, profile.input);
  if (profile.alternativeEmulators !== undefined) {
    if (!profile.alternativeEmulators || typeof profile.alternativeEmulators !== "object" || Array.isArray(profile.alternativeEmulators)
      || Object.keys(profile.alternativeEmulators).length > 512) throw new Error("Invalid ES-DE emulator selections.");
    for (const [system, label] of Object.entries(profile.alternativeEmulators)) {
      validateEsdeSystemId(system);
      if (typeof label !== "string") throw new Error("ES-DE emulator labels must be strings.");
      validateEsdeEmulatorLabel(label);
    }
  }
}

/** Accept a native settings file or one JSON profile containing several native XML files. */
export async function readEsdeProfile(file: Blob | string): Promise<EsdeConfigurationProfile> {
  if (typeof file !== "string" && (!(file instanceof Blob) || file.size > 2_097_152)) throw new Error("Invalid ES-DE profile file.");
  const source = typeof file === "string" ? file : await file.text();
  if (new TextEncoder().encode(source).length > 2_097_152) throw new Error("ES-DE profile is too large.");
  const value: unknown = source.trimStart().startsWith("{") ? JSON.parse(source.trim()) : { settings: source };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ES-DE profile file.");
  const profile = value as EsdeConfigurationProfile;
  validateEsdeProfile(profile);
  return profile;
}
