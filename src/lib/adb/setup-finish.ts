import { userScopedDevice } from "./android-user";
import { checkAbort, type SetupEvent } from "./setup-events";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";

export const SETUP_FINISH_STAGE = { id: "extra:setup-finish", label: "Finish device setup" } as const;

/** Leave apps that keep the display awake only after every selected app has
 * finished. Intermediate setup steps hand the foreground directly to the next app. */
export async function finishDeviceSetup(
  device: DeviceTransport, user: number,
  options: { signal?: AbortSignal; log?: (message: string) => void; onEvent?: (event: SetupEvent) => void } = {},
): Promise<void> {
  const { signal, onEvent } = options;
  checkAbort(signal);
  const scoped = userScopedDevice(device, user, signal);
  const stage = SETUP_FINISH_STAGE.id;
  onEvent?.({ stage, status: "running", message: "Finishing setup and returning to Android's home screen…" });
  try {
    checkActivityStart(await scoped.shell(shellCommand(
      "am", "start", "--user", String(user), "-W", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME",
    )));
    checkAbort(signal);
    options.log?.("All selected apps are configured. Returned to Android's home screen.");
    onEvent?.({ stage, status: "complete" });
  } catch (error) {
    onEvent?.({ stage, status: "failed" });
    throw error;
  }
}
