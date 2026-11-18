# How the Royal Enfield app (`com.royalenfield.reprime` 10.1.25(09), code 194) talks to the bike

Static analysis only (JADX via REA + `dexdump` + `strings`). The APK was never executed and nothing
was captured over the air. Target: `base.apk`, sha256 `df1c6c96422507883db66b77c35109c6fb871f820fb1ef7efdcafee817f26d89`.
Obfuscated names (`bluconnect.*`) are R8 output and do not identify the author of a class.

## Observed

### 1. Pairing / discovery (Tripper pod) — plain BLE GATT, not Classic BT
- `com.royalenfield.bluetooth.BleSearchActivity` -> `DeviceListFragment` -> `PINAuthorizationScreen`
  (six single-digit `EditText`s, i.e. a 6-digit PIN UI). Manifest: `BleSearchActivity`, `DeviceSettingsActivity`.
- `BleSearchActivity.D2()` builds the device list and wires `devicePaired` local broadcasts and OTA metadata
  (`firmwareUrl`, `firmwareMappingUrl`, `firmwareVersion`, ...) (ev_405c2e80...).
- `BleSearchActivity.B2()` runs on a worker thread and calls `new bluconnect.fj1().d(context)` (ev_453e24a4...).
  `fj1` is the raw-GATT client for the bike side.
- **Scan filter**: `fj1.r()` builds `ScanFilter.Builder().setServiceUuid(fj1.g)`, where
  `fj1.g = ParcelUuid("01FF0100-BA5E-F4EE-5CA1-EB1E5E4B1CE0")` (dexdump of `fj1.<init>`, `fj1.r`).
- **Connect**: `fj1.l(address, autoConnect)` -> `BluetoothDevice.connectGatt(ctx, autoConnect, xb8 callback, TRANSPORT_LE=2)`.
  Needs `BLUETOOTH_CONNECT`.
- **GATT constants** in `bluconnect.xb8.<clinit>`: service/profile `01FF0100-BA5E-F4EE-5CA1-EB1E5E4B1CE0`,
  characteristic `01FF0101-BA5E-F4EE-5CA1-EB1E5E4B1CE0`, plus `00002901-...` (Characteristic User Description).
- **Writes**: `fj1.f(byte[])` sets `WRITE_TYPE_NO_RESPONSE` (1) on the cached characteristic and calls `writeCharacteristic`.
  There is also a byte[] queue (`fj1.s`) and a writer thread (`fj1.q`).
- **Framing**: `fj1.k(byte[])` is a bitwise CRC-16 with poly `0x1021` and init `0xFFFF` (CRC-16/CCITT-FALSE family),
  returned as 2 bytes.
- **Auth/command handling**: `fj1.m(byte[] command)` branches on the command byte (`0x20`, `0x01`, ...), emits an
  `Intent("pinAuth")` with extras `auth`, `deviceName`, `deviceAddress`, and logs `BLECONNECTonCommandRecieved0x01`.
  `fj1.g(reply, bleManager)` hands replies to `py7.x(byte[])`.
- Strings that belong to this link: `processReplyFromDisplay: ...` (block/segment/checksum error codes `0x02`..`0x0A`,
  "s/w version received"), `handleTBTDataForTripper`, `handleTBTDataForInfotainment`, `connected_tripper_dash_service`,
  `BLECONNECTSENDPINSHOWMSG`, `pairingKeyRequestUrl`, `pairing key response = `.
- Services declared in the manifest that carry navigation to the pod: `service.NavigationInfoService`,
  `ui.home.navigation.service.REForeGroundService`, `...NotificationService` (notification listener).
  `TripperRouteSettingsActivity` is the only class with "Tripper" in its name.

### 2. Second GATT stack: Aptener "BluConnect" (helmet / MWX1 intercom)
- `com.aptener.bluconnect.*` (protobuf peripheral messages: Battery, Media, Ridegrid, Imu, ClassicIntercom, ...),
  `bluarmor.lib.*`, native `lib/arm64-v8a/libBluConnect-Lib.so`.
