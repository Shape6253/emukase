export interface ApplicationRelease {
  name: string;
  version: string;
  packageName: string;
  apkUrl: string;
  apkSize?: number;
  sha256?: string;
}
