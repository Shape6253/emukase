export interface HardwareInfo {
  /** Reported chip model from SoC properties/sysfs, never a board-name fallback. */
  soc: string;
  /** Internal Android platform identifier; diagnostic only, not a CPU model. */
  platform?: string;
  gpu: string;
  /** Kernel-visible MemTotal in MiB, not advertised capacity or currently free RAM. */
  ramMb?: number;
  /** Decoded major.minor (e.g. 1.3), not Android's packed integer. */
  vulkanVersion?: number;
  /** Decoded major.minor (e.g. 3.2), not Android's packed integer. */
  openGlEsVersion?: number;
  evidence: string[];
}
