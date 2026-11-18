# re-ride

Android app (Tauri 2 + Rust + React/TypeScript, Kotlin for the BLE radio) that connects to a Royal Enfield
Tripper pod and records everything it learns. Reverse-engineering notes: `docs/bike-connection-analysis.md`.

## Architecture
- **Kotlin** (`app/src-tauri/gen/android/.../BlePlugin.kt`): scan, connect, GATT, runtime permissions, share sheet.
  Passive by default. "Pair & connect" mode (bike only) sends exactly two frames, hello (0x21) and PIN (0x20), enforced by a hard allow-list + CRC check in Kotlin; nothing else can be written.
- **Rust** (`app/src-tauri/src`): SQLite storage (`db.rs`), frame analysis incl. CRC-16 hints (`frames.rs`), bridge commands (`lib.rs`).
- **React** (`app/src`): Material 3 UI (Nearby / Live / History), event pipeline in `useBike.ts`.

## Build / run (Android 12+, arm64)
    cd app && pnpm install
    pnpm tauri android build --debug --apk --target aarch64
    adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
    # or live: pnpm tauri android dev

Data lives in the app's private storage; History -> open a session -> share icon exports JSON.

## Notes
- The pod probably talks to one phone at a time: close the official app first.
- PIN/auth is not implemented, so an unauthenticated link may expose little. Read errors are logged (status 5/15 = needs pairing).
- Capture only runs while the app is in the foreground (no foreground service yet).

## Pairing mode
Reproduces the official app's handshake (`docs/captures/capture-2-official-app.txt`, `docs/bike-connection-analysis.md`).
The protocol is symmetric: the phone hosts service `01ff0100`/char `01ff0101` (BROADCAST|WRITE_NO_RESPONSE) so the pod can write its
replies to us, and writes to the pod's identical characteristic. Every frame is 20 bytes: opcode, payload, CRC-16/CCITT-FALSE (BE).

1. Host the phone-side service, connect, register for notifications locally on the pod's `01ff0101` (no CCCD).
2. TX hello `21 01` -> pod shows a 6-digit PIN (no reply frame).
3. TX `20 <PIN digits>` -> RX `20 01` = accepted (anything else = rejected). PIN digits are never stored.
4. After acceptance, like the official app: TX time `50 <PM|hour12> <minute>`, TX query `03` (wait for reply), TX query `30` (wait for reply).
   Replies are logged; their meaning is still unknown.

Writes are limited by a hard allow-list (opcodes 0x21, 0x20, 0x50, 0x03, 0x30, valid CRC, pairing mode only) in Kotlin. No navigation or
firmware frames can be sent. Frame builders are unit-tested against the official app's real frames (`cargo test`).
