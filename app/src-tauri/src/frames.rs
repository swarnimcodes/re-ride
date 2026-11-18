//! Pure frame helpers (no I/O) so they are unit-testable off-device.

/// Service UUID the official app's scanner filters on (`bluconnect.fj1.g` in the decompiled APK).
pub const TARGET_SERVICE: &str = "01ff0100-ba5e-f4ee-5ca1-eb1e5e4b1ce0";

pub fn is_target_service(uuid: &str) -> bool {
    uuid.eq_ignore_ascii_case(TARGET_SERVICE)
}

pub fn from_hex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (0..s.len() / 2)
        .filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok())
        .collect()
}

pub fn ascii_hint(v: &[u8]) -> Option<String> {
    if !v.is_empty() && v.iter().all(|b| (0x20..0x7f).contains(b)) {
        Some(format!("ascii: {}", String::from_utf8_lossy(v)))
    } else {
        None
    }
}

/// CRC-16 as used by the official app's framing helper (poly 0x1021, init 0xFFFF; `bluconnect.fj1.k`).
pub fn crc16_ccitt_false(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

pub const FRAME_LEN: usize = 20;
/// Opcodes re-ride is allowed to send to the pod. Every one was sent by the official app right after pairing
/// (docs/captures/capture-2-official-app.txt). Nothing else, in particular no navigation and no firmware frames.
pub const OP_HELLO: u8 = 0x21; // makes the pod show its PIN
pub const OP_PIN: u8 = 0x20; // PIN auth
pub const OP_TIME: u8 = 0x50; // clock sync
pub const OP_QUERY_A: u8 = 0x03; // unknown query, replayed verbatim
pub const OP_QUERY_B: u8 = 0x30; // unknown query, replayed verbatim

/// Build a 20-byte pod frame: opcode, payload (<= 17 bytes, zero padded), CRC-16 big-endian over the first 18 bytes.
pub fn build_frame(opcode: u8, payload: &[u8]) -> Result<[u8; FRAME_LEN], String> {
    if payload.len() > FRAME_LEN - 3 {
        return Err(format!("payload too long ({} > {})", payload.len(), FRAME_LEN - 3));
    }
    let mut f = [0u8; FRAME_LEN];
    f[0] = opcode;
    f[1..1 + payload.len()].copy_from_slice(payload);
    let crc = crc16_ccitt_false(&f[..FRAME_LEN - 2]);
    f[FRAME_LEN - 2..].copy_from_slice(&crc.to_be_bytes());
    Ok(f)
}

/// First frame the official app sends after discovery; makes the pod display its pairing PIN.
pub fn hello_frame() -> [u8; FRAME_LEN] {
    build_frame(OP_HELLO, &[0x01]).expect("static frame")
}

/// PIN authentication frame: opcode 0x20 + the six ASCII digits shown on the pod.
pub fn pin_frame(pin: &str) -> Result<[u8; FRAME_LEN], String> {
    if pin.len() != 6 || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err("PIN must be exactly 6 digits".into());
    }
    build_frame(OP_PIN, pin.as_bytes())
}

/// Clock sync: `50 <0x80 if PM | hour12> <minute>`. Decoded from the official app's `50 83 29` sent at 15:41 (3 PM, minute 41).
/// The PM-flag reading is a hypothesis; it is only certain for the PM sample.
pub fn time_frame(hour24: u8, minute: u8) -> Result<[u8; FRAME_LEN], String> {
    if hour24 > 23 || minute > 59 {
        return Err("invalid time".into());
    }
    let h12 = match hour24 % 12 {
        0 => 12,
        h => h,
    };
    let flag = if hour24 >= 12 { 0x80 } else { 0x00 };
    build_frame(OP_TIME, &[flag | h12, minute])
}

/// The two parameterless queries the official app sends after pairing.
pub fn query_frame(opcode: u8) -> Result<[u8; FRAME_LEN], String> {
    if opcode != OP_QUERY_A && opcode != OP_QUERY_B {
        return Err("query opcode not allowed".into());
    }
    build_frame(opcode, &[])
}

/// Never store a PIN: blank the digits of an outgoing PIN frame before it is logged.
pub fn redact_pin(bytes: &[u8]) -> Vec<u8> {
    let mut b = bytes.to_vec();
    if b.first() == Some(&OP_PIN) && b.len() >= 8 {
        b[1..7].fill(0);
    }
    b
}

