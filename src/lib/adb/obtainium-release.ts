import type { ApplicationRelease } from "./application";
import type { Abi } from "./catalog";
import { OBTAINIUM_LATEST_RELEASE, OBTAINIUM_REPOSITORY, officialObtainiumArtifactKind } from "./artifact-policy";
import { MAX_ARTIFACT_BYTES } from "./download-policy";

export interface ObtainiumRelease extends ApplicationRelease {
  abi: Abi;
  apkSize: number;
  sha256: string;
}

export function obtainiumVersionAtLeast(version: string, minimum = "1.7.2"): boolean {
  const parse = (value: string): number[] | undefined => {
    if (!/^v?\d+\.\d+\.\d+$/.test(value)) return undefined;
    const parts = value.replace(/^v/, "").split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? parts : undefined;
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index++) {
    const left = actual[index];
    const right = required[index];
    if (left === undefined || right === undefined) return false;
    if (left !== right) return left > right;
  }
  return true;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Obtainium release metadata.");
  }
  return value as Record<string, unknown>;
}

function assetUrl(asset: Record<string, unknown>, tag: string, name: string): string {
  const expected = `https://github.com/${OBTAINIUM_REPOSITORY}/releases/download/${tag}/${name}`;
  if (asset["browser_download_url"] !== expected || asset["state"] !== "uploaded") {
    throw new Error("Obtainium release asset is not an uploaded official download.");
  }
  return expected;
}

function digest(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^sha256:[a-f\d]{64}$/i.test(value)) {
    throw new Error("Invalid published Obtainium APK digest.");
  }
  return value.slice(7).toLowerCase();
}

export async function latestObtainiumRelease(
  abi: Abi,
  readText: (url: string) => Promise<string>,
): Promise<ObtainiumRelease> {
  if (abi === "x86") throw new Error("Obtainium does not support 32-bit x86 Android devices.");
  if (!["arm64-v8a", "armeabi-v7a", "x86_64"].includes(abi)) throw new Error("Unsupported Obtainium architecture.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(OBTAINIUM_LATEST_RELEASE)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Obtainium release source returned invalid JSON.");
    throw error;
  }
  const release = record(parsed);
  const tag = release["tag_name"];
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag) ||
    release["draft"] !== false || release["prerelease"] !== false ||
    typeof release["url"] !== "string" ||
    !new RegExp(`^https://api\\.github\\.com/repos/${OBTAINIUM_REPOSITORY}/releases/[1-9]\\d*$`).test(release["url"])) {
    throw new Error("Obtainium metadata does not describe an official stable release.");
  }
  const assetsValue = release["assets"];
  if (!Array.isArray(assetsValue) || assetsValue.length > 200) throw new Error("Invalid Obtainium release asset list.");
  const assets = (assetsValue as unknown[]).map(record);
  function findAsset(name: string): Record<string, unknown> | undefined {
    const matches = assets.filter((asset) => asset["name"] === name);
    if (matches.length > 1) throw new Error("Obtainium release contains duplicate assets.");
    return matches[0];
  }
  const specific = `app-${abi}-release.apk`;
  const filename = findAsset(specific) ? specific : "app-release.apk";
  const apk = findAsset(filename);
  if (!apk) throw new Error(`No official stable Obtainium APK was found for ${abi}.`);
  const apkUrl = assetUrl(apk, tag, filename);
  officialObtainiumArtifactKind(apkUrl, "artifact");
  const size = apk["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 4 || size > MAX_ARTIFACT_BYTES) {
    throw new Error("Invalid published Obtainium APK size.");
  }
  const publishedDigest = digest(apk["digest"]);
  const checksum = findAsset(`${filename}.sha256`);
  let sha256 = publishedDigest;
  if (checksum) {
    if (typeof checksum["size"] !== "number" || !Number.isSafeInteger(checksum["size"]) ||
      checksum["size"] < 64 || checksum["size"] > 256) {
      throw new Error("Invalid Obtainium checksum asset size.");
    }
    const url = assetUrl(checksum, tag, `${filename}.sha256`);
    officialObtainiumArtifactKind(url, "text");
    const text = (await readText(url)).trim();
    if (!/^[a-f\d]{64}$/i.test(text)) throw new Error("Invalid published Obtainium APK SHA-256.");
    sha256 = text.toLowerCase();
    if (publishedDigest && sha256 !== publishedDigest) throw new Error("Published Obtainium APK checksums disagree.");
  }
  if (!sha256) throw new Error("The Obtainium release does not publish an APK SHA-256.");
  return {
    name: "Obtainium", version: tag.slice(1), packageName: "dev.imranr.obtainium",
    abi, apkUrl, apkSize: size, sha256,
  };
}
