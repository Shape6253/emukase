import type { DeviceTransport } from "./transport";
import { readAndroidUser, userScopedDevice } from "./android-user";
import { inspectStorageBridge, prepareStorageBridge } from "./storage-bridge";

/** Reuse only a verified helper already installed in this profile. Connecting stays read-only. */
export async function selectedUserDevice(device: DeviceTransport): Promise<DeviceTransport> {
  const user = await readAndroidUser(device);
  const files = user === 0 ? device : ((await inspectStorageBridge(device, user)) ?? device);
  return userScopedDevice(files, user);
}

/** Explicit setup action; connection and dry-run inspection never install the helper. */
export async function prepareSelectedUserStorage(device: DeviceTransport, apk: Uint8Array): Promise<DeviceTransport> {
  const user = await readAndroidUser(device);
  if (user === 0) return userScopedDevice(device, user);
  return userScopedDevice(await prepareStorageBridge(device, user, apk), user);
}
