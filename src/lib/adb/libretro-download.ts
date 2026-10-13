import { officialArtifactKind } from "./artifact-policy";
import { createBrowserDownloader, downloadText } from "./download";
import type { BrowserDownloadOptions, Download, DownloadSource } from "./download";

const source: DownloadSource = {
  requestUrl(url, route) {
    officialArtifactKind(url, route);
    return `/api/libretro/${route}?url=${encodeURIComponent(url)}`;
  },
};

export function createLibretroDownloader(options: BrowserDownloadOptions = {}): Download {
  return createBrowserDownloader(source, options);
}

export function readLibretroText(url: string, options: BrowserDownloadOptions = {}): Promise<string> {
  return downloadText(source, url, options);
}
