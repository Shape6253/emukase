import { connectWebAdb } from "./adb/web-adb";
import { inspectDevice, type DeviceInfo } from "./adb/device-info";

export type DeviceConnection = Awaited<ReturnType<typeof connectWebAdb>>;

/** Shared USB device state for the connect block and the install steps. */
export class DeviceState {
  connection = $state<DeviceConnection | undefined>(undefined);
  info = $state<DeviceInfo | undefined>(undefined);
  pending = $state<"connecting" | "disconnecting" | undefined>(undefined);
  setupRunning = $state(false);
  statusText = $state("");
  errorMessage = $state("");
  connected = $derived(this.connection !== undefined && this.info !== undefined);

  private destroyed = false;
  private inspecting: DeviceConnection | undefined;

  showError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    this.errorMessage =
      error instanceof DOMException && error.name === "NotFoundError"
        ? "No device was selected. Connect your Android device and try again."
        : raw;
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return;
    this.pending = "disconnecting";
    const previous = this.connection;
    this.connection = undefined;
    this.info = undefined;
    this.errorMessage = "";
    this.statusText = "Disconnecting from your device…";
    try {
      await previous.close();
    } catch (error) {
      this.showError(error);
    } finally {
      this.statusText = "";
      this.pending = undefined;
    }
  }

  async connect(): Promise<void> {
    if (this.destroyed || this.pending) return;
    if (this.connection) {
      await this.disconnect();
      return;
    }
    this.pending = "connecting";
    this.errorMessage = "";
    this.statusText = "Choose your device and approve this computer if Android asks.";
    let opened: DeviceConnection | undefined;
    try {
      opened = await connectWebAdb();
      if (this.destroyed) {
        await opened.close();
        return;
      }
      this.inspecting = opened;
      const nextInfo = await inspectDevice(opened.transport, opened.serial);
      if (this.destroyed) return;
      this.connection = opened;
      this.inspecting = undefined;
      this.info = nextInfo;
      this.statusText = "";
      const current = this.connection;
      void current.disconnected.then(() => {
        if (this.connection !== current) return;
        void this.disconnect();
      });
    } catch (error) {
      await opened?.close().catch(() => {});
      if (this.destroyed) return;
      if (this.connection === opened) {
        this.connection = undefined;
        this.info = undefined;
      }
      this.showError(error);
      this.statusText = "Connection could not be established.";
    } finally {
      this.inspecting = undefined;
      this.pending = undefined;
    }
  }

  release(): void {
    this.destroyed = true;
    const current = this.connection ?? this.inspecting;
    this.connection = undefined;
    this.inspecting = undefined;
    this.info = undefined;
    void current?.close().catch(() => {});
  }
}
