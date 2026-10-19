import type { LibrarySupportRequirement } from "./library-catalog";

/** Enforce the selected row before handing files to a platform-wide importer. */
export function validateLibrarySupportSelection(requirement: LibrarySupportRequirement, files: readonly File[]): void {
  if (!files.length) throw new Error("Choose at least one support file.");
  const { picker } = requirement;
  if (!picker.multiple && files.length !== 1) throw new Error(`Choose one file at a time for ${requirement.label}.`);
  const extensions = picker.accept.toLowerCase().split(",").map((extension) => extension.trim()).filter(Boolean);
  for (const file of files) {
    if (!(file instanceof File)) throw new Error("Choose valid support files.");
    if ((picker.filenames && !picker.filenames.includes(file.name))
      || (extensions.length && !extensions.some((extension) => file.name.toLowerCase().endsWith(extension)))) {
      throw new Error(`Expected: ${requirement.expected}.`);
    }
  }
}
