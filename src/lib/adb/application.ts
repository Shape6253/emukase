export interface ApplicationRelease {
  name: string;
  version: string;
  versionNameAliases?: readonly string[];
  packageName: string;
  apkUrl: string;
  apkSize?: number;
  sha256?: string;
}

export function matchesApplicationVersion(release: ApplicationRelease, version: string): boolean {
  return version === release.version || release.versionNameAliases?.includes(version) === true;
}
