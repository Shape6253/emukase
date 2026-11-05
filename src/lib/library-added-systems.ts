import { validateLibrarySystemId } from "./adb/library-systems";

function storageKey(scope: string): string {
  return `emukase.library.addedSystems:${scope}`;
}

export function readAddedSystems(scope: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter((id): id is string => {
      if (typeof id !== "string") return false;
      try {
        validateLibrarySystemId(id);
        return true;
      } catch {
        return false;
      }
    }))];
  } catch {
    return [];
  }
}

export function persistAddedSystems(scope: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(ids));
  } catch {
    // Added systems remain available for this session if storage is unavailable.
  }
}
