import type { SetupStage } from "./setup-events";

export type FrontendId = "esde" | "daijisho" | "cocoon" | "retrohrai";
export type FrontendSelection = "android" | FrontendId;

export interface FrontendOption {
  id: FrontendId;
  name: string;
  requires: string;
  minSdk: number;
}

export const FRONTENDS: readonly FrontendOption[] = [
  { id: "esde", name: "ES-DE", requires: "Android 8.0+", minSdk: 26 },
  { id: "retrohrai", name: "RetroHrai!", requires: "Android 8.0+", minSdk: 26 },
  { id: "cocoon", name: "Cocoon Shell", requires: "Android 7.0+", minSdk: 24 },
  { id: "daijisho", name: "Daijishō", requires: "Android 8.0+", minSdk: 26 },
];

export function frontendSetupStages(selection: FrontendSelection): readonly { id: SetupStage; label: string }[] {
  if (selection === "android") return [];
  const frontend = FRONTENDS.find((option) => option.id === selection);
  if (!frontend) throw new Error("Unknown frontend selection.");
  return [
    { id: `extra:frontend-${selection}-install`, label: `Install ${frontend.name}` },
    { id: `extra:frontend-${selection}-configure`, label: `Configure ${frontend.name} and its game library` },
    { id: `extra:frontend-${selection}-finish`, label: "Return to Android home screen" },
  ];
}
