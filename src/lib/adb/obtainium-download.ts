import { officialObtainiumArtifactKind } from "./artifact-policy";
import { createBrowserDownloader, downloadText } from "./download";
import type { BrowserDownloadOptions, Download, DownloadSource } from "./download";

const source: DownloadSource = {
  requestUrl(url, route) {
    officialObtainiumArtifactKind(url, route);
    return `/api/obtainium/${route}?url=${encodeURIComponent(url)}`;
  },
};

export function createObtainiumDownloader(options: BrowserDownloadOptions = {}): Download {
  return createBrowserDownloader(source, options);
}

export function readObtainiumText(url: string, options: BrowserDownloadOptions = {}): Promise<string> {
  return downloadText(source, url, options);
}
