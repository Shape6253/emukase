/** Unique shell framing marker, e.g. `__emukase_content_<uuid>__`. */
export function shellMarker(prefix: string): string {
  return `__emukase_${prefix}_${crypto.randomUUID()}__`;
}

/** Split framed output, verifying the trailing `<marker>:complete` line. */
export function completeMarkerLines(output: string, marker: string, expectedCount: number, message = "Android did not confirm the shell batch."): string[] {
  const lines = output.trim().split(/\r?\n/);
  if (lines.pop() !== `${marker}:complete` || lines.length !== expectedCount) {
    throw new Error(message);
  }
  return lines;
}
