/// <reference types="w3c-web-usb" />

import { Adb, AdbDaemonTransport, type AdbDaemonConnection, type AdbShellProtocolProcess, type AdbSync } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { PackageManager } from "@yume-chan/android-bin";
import { ReadableStream } from "@yume-chan/stream-extra";
import type { Apk, DeviceTransport } from "./transport";
import { selectedUserDevice } from "./user-connection";
import { readAndroidUser, assertAndroidUser } from "./android-user";

export interface WebAdbConnection {
  transport: DeviceTransport;
  serial: string;
  close(): Promise<void>;
  /** Resolves on unplug, connection failure, or an explicit close; never rejects. */
  disconnected: Promise<void>;
}

export interface WebAdbSupport {
  supported: boolean;
  reason?: string;
}

export function webAdbSupport(): WebAdbSupport {
  if (typeof globalThis.navigator === "undefined") {
    return { supported: false, reason: "WebADB requires a browser with WebUSB: use Chrome or Edge on a computer." };
  }
  if (!globalThis.isSecureContext) {
    return { supported: false, reason: "WebUSB requires a secure address: open the site over HTTPS or through localhost." };
  }
  if (typeof globalThis.navigator.usb?.requestDevice !== "function") {
    return { supported: false, reason: "This browser does not support WebUSB. Use Chrome or Edge on a computer." };
  }
  if (!globalThis.crypto?.subtle || typeof globalThis.indexedDB === "undefined") {
    return { supported: false, reason: "Saving the ADB key requires Web Crypto and IndexedDB. Allow the site to store browser data." };
  }
  return { supported: true };
}

// Narrow, SDK-derived types are also the test seam: tests never open real USB hardware.
export type WebAdbClient = Pick<Adb, "serial" | "disconnected" | "close"> & {
  subprocess: {
    shellProtocol?: { spawn(command: string | readonly string[], signal?: AbortSignal): Promise<AdbShellProtocolProcess> };
  };
  sync(): Promise<Pick<AdbSync, "write" | "dispose">>;
};

export interface WebAdbDevice {
  serial: string;
  connect(): Promise<AdbDaemonConnection>;
  raw: Pick<USBDevice, "close">;
}

export interface WebAdbBackend {
  support(): WebAdbSupport;
  requestDevice(): Promise<WebAdbDevice | undefined>;
  /** Client close must preserve USB; the adapter releases the owned USB connection. */
  authenticate(
    device: WebAdbDevice,
    connection: AdbDaemonConnection,
  ): Promise<{
    adb: WebAdbClient;
    packageManager: Pick<PackageManager, "installStream">;
  }>;
}

const TIMEOUTS = { connect: 20_000, authenticate: 60_000, shell: 20_000, push: 90_000, install: 300_000, close: 5_000 };
type Timeouts = typeof TIMEOUTS;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const usbOwners = new WeakMap<WebAdbDevice["raw"], symbol>();
let credentialStore: AdbWebCredentialStore | undefined;

const browserBackend: WebAdbBackend = {
  support: webAdbSupport,
  requestDevice() {
    // Do not defer the picker: requestDevice must retain the button's user activation.
    return new AdbDaemonWebUsbDeviceManager(globalThis.navigator.usb).requestDevice();
  },
  async authenticate(device, connection) {
    // This SDK store reuses RSA credentials persisted in the origin's IndexedDB.
    credentialStore ??= new AdbWebCredentialStore("Emukase");
    const daemon = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore, preserveConnection: true });
    const adb = new Adb(daemon);
    return { adb, packageManager: new PackageManager(adb) };
  },
};