- App BLE manager: `bluconnect.dc8` (extends Nordic `BleManager`; only app subclass found, ev_e52e4a32...).
- UUID tables in `bluconnect.bb8`: services `69206f24-308d-11e7-93ae-92361f002671` (chars `...6f25/35/38/40/42/44/46`),
  `4194B3E8-C543-11E7-ABC4-CEC278B6B50A` (char `4194BD34-...`), `9e67df4c-7cc7-11e7-bb31-be2e44b06b34`;
  `bluconnect.vl1`: `74686562-6c75-6172-6d6f-722e636f6d0{0,1,2}` = ASCII "thebluarmor.com" + index.
- Nordic DFU (`com.aptener.bluconnect.DfuService`, `no.nordicsemi.android.dfu`) for firmware updates.

### 3. Other
- Permissions include Bluetooth scan/connect/advertise/privileged, fine/background location, Wi-Fi state + multicast,
  SMS/call log/contacts/phone state (call + message notifications mirrored to the pod).
- Cloud pieces touching the bike: firmware metadata (`FotaTripper*`, `REFotaTripper`), `pairingKeyRequestUrl`.

## Inferred (not proven)
- The Tripper link is `fj1`/`xb8` (service 0x01FF0100, one command/data characteristic 0x01FF0101): it is the only
  scanner filtering on a non-Aptener UUID and it is the one wired to `BleSearchActivity` + PIN screen + `pinAuth`.
- Turn-by-turn payloads are CRC-16 framed byte arrays written with write-without-response (fj1.f + fj1.k); the
  display firmware update (`processReplyFromDisplay`) rides the same channel with block/segment acks.
- The BluConnect stack (`dc8`/`bb8`) is for the helmet intercom, not the bike.
- A PIN is entered by the user and sent to the pod as a command (`fj1.m` / `pinAuth` intent). Whether it is checked
  on the pod or exchanged for a server-issued key (`pairingKeyRequestUrl`) is not yet determined.

## Unknown / next steps
- Exact byte layout of command/TBT frames (header, opcode table, length, where the CRC sits): decompile callers of
  `fj1.f/k/m` and `py7.x`, and the TBT handlers (`handleTBTDataForTripper`).
- Whether notifications are enabled on `01FF0101` (look at `xb8` `onServicesDiscovered`/`onCharacteristicChanged`;
  descriptor `0x2901` is not a CCCD, so `0x2902` use needs checking).
- PIN verification path and the cloud pairing key.
- Whether the "Tripper Dash"/infotainment variant uses another transport (Wi-Fi permissions, classic pairing handlers).
- Ground truth: a BLE sniff (Android HCI snoop log) of a pairing + short navigation session to confirm the above.

---

## Capture 1: first on-device connection to the pod (2026-11-18, re-ride v0 passive client)

Source: the app's SQLite DB pulled from the phone (4 sessions, all against `RE_DISP`, address `00:60:37:xx:xx:xx`).

### Observed
- **Advertisement**: local name `RE_DISP`, service UUID list `[01ff0100-ba5e-f4ee-5ca1-eb1e5e4b1ce0]` (confirms the scan filter
  recovered from the APK), manufacturer-specific data present. Two adverts seen:
  - `e7 6e | 2d a8 29 ac 6d ab ec af | 00 00 00 00 | 1a fb`  (company id 0x6EE7)
  - `ab 82 | 3e bb 3a bf 7e b8 ff bc | 00 00 00 00 | 8b 5a`  (company id 0x82AB)
  (Earlier note claimed a constant-XOR relation between samples. **Retracted**: a third sample (`..22 81 | d2 c4 c2 d4 d3 c8 d5 d8 | 00 00 00 00 | b6 a4`)
  does not fit it. Treat the 14 bytes as opaque, changing per power cycle: 8 varying bytes, 4 zero bytes, 2 trailing bytes.)
