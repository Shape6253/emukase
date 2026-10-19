import { readAndroidPackage } from "./android-package";
import { dismissEmulatorDocumentPicker } from "./android-document-picker";
import { withAndroidUiDump } from "./android-ui-dump";
import { readAndroidUser, userScopedDevice } from "./android-user";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import type { EmulatorUiContext } from "./emulator-ui";
import type { DeviceTransport } from "./transport";

export interface GameFolderConfigurationResult {
  library: ConfigurationItemState;
  setupComplete: boolean;
  contentVerified: boolean;
}

/** Share the profile, cancellation and screen-restoration boundary, not the
 * emulator-specific onboarding or folder verification. */
export async function runGameFolderConfiguration<T>(
  device: DeviceTransport, packageName: string, name: string, options: EmulatorConfigurationOptions,
  action: (context: EmulatorUiContext) => Promise<T>,
): Promise<T> {
  options.onStatus?.(`Checking ${name}'s installation and saved game folder…`);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  if (!await readAndroidPackage(scoped, packageName, user, options.signal)) {
    throw new Error(`Install ${name} before connecting its game folder.`);
  }
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, async () => {
        const context = { device: scoped, user, signal: options.signal, ensureUnlocked };
        if (!options.inspectOnly) await dismissEmulatorDocumentPicker(context, packageName);
        return action(context);
      }));
  } finally {
    await lease.release();
  }
}