export async function connectWebAdb(): Promise<WebAdbConnection> {
  const connection = await connectWebAdbWith(browserBackend);
  try {
    return { ...connection, transport: await selectedUserDevice(connection.transport) };
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

class TimeoutError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timed<T>(promise: PromiseLike<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function releaseUsb(
  device: WebAdbDevice,
  connection: AdbDaemonConnection | undefined,
  timeout: number,
): Promise<void> {
  // Authentication failures preserve the SDK connection. Always release it ourselves.
  await timed(
    Promise.allSettled([
      Promise.resolve().then(() => connection?.readable.cancel()),
      Promise.resolve().then(() => connection?.writable.close()),
      Promise.resolve().then(() => device.raw.close()),
    ]),
    timeout,
    "USB did not finish disconnecting in time.",
  );
}

function connectionError(error: unknown, phase: string): Error {
  if (error instanceof TimeoutError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "SecurityError" || name === "NotAllowedError") {
    return new Error(
      'The browser denied USB access. Open the site directly over HTTPS or localhost, click "Connect", and allow access to the device.',
      { cause: error },
    );
  }
  if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError || name === "NetworkError" || name === "InvalidStateError") {
    return new Error(
      `Could not open USB: ${errorMessage(error)}. Close other WebADB tabs and stop local ADB; check the USB cable and ADB driver.`,
      { cause: error },
    );
  }
  return new Error(
    `${phase}: ${errorMessage(error)}. Enable USB debugging, unlock Android, and approve the ADB key; allow the site to store browser data.`,
    { cause: error },
  );
}

/** Dependency injection is only for hardware-free adapter tests. The browser entry uses the SDK above. */
export async function connectWebAdbWith(
  backend: WebAdbBackend,
  timeoutOverrides: Partial<Timeouts> = {},
): Promise<WebAdbConnection> {
  const support = backend.support();
  if (!support.supported) throw new Error(support.reason ?? "WebUSB is unavailable in this browser.");
  const timeouts = { ...TIMEOUTS, ...timeoutOverrides };
  let device: WebAdbDevice | undefined;
  try {
    device = await backend.requestDevice();
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError")
      throw new Error('No USB device selected. Click "Connect" and choose Android.');
    throw connectionError(error, "Could not select a USB device");
  }
  if (!device) throw new Error("No USB device selected. Click \"Connect\" and choose Android with USB debugging enabled.");

  const selected = device;
  const owner = Symbol();
  usbOwners.set(selected.raw, owner);
  let connection: AdbDaemonConnection | undefined;
  let resources: Awaited<ReturnType<WebAdbBackend["authenticate"]>> | undefined;
  let session: WebAdbSession | undefined;
  let closingClient: Promise<void> | undefined;
  let releasingUsb: Promise<void> | undefined;
  async function cleanup(adb?: WebAdbClient): Promise<void> {
    try {
      // A late client still needs teardown after USB has already been released.
      if (adb) {
        closingClient ??= timed(
          Promise.resolve().then(() => adb.close()),
          timeouts.close,
          "ADB did not finish disconnecting in time.",
        );
        await closingClient;
      }
    } finally {
      if (usbOwners.get(selected.raw) === owner) {
        releasingUsb ??= releaseUsb(selected, connection, timeouts.close);
        await releasingUsb;
      }
    }
  }
  let phase = "Could not connect USB";
  try {
    const opening = selected.connect();
    try {
      connection = await timed(opening, timeouts.connect, "USB did not respond in time. Check the cable, USB debugging, and other ADB connections.");
    } catch (error) {
      void opening.then(
        (late) => {
          if (usbOwners.get(selected.raw) === owner) return releaseUsb(selected, late, timeouts.close);
        },
        () => {},
      ).catch(() => {});
      throw error;
    }
    phase = "Could not authorize ADB";
    const authenticating = backend.authenticate(selected, connection);
    try {
      resources = await timed(
        authenticating,
        timeouts.authenticate,
        "ADB authorization timed out. Unlock Android, approve the USB debugging request, and connect again.",
      );
    } catch (error) {
      void authenticating.then(
        (late) => cleanup(late.adb),
        () => cleanup(),
      ).catch(() => {});
      throw error;
    }
    if (!resources.adb.subprocess.shellProtocol) {
      throw new Error("Android does not support ADB shell v2: commands cannot be safely confirmed without exit codes. Update the device firmware.");
    }
    const authenticated = resources;
    session = new WebAdbSession(authenticated.adb, authenticated.packageManager, () => cleanup(authenticated.adb), timeouts);
    await session.ready();
    const connected = session;
    return { transport: connected, serial: resources.adb.serial, close: () => connected.close(), disconnected: connected.disconnected };
  } catch (error) {
    if (session) {
      try {
        await session.close();
      } catch {
        /* preserve the connection error */
      }
    } else {
      try {
        await cleanup(resources?.adb);
      } catch {
        /* preserve the connection error */
      }
    }
    throw connectionError(error, phase);
  }
}

function byteStream(data: Apk): ReadableStream<Uint8Array> {
  const size = data instanceof Uint8Array ? data.byteLength : data.size;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset === size) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, size);
      controller.enqueue(data instanceof Uint8Array
        ? data.subarray(offset, end)
        : new Uint8Array(await data.slice(offset, end).arrayBuffer()));
      offset = end;
    },
  });
}

