import type { DeviceTransport } from "./transport";
import { readAndroidUser, userScopedDevice } from "./android-user";

/** Pin the foreground profile without installing apps or changing permissions. */
export async function selectedUserDevice(device: DeviceTransport): Promise<DeviceTransport> {
  const user = await readAndroidUser(device);
  return userScopedDevice(device, user);
}
