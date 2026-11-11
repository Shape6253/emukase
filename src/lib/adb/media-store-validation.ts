import { primaryStorageForUser } from "./android-user";

export function assertMediaRecordId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[1-9]\d{0,18}$/.test(id)) throw new Error("Invalid MediaStore record ID.");
}

/** Base path check for indexed entries: prefix, length, controls, dot segments. */
export function assertStorageEntryPath(user: number, path: string): void {
  const prefix = `${primaryStorageForUser(user)}/`;
  if (!path.startsWith(prefix) || path.length > 2048 || /[\x00-\x1f\x7f]/.test(path)
    || path.slice(prefix.length).split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid MediaStore entry identity.");
  }
}

/** Extra MediaStore folder-batch checks shared by query validation. */
export function assertFolderBatchPath(user: number, path: string): void {
  assertStorageEntryPath(user, path);
  if (/["*:<>?\\|]/.test(path) || path.includes("//") || path.endsWith("/")) {
    throw new Error("Invalid MediaStore path batch.");
  }
}
