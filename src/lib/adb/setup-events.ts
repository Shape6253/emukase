export type SetupStage = "prepare" | "download" | "verify" | "install" | `extra:${string}`;
export type SetupEvent = {
  stage: SetupStage;
  status: "running" | "complete" | "failed" | "skipped";
  completed?: number;
  total?: number;
  message?: string;
  unlockRequired?: boolean;
};

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Setup stopped.");
}
