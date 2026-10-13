export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_LISTING_BYTES = 2 * 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${url}`);
    this.status = status;
  }
}

export function byteLengthHeader(headers: Headers, maximum: number): number | undefined {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("Invalid Content-Length.");
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > maximum) throw new Error("Response exceeds the download size limit.");
  return size;
}

export function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}