- **GATT table (unauthenticated, not bonded)** is tiny:
  - `0x1800` GAP: `2a00` = "RE_DISP" (read), `2a01` appearance = `0000` (read)
  - `0x1801` GATT: `2a05` Service Changed, indicate (we subscribed OK)
  - `01ff0100-…` custom service with **one** characteristic `01ff0101-…`, properties **write-without-response only**
    (no read, no notify/indicate, no descriptors).
- **Link lifetime**: ACL up ~1.1 s then the link dropped, twice (13:25:42.9 to 13:25:44.0, 13:27:04.96 to 13:27:06.0).
  Our last operation (Service Changed subscribe) finished ~0.5 s before the drop. No frames were ever received.
- Sessions 2 and 3 never completed service discovery (no events; #3 never closed).

### Inferred
- The pod appears to drop an idle link after ~1 s: probably an auth/handshake timeout, because the official app writes
  to `01ff0101` (write-no-rsp) right after connecting (`fj1.f`) and a PIN flow exists (`pinAuth`).
- No notify path exists in this pre-auth table, yet the app has a reply handler (`fj1.g`, `py7.x`). Replies may appear only
  after pairing/bonding (the pod exposes Service Changed), or arrive some other way. Unknown.
- OUI `00:60:37` is, from memory, registered to NXP; unverified.

### Unknown / next
- Who closed the link and with what GATT status (not recorded; fixed in the app by logging status events).
- Frame layout of the first command the official app sends to `01ff0101`; find callers of `fj1.f` / the `tng`/`py7` classes.
- Whether bonding (Android `createBond`) changes the GATT table.

---

## Capture 2: the official app's own session (2026-11-18 15:41-15:42)

The HCI snoop log was enabled but not included in the bugreport on this Samsung. The bugreport's logcat is enough, because the
official app logs every GATT write it makes (`GattCallback: onCharacteristicWrite :[...]`) and prints `BLECONNECT*` state
messages. Sanitized timeline: `docs/captures/capture-2-official-app.txt`. NOTE: that raw bugreport contains the user's
account JWTs and personal data (the app prints them); never share or commit it.

### Observed
- **Every write is exactly 20 bytes** to `01ff0101`: 18 payload bytes + CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
  **big-endian** over the first 18 bytes. 66/66 logged frames verify (the bugreport duplicates each line, so 33 real writes).
- **Connect sequence** (times from one session):
  1. `+0.000` connected, `discoverServices`; conn interval 6 (7.5 ms), latency 0, timeout 500 (5 s)
  2. `+0.55`  `onSearchComplete` then **`setCharacteristicNotification(01ff0101, true)` (local only; no CCCD write is logged)**
  3. `+0.004`  first write `21 01 00..00 <crc 50a7>` (app log: `BLECONNECTSENDPINSHOWMSG`), i.e. 4 ms after discovery
  4. `+0.1`    conn interval updated to 24 (30 ms)
  5. ~6 s later the user typed the PIN shown on the pod: write `20 <6 ASCII digits> 00.. <crc>` (pinAuth)
  6. 58 ms later the app logs `onCommandRecieved 0x01` (pod accepted the PIN) and sends `BLECONNECTSENDTIMESHOWMSG`
  7. burst of writes: `50 83 29 ..` (time), `03 ..` (x2), `30 ..` (x2); app logs `onCommandRecieved 0x03` and `0x30` ~200 ms / ~260 ms later
  8. navigation screen: repeating `10 11 3c 00 00 01 40 14 00 00 11 00 33 02 00..` roughly every 1.3 s, with slowly changing bytes
     (`byte6` 0x40 -> 0x41; `bytes 11-12` `00 33` -> `83 38` -> `83 39`)
- Link ended with GATT **status 8 (connection timeout)** at +61 s; it was not an app-initiated disconnect.
- The pod's replies are visible only as the command byte in `BLECONNECTonCommandRecieved` (payloads are not logged).

### Inferred
- **Why re-ride's first capture got nothing and was dropped after ~1.1 s**: the official app writes the hello (`21 01`) within
  milliseconds of discovery and our passive client never wrote. The pod appears to hang up on a link that does not talk.
- **Why we saw no replies**: the pod's table advertises `01ff0101` as write-without-response only (no NOTIFY, no CCCD),
  yet the app calls `setCharacteristicNotification(..., true)` on it. The pod most likely notifies replies unconditionally;
  the client only needs to register locally. re-ride skipped any characteristic without NOTIFY/INDICATE, so it never listened.
- Opcodes (app to pod): `0x21` = show PIN on the pod, `0x20` = send PIN, `0x50` = time/clock, `0x03` and `0x30` = request/response
  pairs seen right after auth (probably device/serial info), `0x10` = navigation/TBT frame. Pod to app: first byte = same
  command id (`0x01` = auth ok). Semantics of `0x50/0x03/0x30` payloads are guesses.

### Unknown / next
- Reply payload bytes (need a client that registers for notifications on `01ff0101`, then logs them).
- Meaning of the `0x10` frame fields (turn icon, distance, street, ETA?). Needs captures with controlled changes.
- Whether `0x21 01` is needed on every connect or only when bonding.


---

## Capture 3 and the real cause of the dropped links (2026-11-18 16:01)

re-ride v1 "Pair & connect": connect, local notify on `01ff0101`, hello `21 01..` written 2 ms later. Pod showed the PIN for an
instant, then **terminated the link itself** (`REMOTE_USER_TERMINATED_CONNECTION`, status 19) 501 ms after the hello.
The Android-side GATT sequence was identical to the official app's (same `isDirect=true`, same interval 6 then 24 updates, same timing).

### Root cause (observed in the official app's code and logs)
The protocol is **symmetric**: both ends host service `01ff0100` with characteristic `01ff0101` (write-without-response), and each side
writes to the other's. The official app, before connecting (`BluetoothGattServer.addService(01ff0100...)` logged at 15:41:13.5, built in `fj1.N()`):
- opens a GATT server (`openGattServer`, callback `zl1`),
- adds primary service `01ff0100` with characteristic `01ff0101`, properties `BROADCAST|WRITE_NO_RESPONSE` (5), permission `WRITE` (0x10),
- receives the pod's replies in `zl1.onCharacteristicWriteRequest(...)` (this is where `BLECONNECTonCommandRecieved` comes from).
The pod, acting as a GATT client, reads the phone's table right after connecting. re-ride hosted nothing, so the pod found no `01ff0100`
and disconnected about half a second later. This also explains why the pod's own table shows no notify path and why capture 1 dropped at ~1.1 s.

### Fix (v2)
re-ride now hosts the same service before `connectGatt` (also in "Listen only", so any spontaneous pod writes are recorded) and logs every
write the pod makes into it as `rx`. Pending verification at the bike.

---

## Capture 4: first successful pairing from re-ride (2026-11-18 16:22) + the official app afterwards

### re-ride session 11 (observed; PIN digits redacted by design)
```
16:22:51.324  connect requested
16:22:51.328  phone-side GATT server hosting 01ff0100 ready (4 ms)
16:22:51.548  pod connects to OUR GATT server (as a GATT client), 7 ms after our discoverServices began
16:22:52.093  TX  21 01 00..00 50a7                 hello  (pod shows PIN, no reply frame)
16:22:59.533  TX  20 <6 ASCII digits> 00.. <crc>     PIN    (7.4 s later, typed by user)
16:22:59.571  RX  20 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 a096   (38 ms later; CRC16 BE ok)
16:23:27.742  phone-initiated disconnect (status 0)   (28 s of silence before that; no keep-alive needed)
```
- **The pod's reply travels as a write into the phone's `01ff0101`** (our GATT server `onCharacteristicWriteRequest`), same 20-byte
  framing and CRC as phone-to-pod frames. Reply = `[opcode echo][result][..zeros..][crc]`; PIN reply `20 01` = success.
  (The official app's log "onCommandRecieved 0x01" is that result byte.)
- Hello gets **no** reply frame. The link needs **no keep-alive**: it stayed up 28 s with zero traffic.
- **BUG found in re-ride v2 UI**: it looks for a reply whose first byte is `01`; the real reply starts `20 01`, so the card keeps saying
  "Waiting for the pod…" even though the pod accepted. Fix: opcode `0x20` + result `0x01` = accepted, other results = rejected.

### Session 12 (reconnect 4 s after session 11)
The ACL link was still up, so `connectGatt` completed instantly and the pod was already a client of our server. Hello sent again; no
reply and no drop for 9 s until the user disconnected.

### Disconnect behaviour (observed)
- **Phone-initiated** (`clientDisconnect` + `close`): GATT status 0. The ACL link lingers about **4 s** after the last GATT user closes,
  then Android drops it with **reason 22 (LOCAL_HOST_TERMINATED)**. Reconnecting inside that window reuses the link (no new handshake).
- **Pod-initiated** (seen once, official app, 16:25:36): ACL reason **19 (REMOTE_USER_TERMINATED)**. After that the pod re-advertised
  immediately (autoConnect attempt connected in ~130 ms).
- **After a phone-initiated drop the pod was NOT connectable for 10+ s** in two official-app attempts (direct connect timed out with
  status 147 after 10 s) but accepted a connect 73 ms after the request on other tries. Inference: pod advertising resumes slowly after the
  phone hangs up. (Link loss out of range gave status 8, capture 2.)

### Official app after re-ride paired (stack-level only: its own debug prints were not in this bugreport)
Six connection attempts in 100 s: 3 timed out (status 147, no ACL), 3 connected for 2.4 s, 10.7 s, 12.9 s and one 20 s before the pod
terminated (reason 19). We cannot see its payloads for this run, so why it disconnected is unknown.

### New decodes (hypotheses, fit the captured bytes)
- **Time frame `50 <h> <m> 00..`**: in capture 2 the app sent `50 83 29` at 15:41:21. `0x29` = 41 (the minute) and `0x83` = `0x80 | 3`
  (3 PM in 12-hour mode, matching the app's `clock_12` setting). Matches 3:41 PM exactly.
- **Navigation frame bytes 11-12** (`00 33`, then `83 38`, then `83 39`): same `0x80|hour12, minute` shape, rising 1 min per ~20 s: likely ETA.
- **Pod advertisement**: the 16-byte manufacturer blob = 2 random id bytes + 8 random bytes + 4 zero bytes + **CRC-16/CCITT-FALSE** of the
  preceding 14 bytes (matches 4 of 4 samples). It changes every power cycle; not a stable identifier.

### Next experiments (not done)
1. Fix the accepted-detection bug above.
2. After PIN success also send the official app's next frames: time sync `50 <h> <m>`, then `03` and `30` (likely info/version queries) and log the
   replies. All three were sent by the official app right after pairing and are low risk.
3. Navigation frames (`10 ..`) only after we can decode more of their fields from controlled captures.


### re-ride v3 (built 2026-11-18, pending test at the bike)
- Fixed the accepted-detection bug (reply is `20 01`, not `01..`); a reply `20 <other>` now shows as "rejected".
- After acceptance re-ride sends the official app's follow-up frames in the official order: time `50 <PM flag|hour12> <minute>`, query `03`,
  wait for its reply, query `30`, wait for its reply (3 s timeouts), logging everything. Allow-list extended to 0x50/0x03/0x30.
- Open question the test answers: the time byte's `0x80` bit is only proven for PM (sample 15:41 -> `0x83`). If the pod clock shows the
  wrong AM/PM, the flag means "12-hour mode" instead and the encoder must set it for AM too.
