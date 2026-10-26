import type { SetupStage } from "./setup-events";

export type FrontendId = "esde" | "daijisho" | "cocoon" | "retrohrai";
export type FrontendSelection = "android" | FrontendId;

export interface FrontendOption {
  id: FrontendId;
  name: string;
  requires: string;
  minSdk: number;
  obtainiumPackage?: string;
}

export const FRONTENDS: readonly FrontendOption[] = [
  { id: "esde", name: "ES-DE", requires: "Android 10+", minSdk: 29 },
  { id: "retrohrai", name: "RetroHrai!", requires: "Android 8.0+", minSdk: 26, obtainiumPackage: "com.retrohrai.launcher" },
  { id: "cocoon", name: "Cocoon Shell", requires: "Android 7.0+", minSdk: 24, obtainiumPackage: "rip.moth.cocoonshell" },
  { id: "daijisho", name: "Daijishō", requires: "Android 11+", minSdk: 30, obtainiumPackage: "com.magneticchen.daijishou" },
];

export function frontendSetupStages(selection: FrontendSelection): readonly { id: SetupStage; label: string }[] {
  if (selection === "android") return [];
  const frontend = FRONTENDS.find((option) => option.id === selection);
  if (!frontend) throw new Error("Unknown frontend selection.");
  return [
    { id: `extra:frontend-${selection}-install`, label: `Install ${frontend.name}` },
    { id: `extra:frontend-${selection}-configure`, label: `Configure ${frontend.name} and its game library` },
  ];
}
