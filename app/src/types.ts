export type Device = {
  address: string;
  name: string | null;
  rssi: number | null;
  tx_power: number | null;
  services: string[];
  manufacturer_data: [number, string][];
  service_data: [string, string][];
  is_target: boolean;
  first_seen: number;
  last_seen: number;
};

export type Gatt = {
  service_uuid: string;
  char_uuid: string;
  properties: string[];
  descriptors: string[];
};

export type Frame = {
  id: number;
  session_id: number;
  ts_ms: number;
  kind: "read" | "notify" | "write" | "info" | "error" | string;
  service_uuid: string | null;
  char_uuid: string | null;
  hex: string;
  note: string | null;
};

export type Session = {
  id: number;
  address: string;
  name: string | null;
  started_at: number;
  ended_at: number | null;
  event_count: number;
};

export type LinkState = "idle" | "scanning" | "connecting" | "connected" | "disconnected" | "error";

/** Messages pushed by the Kotlin BlePlugin over the event channel. */
export type BleMsg =
  | { type: "status"; state: LinkState; message: string }
  | {
      type: "device";
      address: string;
      name: string | null;
      rssi: number | null;
      txPower?: number;
      services: string[];
      manufacturerData: [number, string][];
      serviceData: [string, string][];
    }
  | { type: "gatt"; rows: { serviceUuid: string; charUuid: string; properties: string[]; descriptors: string[] }[] }
  | { type: "frame"; kind: string; service: string | null; char: string | null; hex: string; note: string | null };
