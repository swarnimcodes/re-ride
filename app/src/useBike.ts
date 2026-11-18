import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { BleMsg, Device, Frame, Gatt, LinkState, Session } from "./types";

const MAX_FRAMES = 2000;

/**
 * Pairing-mode progress. The pod answers a PIN with a frame `20 <result>`: result 0x01 = accepted (observed on a real pod),
 * anything else is treated as a rejection.
 */
export type Pairing = "off" | "hello" | "pin_sent" | "accepted" | "rejected" | "failed";

const spaced = (hex: string) => hex.replace(/(..)/g, "$1 ").trim();

/**
 * Owns the whole pipeline: Kotlin BLE events -> Rust (store + analyse) -> React state.
 * Events are handled strictly in order through a promise chain so a frame can never be
 * persisted before the session or GATT table it belongs to.
 */
export function useBike() {
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [link, setLink] = useState<{ state: LinkState; message: string }>({ state: "idle", message: "Ready" });
  const [target, setTarget] = useState<{ address: string; name: string | null } | null>(null);
  const [gatt, setGatt] = useState<Gatt[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing>("off");
  const [lastReply, setLastReply] = useState<string | null>(null);

  const [sync, setSync] = useState<string[]>([]);
  const [rejectedWith, setRejectedWith] = useState<string | null>(null);
  const waiter = useRef<{ op: number; resolve: (hex: string | null) => void } | null>(null);

  const pairingRef = useRef<Pairing>("off");
  const setPair = (p: Pairing) => {
    pairingRef.current = p;
    setPairing(p);
  };

  const sessionId = useRef<number | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const started = useRef(false);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await invoke<Session[]>("list_sessions"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const addSync = (line: string) => setSync((l) => [...l, line]);

  const sendFrame = async (hex: string) => {
    await invoke("ble_call", { cmd: "write", args: { hex } });
  };

  /** Resolves with the pod's reply frame for `op`, or null after `ms`. */
  const waitReply = (op: number, ms: number) =>
    new Promise<string | null>((resolve) => {
      waiter.current = { op, resolve };
      setTimeout(() => {
        if (waiter.current?.op === op) {
          waiter.current = null;
          resolve(null);
        }
      }, ms);
    });

  /**
   * The official app's post-pairing sequence (capture 2): time sync, query 0x03, (reply) query 0x30, (reply).
   * Fire-and-forget on purpose: the replies are delivered through the same ordered event chain this runs beside.
   */
  async function runSync() {
    setSync([]);
    try {
      const now = new Date();
      const hh = now.getHours();
      const mm = now.getMinutes();
      addSync(`Sending time ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
      await sendFrame(await invoke<string>("frame_time", { hour: hh, minute: mm }));
      addSync("Sending query 03");
      const wait3 = waitReply(0x03, 3000);
      await sendFrame(await invoke<string>("frame_query", { opcode: 0x03 }));
      const r3 = await wait3;
      addSync(r3 ? `Reply to 03: ${spaced(r3.slice(0, 12))}…` : "No reply to 03 within 3 s, continuing");
      addSync("Sending query 30");
      const wait30 = waitReply(0x30, 3000);
      await sendFrame(await invoke<string>("frame_query", { opcode: 0x30 }));
      const r30 = await wait30;
      addSync(r30 ? `Reply to 30: ${spaced(r30.slice(0, 12))}…` : "No reply to 30 within 3 s");
      addSync("Done. Every frame is in the log below.");
    } catch (e) {
      addSync(`Stopped: ${typeof e === "string" ? e : String((e as Error)?.message ?? e)}`);
    }
  }

  const handle = useCallback(
    async (m: BleMsg) => {
      switch (m.type) {
        case "device": {
          const row = await invoke<Device>("record_device", { device: m });
          setDevices((d) => ({ ...d, [row.address]: row }));
          break;
        }
        case "status": {
          setLink({ state: m.state, message: m.message });
          // Keep link status (incl. the GATT disconnect status code) in the session log.
          if (sessionId.current != null && m.state !== "scanning" && m.state !== "idle") {
            const f = await invoke<Frame>("record_event", {
              sessionId: sessionId.current,
              kind: "info",
              serviceUuid: null,
              charUuid: null,
              hex: "",
              note: `${m.state}: ${m.message}`,
            });
            setFrames((fs) => [...fs.slice(-MAX_FRAMES + 1), f]);
          }
          if ((m.state === "disconnected" || m.state === "error") && sessionId.current != null) {
            if (pairingRef.current === "hello" || pairingRef.current === "pin_sent") setPair("failed");
            const id = sessionId.current;
            sessionId.current = null;
            await invoke("session_end", { sessionId: id });
            await refreshSessions();
          }
          break;
        }
        case "gatt": {
          const rows: Gatt[] = m.rows.map((r) => ({
            service_uuid: r.serviceUuid,
            char_uuid: r.charUuid,
            properties: r.properties,
            descriptors: r.descriptors,
          }));
          setGatt(rows);
          if (sessionId.current != null) await invoke("save_gatt", { sessionId: sessionId.current, rows });
          break;
        }
        case "frame": {
          if (sessionId.current == null) break;
          const f = await invoke<Frame>("record_event", {
            sessionId: sessionId.current,
            kind: m.kind,
            serviceUuid: m.service,
            charUuid: m.char,
            hex: m.hex,
            note: m.note,
          });
          setFrames((fs) => (fs.length >= MAX_FRAMES ? [...fs.slice(-MAX_FRAMES + 1), f] : [...fs, f]));
          if (m.kind === "notify") {
            setLastReply(m.hex);
            const op = parseInt(m.hex.slice(0, 2), 16);
            const result = m.hex.slice(2, 4);
            if (pairingRef.current === "pin_sent" && op === 0x20) {
              if (result === "01") {
                setPair("accepted");
                void runSync(); // the official app does this right after the PIN is accepted
              } else {
                setRejectedWith(result);
                setPair("rejected");
              }
            }
            const w = waiter.current;
            if (w && w.op === op) {
              waiter.current = null;
              w.resolve(m.hex);
            }
          }
          break;
        }
      }
    },
    [refreshSessions],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const known = await invoke<Device[]>("list_devices");
        setDevices(Object.fromEntries(known.map((d) => [d.address, d])));
        await refreshSessions();
        const ch = new Channel<BleMsg>();
        ch.onmessage = (m) => {
          chain.current = chain.current.then(() => handle(m)).catch((e) => setError(String(e)));
        };
        await invoke("ble_start", { onEvent: ch });
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [handle, refreshSessions]);

  const call = useCallback(async (cmd: string, args?: object) => {
    try {
      setError(null);
      return await invoke("ble_call", { cmd, args });
    } catch (e) {
      setError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
    }
  }, []);

  const scan = useCallback(() => call("scanStart"), [call]);
  const stopScan = useCallback(() => call("scanStop"), [call]);
  const disconnect = useCallback(() => call("disconnect"), [call]);

  /** pairing=true runs the official app's minimal handshake (hello, then PIN); false is passive listen/read only. */
  const connect = useCallback(
    async (d: Device, pairing = false) => {
      setFrames([]);
      setGatt([]);
      setLastReply(null);
      setSync([]);
      setRejectedWith(null);
      waiter.current = null;
      setPair(pairing ? "hello" : "off");
      setTarget({ address: d.address, name: d.name });
      try {
        sessionId.current = await invoke<number>("session_begin", { address: d.address, name: d.name });
      } catch (e) {
        setError(String(e));
        return;
      }
      const helloHex = pairing ? await invoke<string>("frame_hello") : undefined;
      await call("connect", { address: d.address, helloHex, serveBike: d.is_target });
    },
    [call],
  );

  /** Send the PIN the pod is displaying. The digits are never stored (Rust redacts the logged frame). */
  const sendPin = useCallback(
    async (pin: string) => {
      try {
        const hex = await invoke<string>("frame_pin", { pin });
        await invoke("ble_call", { cmd: "write", args: { hex } });
        setPair("pin_sent");
      } catch (e) {
        setError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
      }
    },
    [],
  );

  const loadSession = useCallback(async (s: Session) => {
    const [fr, g] = await Promise.all([
      invoke<Frame[]>("session_events", { sessionId: s.id, limit: 20000 }),
      invoke<Gatt[]>("session_gatt", { sessionId: s.id }),
    ]);
    return { frames: fr, gatt: g };
  }, []);

  const share = useCallback(
    async (s: Session) => {
      try {
        const path = await invoke<string>("export_session", { sessionId: s.id });
        await call("share", { path });
      } catch (e) {
        setError(String(e));
      }
    },
    [call],
  );

  return {
    devices,
    link,
    target,
    gatt,
    pairing,
    lastReply,
    sync,
    rejectedWith,
    sendPin,
    frames,
    sessions,
    error,
    clearError: () => setError(null),
    scan,
    stopScan,
    connect,
    disconnect,
    refreshSessions,
    loadSession,
    share,
  };
}
