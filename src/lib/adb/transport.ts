export type Apk = Uint8Array | Blob;

/** No Bun or filesystem dependencies: the installer can also use a WebADB adapter. */
export interface DeviceTransport {
  /** Foreground Android user pinned for this operation, when scoped. */
  readonly androidUser?: number;
  /** Original connection for cleanup and restoration after cancellation. */
  readonly restorationDevice?: DeviceTransport;
  shell(command: string): Promise<string>;
  push(data: Uint8Array, remotePath: string): Promise<void>;
  install(apk: Apk, user?: number, installerPackageName?: string): Promise<void>;
}

export function shellCommand(...args: string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", "'\"'\"'")}'`).join(" ");
}

export function checkActivityStart(output: string): void {
  // `am start` can report an error while returning exit code 0.
  if (/Error:|Exception|Permission Denial|Status:\s*(?!ok\b)\S+/i.test(output)) {
    throw new Error(`Android failed to launch the application:\n${output.trim()}`);
  }
}