/// Cheap intel on each frame: does the trailing 2 bytes look like that CRC, and is it text?
pub fn analyze(v: &[u8]) -> Option<String> {
    let mut notes: Vec<String> = Vec::new();
    if v.len() >= 3 {
        let (body, tail) = v.split_at(v.len() - 2);
        let be = u16::from_be_bytes([tail[0], tail[1]]);
        let le = u16::from_le_bytes([tail[0], tail[1]]);
        for (skip, label) in [(0usize, "all"), (1, "skip-first")] {
            if body.len() > skip {
                let c = crc16_ccitt_false(&body[skip..]);
                if c == be {
                    notes.push(format!("crc16 BE ok ({label})"));
                }
                if c == le {
                    notes.push(format!("crc16 LE ok ({label})"));
                }
            }
        }
    }
    if let Some(a) = ascii_hint(v) {
        notes.push(a);
    }
    (!notes.is_empty()).then(|| notes.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_ccitt_false_check_value() {
        assert_eq!(crc16_ccitt_false(b"123456789"), 0x29B1);
    }

    #[test]
    fn analyze_detects_trailing_crc_be_and_le() {
        let mut f = vec![0x20, 0x01, 0x02, 0x03];
        let c = crc16_ccitt_false(&f);
        let mut be = f.clone();
        be.extend_from_slice(&c.to_be_bytes());
        assert!(analyze(&be).unwrap().contains("crc16 BE ok (all)"));
        f.extend_from_slice(&c.to_le_bytes());
        assert!(analyze(&f).unwrap().contains("crc16 LE ok (all)"));
    }

    // Vectors taken from the official app's real writes (docs/captures/capture-2-official-app.txt).
    #[test]
    fn frames_match_official_app_captures() {
        assert_eq!(hello_frame().to_vec(), from_hex("21 01 00000000000000000000000000000000 50a7"));
        assert_eq!(build_frame(0x03, &[]).unwrap().to_vec(), from_hex("03 00000000000000000000000000000000 00 45d9"));
        assert_eq!(build_frame(0x30, &[]).unwrap().to_vec(), from_hex("30 00000000000000000000000000000000 00 428b"));
        assert_eq!(build_frame(0x50, &[0x83, 0x29]).unwrap().to_vec(), from_hex("50 83 29 000000000000000000000000000000 7250"));
        assert_eq!(
            build_frame(0x10, &[0x11, 0x3c, 0, 0, 0x01, 0x40, 0x14, 0, 0, 0x11, 0, 0x33, 0x02]).unwrap().to_vec(),
            from_hex("10 11 3c 00 00 01 40 14 00 00 11 00 33 02 00 00 00 00 0e2f")
        );
    }

    #[test]
    fn time_and_query_frames_match_official_app() {
        // 15:41 -> `50 83 29`, crc 7250 (capture 2)
        assert_eq!(time_frame(15, 41).unwrap().to_vec(), from_hex("50 83 29 000000000000000000000000000000 7250"));
        assert_eq!(query_frame(0x03).unwrap().to_vec(), from_hex("03 00000000000000000000000000000000 00 45d9"));
        assert_eq!(query_frame(0x30).unwrap().to_vec(), from_hex("30 00000000000000000000000000000000 00 428b"));
        // 12h conversion edge cases
        assert_eq!(&time_frame(0, 5).unwrap()[..3], &[0x50, 12, 5]); // 12:05 AM
        assert_eq!(&time_frame(12, 0).unwrap()[..3], &[0x50, 0x80 | 12, 0]); // 12:00 PM
        assert_eq!(&time_frame(23, 59).unwrap()[..3], &[0x50, 0x80 | 11, 59]);
        assert!(time_frame(24, 0).is_err());
        assert!(time_frame(10, 60).is_err());
        assert!(query_frame(0x10).is_err());
        assert!(query_frame(0x21).is_err());
    }

    #[test]
    fn pin_frame_shape_and_validation() {
        let f = pin_frame("123456").unwrap();
        assert_eq!(&f[..7], &[0x20, b'1', b'2', b'3', b'4', b'5', b'6']);
        assert_eq!(f.len(), FRAME_LEN);
        assert_eq!(crc16_ccitt_false(&f[..18]).to_be_bytes(), [f[18], f[19]]);
        assert!(pin_frame("12345").is_err());
        assert!(pin_frame("12345a").is_err());
        assert!(pin_frame("1234567").is_err());
    }

    #[test]
    fn pin_is_redacted_before_logging() {
        let r = redact_pin(&pin_frame("987654").unwrap());
        assert_eq!(&r[..8], &[0x20, 0, 0, 0, 0, 0, 0, 0]);
        // other frames are untouched
        assert_eq!(redact_pin(&hello_frame()), hello_frame().to_vec());
    }

    #[test]
    fn hex_roundtrip_and_ascii() {
        assert_eq!(from_hex("48 69"), b"Hi");
        assert_eq!(analyze(b"Hi!").unwrap(), "ascii: Hi!");
        assert!(analyze(&[0x00, 0x01]).is_none());
    }

    #[test]
    fn target_service_is_case_insensitive() {
        assert!(is_target_service("01FF0100-BA5E-F4EE-5CA1-EB1E5E4B1CE0"));
        assert!(!is_target_service("0000180f-0000-1000-8000-00805f9b34fb"));
    }
}
