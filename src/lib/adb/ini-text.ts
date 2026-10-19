/** Match the ASCII-only whitespace used by the emulators' native INI readers. */
export function trimNativeIniWhitespace(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}
