export interface EsdeXmlNode {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: EsdeXmlNode[];
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
}

export const ESDE_MAX_TEXT_BYTES = 2_097_152;

function validCharacter(code: number): boolean {
  return [9, 10, 13].includes(code) || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

export function validateEsdeText(text: string): void {
  if (new TextEncoder().encode(text).length > ESDE_MAX_TEXT_BYTES
    || [...text].some((character) => !validCharacter(character.codePointAt(0) ?? 0))) {
    throw new Error("ES-DE configuration is invalid or too large.");
  }
}

export function decodeEsdeXml(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(text)) {
    throw new Error("ES-DE configuration contains an invalid XML entity.");
  }
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity: string) => {
    const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    if (!entity.startsWith("#")) return names[entity] ?? "";
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || !validCharacter(code)) throw new Error("Invalid XML character.");
    return String.fromCodePoint(code);
  });
}

export function escapeEsdeXml(text: string): string {
  validateEsdeText(text);
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

/** ES-DE accepts both flat XML fragments and rooted documents. Keep source spans
 * so imports can preserve comments, unknown settings and unrelated metadata. */
export function parseEsdeXml(source: string): EsdeXmlNode[] {
  validateEsdeText(source);
  const roots: EsdeXmlNode[] = [];
  const stack: EsdeXmlNode[] = [];
  const token = /<!--[\s\S]*?-->|<\?xml\s[^?]*\?>|<\/[A-Za-z_][\w:.-]*\s*>|<[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  let offset = 0;
  let count = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) throw new Error("Malformed or unsupported ES-DE XML.");
    const start = offset;
    offset = token.lastIndex;
    const value = match[0];
    if (value.startsWith("<!--")) {
      if (value.slice(4, -3).includes("--")) throw new Error("Invalid XML comment.");
      continue;
    }
    if (value.startsWith("<?")) {
      if (stack.length || roots.length || source.slice(0, start).trim()) throw new Error("Misplaced XML declaration.");
      continue;
    }
    if (!value.startsWith("<")) {
      decodeEsdeXml(value);
      if (!stack.length && value.trim()) throw new Error("Unexpected ES-DE XML text.");
      continue;
    }
    if (value.startsWith("</")) {
      const node = stack.pop();
      if (!node || node.name !== value.slice(2, -1).trim()) throw new Error("Unmatched ES-DE XML element.");
      node.closeStart = start;
      node.end = offset;
      continue;
    }
    const name = /^<([A-Za-z_][\w:.-]*)/.exec(value)?.[1];
    if (!name || ++count > 32_768 || stack.length >= 64) throw new Error("ES-DE XML nesting is too large.");
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const attribute of value.matchAll(/\s+([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      const key = attribute[1];
      if (!key || attribute[3] === undefined || Object.hasOwn(attributes, key)) throw new Error("Duplicate XML attribute.");
      attributes[key] = decodeEsdeXml(attribute[3]);
    }
    const node: EsdeXmlNode = { name, attributes, children: [], start, openEnd: offset, closeStart: offset, end: offset };
    (stack.at(-1)?.children ?? roots).push(node);
    if (!/\/\s*>$/.test(value)) stack.push(node);
  }
  if (stack.length) throw new Error("Incomplete ES-DE XML.");
  return roots;
}

export function esdeXmlText(source: string, node: EsdeXmlNode): string {
  if (node.children.length) throw new Error(`Expected plain text in ${node.name}.`);
  return decodeEsdeXml(source.slice(node.openEnd, node.closeStart).replace(/<!--[\s\S]*?-->/g, ""));
}

export function esdeXmlRoot(source: string, name: string): EsdeXmlNode {
  const roots = parseEsdeXml(source);
  const root = roots[0];
  if (roots.length !== 1 || root?.name !== name) throw new Error(`Expected an ES-DE ${name} document.`);
  return root;
}

export function esdeXmlIdentity(source: string, node: EsdeXmlNode): string {
  const identity = (entry: EsdeXmlNode): unknown => [entry.name,
    Object.entries(entry.attributes).sort(([left], [right]) => left.localeCompare(right)),
    entry.children.length ? entry.children.map(identity) : esdeXmlText(source, entry).trim()];
  return JSON.stringify(identity(node));
}

export function editEsdeXml(source: string, edits: readonly { start: number; end: number; text: string }[]): string {
  let result = source;
  let boundary = source.length;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > boundary) throw new Error("Overlapping XML edits.");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    boundary = edit.start;
  }
  parseEsdeXml(result);
  return result;
}

export function appendEsdeXml(source: string, root: EsdeXmlNode, additions: string): string {
  if (root.openEnd === root.end) {
    return editEsdeXml(source, [{ start: root.start, end: root.end,
      text: source.slice(root.start, root.end).replace(/\/\s*>$/, () => `>\n${additions}\n</${root.name}>`) }]);
  }
  return editEsdeXml(source, [{ start: root.closeStart, end: root.closeStart, text: `\n${additions}\n` }]);
}
