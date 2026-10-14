const WORKSPACE_NAME = "Emukase";

export interface WorkspacePaths {
  root: string;
  roms: string;
  bios: string;
  esde: string;
  media: string;
  saves: string;
  states: string;
  setup: string;
}

export function workspacePaths(primaryStorage: string): WorkspacePaths {
  const user = /^\/storage\/emulated\/(0|[1-9]\d*)$/.exec(primaryStorage)?.[1];
  if (user === undefined || !Number.isSafeInteger(Number(user))) {
    throw new Error("Workspace requires the current Android user's resolved internal storage.");
  }
  const root = `${primaryStorage}/${WORKSPACE_NAME}`;
  return {
    root,
    roms: `${root}/ROMs`,
    bios: `${root}/BIOS`,
    esde: `${root}/ES-DE`,
    media: `${root}/ES-DE/downloaded_media`,
    saves: `${root}/saves`,
    states: `${root}/states`,
    setup: `${root}/setup`,
  };
}