async function readOutput(stream: ReadableStream<Uint8Array>, budget: { bytes: number }): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > OUTPUT_LIMIT) throw new Error("ADB command output exceeded 16 MiB.");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

class WebAdbSession implements DeviceTransport {
  readonly disconnected: Promise<void>;
  private readonly stopped: Promise<never>;
  private resolveDisconnected!: () => void;
  private rejectStopped!: (error: Error) => void;
  private failure?: Error;
  private closing?: Promise<void>;

  constructor(
    private readonly adb: WebAdbClient,
    private readonly packageManager: Pick<PackageManager, "installStream">,
    private readonly release: () => Promise<void>,
    private readonly timeouts: Timeouts,
  ) {
    this.disconnected = new Promise((resolve) => {
      this.resolveDisconnected = resolve;
    });
    this.stopped = new Promise((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => {});
    void adb.disconnected.then(
      () => this.onDisconnect(new Error("The USB device was disconnected. Connect Android again.")),
      (error: unknown) =>
        this.onDisconnect(new Error(`ADB connection lost: ${errorMessage(error)}. Connect Android again.`, { cause: error })),
    );
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.resolveDisconnected();
    this.rejectStopped(error);
  }

  private onDisconnect(error: Error): void {
    this.stop(error);
    void this.close().catch(() => {});
  }

  private assertActive(): void {
    if (this.failure) throw this.failure;
  }

  async ready(): Promise<void> {
    // Observe an already-settled SDK disconnect before reporting a successful connection.
    await Promise.resolve();
    this.assertActive();
  }

  private async run<T>(label: string, timeout: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive();
    const controller = new AbortController();
    try {
      const result = await timed(
        Promise.race([action(controller.signal), this.stopped]),
        timeout,
        `${label}: the device did not respond within ${timeout / 1000} seconds. Connect Android again.`,
      );
      this.assertActive();
      return result;
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.stop(error);
        void this.close().catch(() => {});
        throw error;
      }
      throw new Error(`${label}: ${errorMessage(error)}`, { cause: error });
    } finally {
      controller.abort(this.failure ?? new Error("ADB operation finished."));
    }
  }

  shell(command: string): Promise<string> {
    return this.run("ADB command", this.timeouts.shell, async (signal) => {
      const protocol = this.adb.subprocess.shellProtocol!;
      // Arrays are joined without re-parsing: preserve the existing shellCommand escaping verbatim.
      const process = await protocol.spawn([command], signal);
      try {
        signal.throwIfAborted();
        const budget = { bytes: 0 };
        // A fast command can close its socket before the stdin-close packet is sent.
        void process.stdin.close().catch(() => {});
        const [stdout, stderr, exitCode] = await Promise.all([
          readOutput(process.stdout, budget),
          readOutput(process.stderr, budget),
          process.exited,
        ]);
        if (!Number.isInteger(exitCode) || exitCode !== 0) {
          const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
          throw new Error(`Android shell exited with code ${exitCode}.${details ? `\n${details}` : ""}`);
        }
        return stdout;
      } finally {
        await process.kill();
      }
    });
  }

  push(data: Uint8Array, path: string): Promise<void> {
    return this.run("File transfer", this.timeouts.push, async (signal) => {
      if (!path || path.includes("\0")) throw new Error("Invalid Android file path.");
      const sync = await this.adb.sync();
      try {
        signal.throwIfAborted();
        await sync.write({ filename: path, file: byteStream(data) });
      } finally {
        await sync.dispose();
      }
    });
  }

  async install(apk: Apk, user?: number): Promise<void> {
    const target = user ?? (await readAndroidUser(this));
    await assertAndroidUser(this, target);
    await this.run("APK installation", this.timeouts.install, async (signal) => {
      signal.throwIfAborted();
      // skipExisting:false emits -r. The SDK requires exact "Success" output.
      // Keep -g mandatory: an OEM denial is a failure, never retry without permission grants.
      const size = apk instanceof Uint8Array ? apk.byteLength : apk.size;
      await this.packageManager.installStream(size, byteStream(apk), {
        skipExisting: false,
        grantRuntimePermissions: true,
        user: target,
      });
    });
    await assertAndroidUser(this, target);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stop(new Error("The WebADB connection was closed. Connect Android again."));
      this.closing = this.release();
    }
    return this.closing;
  }
}
