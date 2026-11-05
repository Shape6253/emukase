import { normalizeStorageFolder, ROMS_FOLDER, SUPPORT_FOLDER, WORKSPACE_FOLDER } from "./adb/workspace";
import type { LibraryFolderOptions } from "./adb/workspace";
import { readLibraryPreferences, persistLibraryPreferences, type LibraryPreferences } from "./library-preferences";

/** Folder paths are relative to the current Android profile's internal storage. */
export class LibrarySettings {
  private readonly getDeviceSerial: () => string | undefined;
  private saved = $state<Record<string, LibraryPreferences>>({});
  private preferences = $derived.by(() => {
    const serial = this.getDeviceSerial();
    const saved = serial && Object.hasOwn(this.saved, serial) ? this.saved[serial] : undefined;
    return saved ?? readLibraryPreferences(serial);
  });

  constructor(getDeviceSerial: () => string | undefined) {
    this.getDeviceSerial = getDeviceSerial;
  }

  open = $state(false);
  libraryFolderInvalid = $state(false);
  romsFolderInvalid = $state(false);
  biosFolderInvalid = $state(false);
  foldersInvalid = $derived(this.libraryFolderInvalid || this.romsFolderInvalid || this.biosFolderInvalid);
  libraryFolder = $derived(this.preferences.libraryFolder);
  defaultRomsFolder = $derived(`${this.libraryFolder}/${ROMS_FOLDER}`);
  defaultBiosFolder = $derived(`${this.libraryFolder}/${SUPPORT_FOLDER}`);
  /** Empty uses ROMs under the selected library root. */
  romsFolder = $derived(this.preferences.romsFolder);
  /** Empty uses BIOS under the selected library root. */
  biosFolder = $derived(this.preferences.biosFolder);

  get folderOptions(): LibraryFolderOptions {
    return {
      libraryFolder: this.libraryFolder,
      romsFolder: this.romsFolder || undefined,
      biosFolder: this.biosFolder || undefined,
    };
  }

  private update(changes: Partial<LibraryPreferences>): void {
    const serial = this.getDeviceSerial();
    if (!serial) throw new Error("Connect a device before changing its library settings.");
    const preferences = { ...this.preferences, ...changes };
    this.saved = { ...this.saved, [serial]: preferences };
    persistLibraryPreferences(serial, preferences);
  }

  setLibraryFolder(value: string): void {
    const folder = normalizeStorageFolder(value);
    this.update({ libraryFolder: folder || WORKSPACE_FOLDER });
  }

  setRomsFolder(value: string): void {
    const folder = normalizeStorageFolder(value);
    if (folder === this.defaultRomsFolder) {
      this.resetRomsFolder();
      return;
    }
    this.update({ romsFolder: folder });
  }

  resetRomsFolder(): void {
    this.update({ romsFolder: "" });
  }

  setBiosFolder(value: string): void {
    const folder = normalizeStorageFolder(value);
    if (folder === this.defaultBiosFolder) {
      this.resetBiosFolder();
      return;
    }
    this.update({ biosFolder: folder });
  }

  resetBiosFolder(): void {
    this.update({ biosFolder: "" });
  }
}
