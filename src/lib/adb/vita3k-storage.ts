import { prepareAndroidAllFilesAccess } from "./android-storage-access";
import type { EmulatorUiContext } from "./emulator-ui";
import { VITA3K_PACKAGE } from "./vita3k-navigation";

/** Vita3K's native installer requires filesystem access in addition to its picker URI. */
export function prepareVita3kStorage(context: EmulatorUiContext): Promise<void> {
  return prepareAndroidAllFilesAccess(context, VITA3K_PACKAGE, "Vita3K");
}
