import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { useBike } from "./useBike";
import type { Device, Frame, Gatt, Session } from "./types";
import { useTheme } from "./theme";
import { Chip, EmptyState, IconBike, IconBle, IconHistory, IconLive, IconScan, IconShare, NavigationBar, Snackbar, ThemeMenu, TopAppBar } from "./ui";

type Tab = "scan" | "live" | "history";

const hhmmss = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false }) + "." + String(ms % 1000).padStart(3, "0");
const spaced = (hex: string) => hex.replace(/(..)/g, "$1 ").trim();
const short = (u: string | null) => (u ? u.slice(0, 8) : "—");
const signal = (rssi: number | null) => (rssi == null ? "Signal unknown" : rssi > -60 ? "Strong signal" : rssi > -80 ? "Fair signal" : "Weak signal");

export default function App() {
  const bike = useBike();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<Tab>("scan");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<{ session: Session; frames: Frame[]; gatt: Gatt[] } | null>(null);

  const scanning = bike.link.state === "scanning";
  const linked = bike.link.state === "connected" || bike.link.state === "connecting";

  // Jump to the Live tab as soon as a connection starts.
  const prevLinked = useRef(false);
  useEffect(() => {
    if (linked && !prevLinked.current) setTab("live");
    prevLinked.current = linked;
  }, [linked]);

  const all = Object.keys(bike.devices).length;
  // Keep the screen on while connected so the capture isn't interrupted.
  useEffect(() => {
    if (!linked) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      lock?.release().catch(() => {});
    };
  }, [linked]);

  const devices = useMemo(
    () => Object.values(bike.devices).filter((d) => showAll || d.is_target || d.name).sort((a, b) => Number(b.is_target) - Number(a.is_target) || (b.rssi ?? -999) - (a.rssi ?? -999)),
    [bike.devices, showAll],
  );
  const visibleSessions = bike.sessions.filter((s) => s.event_count > 0);

  async function openSession(s: Session) {
    setOpen({ session: s, ...(await bike.loadSession(s)) });
  }

  return (
    <div className="app">
      {tab === "scan" && (
        <>
          <TopAppBar title="Nearby" subtitle={scanning ? `Scanning… ${all} seen` : `${all} devices seen`} actions={
              <>
                <Chip tone={scanning ? "primary" : "neutral"}>{bike.link.state}</Chip>
                <ThemeMenu theme={theme} onChange={setTheme} />
              </>
            }
          />
          <main className="with-fab">
            {all > 0 && (
              <div className="filters" role="group" aria-label="Filter devices">
                <button className={`filter ${!showAll ? "on" : ""}`} onClick={() => setShowAll(false)}>Bike &amp; named</button>
                <button className={`filter ${showAll ? "on" : ""}`} onClick={() => setShowAll(true)}>All ({all})</button>
              </div>
            )}
            {devices.length === 0 ? (
              <EmptyState
                icon={<IconBle size={40} />}
                title={all > 0 ? "No named devices yet" : "Find your bike"}
                body="Wake the Tripper, close the official Royal Enfield app, then tap Scan. Your bike will appear at the top."
              />
            ) : (
              <ul className="cards">
                {devices.map((d) => (
                  <DeviceCard key={d.address} d={d} disabled={linked} onConnect={(pair) => bike.connect(d, pair)} />
                ))}
              </ul>
            )}
          </main>
          <button className="fab extended" onClick={scanning ? bike.stopScan : bike.scan} disabled={linked}>
            <IconScan />
            <span>{scanning ? "Stop" : "Scan"}</span>
          </button>
        </>
      )}

      {tab === "live" && (
        <>
          <TopAppBar
            title={bike.target?.name ?? bike.target?.address ?? "Live"}
            subtitle={bike.target ? bike.target.address : "No active connection"}
            actions={linked ? <button className="text-btn danger" onClick={bike.disconnect}>Disconnect</button> : undefined}
          />
          <main>
            {!bike.target ? (
              <EmptyState icon={<IconLive size={40} />} title="Not connected" body="Pick your bike on the Nearby tab to start recording." action={<button className="filled" onClick={() => setTab("scan")}>Go to Nearby</button>} />
            ) : (
              <>
                <section className="card status-card">
                  <Chip tone={bike.link.state === "connected" ? "ok" : bike.link.state === "error" ? "error" : "warn"}>{bike.link.state}</Chip>
                  <span>{bike.link.message}</span>
                </section>
                {bike.pairing !== "off" && (
                  <PairingCard
                    phase={bike.pairing}
                    connected={linked}
                    reply={bike.lastReply}
                    sync={bike.sync}
                    rejectedWith={bike.rejectedWith}
                    onPin={bike.sendPin}
                  />
                )}
                <GattCard gatt={bike.gatt} />
                <TrafficCard frames={bike.frames} live />
              </>
            )}
          </main>
        </>
      )}

      {tab === "history" && !open && (
        <>
          <TopAppBar title="History" subtitle={`${visibleSessions.length} recorded sessions`} actions={<ThemeMenu theme={theme} onChange={setTheme} />} />
          <main>
            {visibleSessions.length === 0 ? (
              <EmptyState icon={<IconHistory size={40} />} title="Nothing recorded yet" body="Every connection is saved on this phone with the GATT table and every frame the bike sends." />
            ) : (
              <ul className="cards">
                {visibleSessions.map((s) => (
                  <li key={s.id} className="card list-item" onClick={() => openSession(s)}>
                    <div className="leading"><IconBike /></div>
                    <div className="body">
                      <h3>{s.name ?? "Unnamed device"}</h3>
                      <p>{new Date(s.started_at).toLocaleString()} · {s.event_count} frames</p>
                      <p className="mono">{s.address}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </>
      )}

      {tab === "history" && open && (
        <>
          <TopAppBar
            title={open.session.name ?? "Session"}
            subtitle={new Date(open.session.started_at).toLocaleString()}
            onBack={() => setOpen(null)}
            actions={
              <button className="icon-btn" aria-label="Share session JSON" onClick={() => bike.share(open.session)}>
                <IconShare />
              </button>
            }
          />
          <main>
            <GattCard gatt={open.gatt} />
            <TrafficCard frames={open.frames} />
          </main>
        </>
      )}

      <NavigationBar
        active={tab}
        onSelect={(id) => {
          setTab(id as Tab);
          if (id === "history") bike.refreshSessions();
          if (id !== "history") setOpen(null);
        }}
        items={[
          { id: "scan", label: "Nearby", icon: <IconScan /> },
          { id: "live", label: "Live", icon: <IconLive /> },
          { id: "history", label: "History", icon: <IconHistory /> },
        ]}
      />
      <Snackbar message={bike.error} onClose={bike.clearError} />
    </div>
  );
}

function DeviceCard({ d, disabled, onConnect }: { d: Device; disabled: boolean; onConnect: (pair: boolean) => void }) {
  return (
    <li className={`card device ${d.is_target ? "bike" : ""}`}>
      <div className="row">
        <div className="leading">{d.is_target ? <IconBike /> : <IconBle />}</div>
        <div className="body">
          <h3>{d.name ?? "Unnamed device"}</h3>
          <p className="mono">{d.address}</p>
          <p>{signal(d.rssi)} · {d.rssi ?? "?"} dBm</p>
        </div>
        {d.is_target && <Chip tone="primary">Bike</Chip>}
      </div>
      {d.manufacturer_data.map(([id, hex]) => (
        <p key={id} className="mono dim">mfr 0x{id.toString(16).padStart(4, "0")}: {spaced(hex)}</p>
      ))}
      {d.service_data.map(([u, hex]) => (
        <p key={u} className="mono dim">svc {short(u)}: {spaced(hex)}</p>
      ))}
      {d.is_target && (
        <p className="hint">
          Pair &amp; connect sends the official app&apos;s pairing frames: hello, PIN, time sync and two queries. Listen only sends nothing.
        </p>
      )}
      <div className="card-actions">
        {d.is_target ? (
          <>
            <button className="text-btn" disabled={disabled} onClick={() => onConnect(false)}>Listen only</button>
            <button className="filled" disabled={disabled} onClick={() => onConnect(true)}>Pair &amp; connect</button>
          </>
        ) : (
          <button className="tonal" disabled={disabled} onClick={() => onConnect(false)}>Connect (read-only)</button>
        )}
      </div>
    </li>
  );
}

function PairingCard(props: {
  phase: "hello" | "pin_sent" | "accepted" | "rejected" | "failed" | string;
  connected: boolean;
  reply: string | null;
  sync: string[];
  rejectedWith: string | null;
  onPin: (pin: string) => void;
}) {
  const [pin, setPin] = useState("");
  const valid = /^\d{6}$/.test(pin);
  if (props.phase === "accepted")
    return (
      <section className="card ok-card">
        <h2>Pod accepted the PIN</h2>
        <p>The pod answered <span className="mono">20 01</span>. Now sending the official app&apos;s follow-up frames (time sync and two queries) and recording every reply.</p>
        {props.sync.map((l, i) => (
          <p key={i} className="mono">{l}</p>
        ))}
      </section>
    );
  if (props.phase === "rejected")
    return (
      <section className="card err-card">
        <h2>Pod rejected the PIN</h2>
        <p>It answered with result <span className="mono">{props.rejectedWith ?? "??"}</span>. Disconnect, wake the pod and pair again; read the PIN carefully, a new one is shown each time.</p>
      </section>
    );
  if (props.phase === "failed")
    return (
      <section className="card err-card">
        <h2>Pairing didn&apos;t complete</h2>
        <p>The link closed before the pod accepted a PIN (wrong PIN, timeout or the pod went to sleep). Wake the pod and go back to Nearby to try again. The log below shows what happened.</p>
      </section>
    );
  if (props.phase === "pin_sent")
    return (
      <section className="card">
        <h2>Waiting for the pod…</h2>
        <p>PIN sent. {props.reply ? `Pod replied: ${props.reply.match(/../g)?.join(" ")}` : "No reply yet."}</p>
      </section>
    );
  return (
    <section className="card">
      <h2>Enter the PIN shown on the pod</h2>
      <p>The hello frame has been sent, so the pod should display a 6-digit PIN. The digits are sent to the pod and never saved.</p>
      <input
        className="pin"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        placeholder="••••••"
        aria-label="6-digit PIN"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      <div className="card-actions">
        <button
          className="filled"
          disabled={!valid || !props.connected}
          onClick={() => {
            props.onPin(pin);
            setPin("");
          }}
        >
          Send PIN
        </button>
      </div>
    </section>
  );
}

function GattCard({ gatt }: { gatt: Gatt[] }) {
  if (gatt.length === 0) return null;
  const bySvc = new Map<string, Gatt[]>();
  gatt.forEach((g) => bySvc.set(g.service_uuid, [...(bySvc.get(g.service_uuid) ?? []), g]));
  return (
    <details className="card" open={gatt.length < 12}>
      <summary>
        <h2>GATT table <span className="dim">({gatt.length} characteristics)</span></h2>
      </summary>
      {[...bySvc.entries()].map(([s, cs]) => (
        <div key={s} className="svc">
          <p className="mono">{s}{s.startsWith("01ff0100") && <Chip tone="primary">bike service</Chip>}</p>
          {cs.map((c) => (
            <p key={c.char_uuid} className="mono char">
              {c.char_uuid} <span className="props">{c.properties.join(" ")}</span>
            </p>
          ))}
        </div>
      ))}
    </details>
  );
}

function TrafficCard({ frames, live }: { frames: Frame[]; live?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: "end" });
  }, [frames.length, live]);
  return (
    <section className="card">
      <h2>Traffic <span className="dim">({frames.length})</span></h2>
      {frames.length === 0 && <p className="dim">Waiting for data…</p>}
      {frames.map((f) => (
        <div key={f.id} className={`frame ${f.kind}`}>
          <div className="meta">
            <span className="kind">{f.kind === "write" ? "tx" : f.kind === "notify" ? "rx" : f.kind}</span>
            <span className="dim">{hhmmss(f.ts_ms)}</span>
            <span className="dim mono">{short(f.char_uuid)}</span>
          </div>
          {f.hex && <p className="mono hex">{spaced(f.hex)}</p>}
          {f.note && <p className="note">{f.note}</p>}
        </div>
      ))}
      <div ref={end} />
    </section>
  );
}
