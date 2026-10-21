import { byteLengthHeader, HttpError, MAX_ARTIFACT_BYTES, MAX_LISTING_BYTES, transientStatus } from "./download-policy";
import { createTemporaryApk, type TemporaryApk } from "./temporary-apk";

export interface DownloadedFile {
  file: File;
  dispose(): Promise<void>;
}

export type Download = ((url: string) => Promise<Uint8Array>) & {
  /** The caller owns the temporary file and must dispose it after use. */
  file?: (url: string, onStart?: () => void) => Promise<DownloadedFile>;
};

export type PrefetchedArtifact = Download & {
  /** Resolves when the HTTP request starts, without waiting for its response. */
  started: Promise<void>;
  dispose(): Promise<void>;
};

export type PrefetchedApk = PrefetchedArtifact;

export interface DownloadSource {
  requestUrl(url: string, route: "artifact" | "text"): string;
}

export interface DownloadProgress {
  url: string;
  receivedBytes: number;
  totalBytes?: number;
}

export interface BrowserDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (event: DownloadProgress) => void;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Additional retries after the first attempt (0–5). */
  retries?: number;
  maxBytes?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

class TransferError extends Error {
  constructor(message: string, public transient = false) {
    super(message);
  }
}

function configuration(options: BrowserDownloadOptions, maximum: number) {
  const retries = options.retries ?? 2;
  const maxBytes = options.maxBytes ?? maximum;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const retryDelayMs = options.retryDelayMs ?? 200;
  for (const [name, value, minimum, max] of [
    ["retries", retries, 0, 5],
    ["maxBytes", maxBytes, 1, maximum],
    ["timeoutMs", timeoutMs, 1, 600_000],
    ["retryDelayMs", retryDelayMs, 0, 10_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > max) throw new Error(`Invalid ${name}.`);
  }
  return { retries, maxBytes, timeoutMs, retryDelayMs, fetch: options.fetch ?? globalThis.fetch.bind(globalThis) };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await (signal ? abortable(delay, signal) : delay);
  } finally {
    clearTimeout(timer);
  }
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

function transfer(source: DownloadSource, url: string, route: "artifact" | "text", options: BrowserDownloadOptions): Promise<Uint8Array>;
function transfer(source: DownloadSource, url: string, route: "artifact" | "text", options: BrowserDownloadOptions, writable: FileSystemWritableFileStream, onStart?: () => void): Promise<void>;
async function transfer(source: DownloadSource, url: string, route: "artifact" | "text", options: BrowserDownloadOptions, writable?: FileSystemWritableFileStream, onStart?: () => void): Promise<Uint8Array | void> {
  const requestUrl = source.requestUrl(url, route);
  const config = configuration(options, route === "artifact" ? MAX_ARTIFACT_BYTES : MAX_LISTING_BYTES);
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TransferError("Download timed out.", true)), config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    try {
      let response: Response;
      try {
        const request = config.fetch(requestUrl, {
          method: "GET",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal,
        });
        onStart?.();
        response = await abortable(request, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (error instanceof TransferError) throw error;
        throw new TransferError("Could not reach the download source.", true);
      }
      if (!response.ok) {
        cancelBody(response);
        throw new HttpError(response.status, url);
      }
      if (response.redirected || response.status !== 200) {
        cancelBody(response);
        throw new TransferError("The download source unexpectedly redirected.");
      }
      let expected: number | undefined;
      try {
        const encoding = response.headers.get("content-encoding");
        const encoded = encoding !== null && encoding.trim().toLowerCase() !== "identity";
        if (route === "artifact" && encoded) throw new Error("Encoded artifact responses are not supported.");
        // Fetch decodes compressed listings, while Content-Length still describes the encoded body.
        // CORS can hide Content-Encoding (for example on raw.githubusercontent.com),
        // so cross-origin text must be bounded by decoded bytes, not Content-Length.
        const decodedText = route === "text" && response.type === "cors";
        expected = encoded || decodedText ? undefined : byteLengthHeader(response.headers, config.maxBytes);
      } catch (error) {
        cancelBody(response);
        throw new TransferError(error instanceof Error ? error.message : "Invalid download headers.");
      }
      if (!response.body) throw new TransferError("Download response has no body.", true);
      const progress = (receivedBytes: number, complete = false) => options.onProgress?.({
        url, receivedBytes, totalBytes: complete ? receivedBytes : expected,
      });
      const reader = response.body.getReader();
      const bytes = !writable && expected !== undefined ? new Uint8Array(expected) : undefined;
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        if (writable) {
          // A retry replaces the previous partial attempt in the same file.
          await abortable(writable.truncate(0), signal);
          await abortable(writable.seek(0), signal);
        }
        progress(0);
        while (true) {
          let result: Awaited<ReturnType<typeof reader.read>>;
          try {
            result = await abortable(reader.read(), signal);
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            if (error instanceof TransferError) throw error;
            throw new TransferError("Download was interrupted.", true);
          }
          if (result.done) break;
          received += result.value.byteLength;
          if (received > config.maxBytes || (expected !== undefined && received > expected))
            throw new TransferError("Download exceeded its declared size or safety limit.");
          // Await disk writes before reading again so slow storage bounds the queue.
          if (writable) await abortable(writable.write(result.value as Uint8Array<ArrayBuffer>), signal);
          else if (bytes) bytes.set(result.value, received - result.value.byteLength);
          else chunks.push(result.value);
          if (expected === undefined || received < expected) progress(received);
        }
        if (expected !== undefined && received !== expected) throw new TransferError("Download was truncated.", true);
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (writable) {
        signal.throwIfAborted();
        progress(received, true);
        return;
      }
      const complete = bytes ?? new Uint8Array(received);
      if (!bytes) {
        let offset = 0;
        for (const chunk of chunks) {
          complete.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      signal.throwIfAborted();
      progress(received, true);
      return complete;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      const transient = error instanceof TransferError ? error.transient : error instanceof HttpError && transientStatus(error.status);
      if (!transient || attempt >= config.retries) throw error;
      if (config.retryDelayMs) await retryDelay(Math.min(config.retryDelayMs * 2 ** attempt, 10_000), options.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function downloadFile(source: DownloadSource, url: string, options: BrowserDownloadOptions, onStart?: () => void): Promise<DownloadedFile> {
  let temporary: TemporaryApk | undefined;
  let writable: FileSystemWritableFileStream | undefined;
  try {
    temporary = await createTemporaryApk(options.signal);
    options.signal?.throwIfAborted();
    const { handle, dispose } = temporary;
    writable = await handle.createWritable();
    await transfer(source, url, "artifact", options, writable, onStart);
    await writable.close();
    const file = await handle.getFile();
    options.signal?.throwIfAborted();
    return { file, dispose };
  } catch (error) {
    await writable?.abort(error).catch(() => {});
    await temporary?.dispose().catch(() => {});
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("Not enough browser storage for the APK. Free disk space or clear site data and try again.", { cause: error });
    }
    throw error;
  }
}

export function createBrowserDownloader(source: DownloadSource, options: BrowserDownloadOptions = {}): Download {
  configuration(options, MAX_ARTIFACT_BYTES);
  return Object.assign((url: string) => transfer(source, url, "artifact", options), {
    file: (url: string, onStart?: () => void) => downloadFile(source, url, options, onStart),
  });
}

/** Start an artifact download now; installation can consume it later without another request. */
export function prefetchArtifact(download: Download, url: string, signal?: AbortSignal): PrefetchedArtifact {
  signal?.throwIfAborted();
  if (!download.file) throw new Error("Artifact prefetch requires temporary file storage.");
  let markStarted: (() => void) | undefined;
  let failStart: ((error: unknown) => void) | undefined;
  const start = new Promise<void>((resolve, reject) => {
    markStarted = resolve;
    failStart = reject;
  });
  const started = signal ? abortable(start, signal) : start;
  const ready = download.file(url, () => markStarted?.());
  // Observe background failures until the installer reaches this artifact.
  void ready.catch((error: unknown) => failStart?.(error));
  void started.catch(() => {});
  return Object.assign((requested: string) => download(requested), {
    started,
    file(requested: string) {
      if (requested !== url) throw new Error("Prefetched artifact source does not match the request.");
      return ready;
    },
    async dispose() {
      const file = await ready.catch(() => undefined);
      await file?.dispose();
    },
  });
}

export function prefetchApk(download: Download, url: string, signal?: AbortSignal): PrefetchedArtifact {
  return prefetchArtifact(download, url, signal);
}

export async function downloadText(source: DownloadSource, url: string, options: BrowserDownloadOptions = {}): Promise<string> {
  return new TextDecoder().decode(await transfer(source, url, "text", options));
}
