/**
 * Forward error correction + framing for the modem.
 *
 * Layers (outermost first, as seen by the receiver):
 *   1. FSK bytes on the wire        (handled by the modem/demodulator)
 *   2. Hamming(8,4) SECDED codewords — one nibble per byte; corrects any
 *      single-bit error and detects any double-bit error per codeword.
 *   3. Frame: [LEN_hi][LEN_lo][payload...][CRC16_hi][CRC16_lo], a 16-bit length
 *      (up to 65535 bytes) and a CRC-16-CCITT over [LEN, payload...] for
 *      end-to-end integrity.
 *
 * With FEC enabled the receiver repairs isolated bit-flips from line noise;
 * the CRC is the final backstop that says "this message is (un)trustworthy".
 * With FEC disabled the frame is sent raw — the CRC still detects corruption
 * but nothing can be repaired, which is exactly what makes the toggle a useful
 * demonstration.
 *
 * The decoder also accepts the demodulator's per-wire-byte UART framing verdict
 * (see `framing` in decodeFrame). That is independent evidence of damage: it
 * marks bytes the *receiver itself* knows are suspect, which is the only damage
 * signal available at all when FEC is switched off.
 */

// ---- CRC-16-CCITT (poly 0x1021, init 0xFFFF) -------------------------------

function crc16(bytes) {
    let crc = 0xFFFF;
    for (const b of bytes) {
        crc ^= (b & 0xFF) << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

// ---- Hamming(8,4) SECDED ----------------------------------------------------
//
// Codeword bits c1..c7 (1-indexed) packed into byte bits 0..6, overall parity
// in bit 7:
//   c1=p1 c2=p2 c3=d0 c4=p3 c5=d1 c6=d2 c7=d3   c8=overall parity

/** Encode a 4-bit nibble into an 8-bit SECDED codeword. */
function hammingEncode(nibble) {
    const d0 = (nibble >> 0) & 1;
    const d1 = (nibble >> 1) & 1;
    const d2 = (nibble >> 2) & 1;
    const d3 = (nibble >> 3) & 1;

    const p1 = d0 ^ d1 ^ d3;
    const p2 = d0 ^ d2 ^ d3;
    const p3 = d1 ^ d2 ^ d3;

    const c = [p1, p2, d0, p3, d1, d2, d3];           // c1..c7
    const overall = c.reduce((a, b) => a ^ b, 0);     // c8

    let byte = 0;
    for (let i = 0; i < 7; i++) byte |= c[i] << i;
    byte |= overall << 7;
    return byte;
}

// Precompute the 16 codewords for clarity/speed.
const HAMMING_TABLE = Array.from({ length: 16 }, (_, n) => hammingEncode(n));

/**
 * Decode an 8-bit SECDED codeword.
 * Returns { nibble, status } where status is:
 *   'ok'        — no error
 *   'corrected' — a single-bit error was repaired
 *   'error'     — a double-bit error was detected (uncorrectable)
 */
function hammingDecode(byte) {
    const c = [];
    for (let i = 0; i < 8; i++) c[i] = (byte >> i) & 1; // c[0]=c1 .. c[7]=c8

    const s1 = c[0] ^ c[2] ^ c[4] ^ c[6];   // positions 1,3,5,7
    const s2 = c[1] ^ c[2] ^ c[5] ^ c[6];   // positions 2,3,6,7
    const s3 = c[3] ^ c[4] ^ c[5] ^ c[6];   // positions 4,5,6,7
    const syndrome = s1 | (s2 << 1) | (s3 << 2);
    const overall = c.reduce((a, b) => a ^ b, 0);

    let status = 'ok';
    if (overall === 1) {
        // Odd parity => exactly one bit flipped (correctable).
        if (syndrome >= 1 && syndrome <= 7) c[syndrome - 1] ^= 1;
        // syndrome 0 => the overall-parity bit itself flipped; data is fine.
        status = 'corrected';
    } else if (syndrome !== 0) {
        // Even parity but non-zero syndrome => two bits flipped (detectable only).
        status = 'error';
    }

    const nibble = (c[2] << 0) | (c[4] << 1) | (c[5] << 2) | (c[6] << 3);
    return { nibble, status };
}

// ---- Framing ----------------------------------------------------------------

/**
 * Build the on-the-wire byte stream for a payload.
 *
 * Every element must already be a byte (0..255) — callers hand us the output of
 * a UTF-8 encoder, not raw code units. We validate rather than mask: silently
 * truncating an out-of-range value would corrupt the message *before* the CRC
 * is computed over it, so the CRC would then certify the corruption as healthy.
 *
 * @param {Uint8Array|number[]} payload  bytes to send (length <= 65535)
 * @param {{fec?: boolean}} opts
 * @returns {Uint8Array}
 */
function encodeFrame(payload, { fec = true } = {}) {
    const bytes = Array.from(payload);
    if (bytes.length > 0xFFFF) throw new Error('payload too long (max 65535 bytes)');
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (!Number.isInteger(b) || b < 0 || b > 255) {
            throw new RangeError(`payload[${i}] = ${b} is not a byte (0..255)`);
        }
    }

    const frame = [(bytes.length >> 8) & 0xFF, bytes.length & 0xFF, ...bytes];
    const crc = crc16(frame);
    frame.push((crc >> 8) & 0xFF, crc & 0xFF);

    if (!fec) return Uint8Array.from(frame);

    const out = [];
    for (const byte of frame) {
        out.push(HAMMING_TABLE[(byte >> 4) & 0xF]);  // high nibble
        out.push(HAMMING_TABLE[byte & 0xF]);         // low nibble
    }
    return Uint8Array.from(out);
}

/** Worst of two per-byte health verdicts ('ok' < 'corrected' < 'error'). */
function worstStatus(a, b) {
    if (a === 'error' || b === 'error') return 'error';
    if (a === 'corrected' || b === 'corrected') return 'corrected';
    return 'ok';
}

/**
 * Decode an on-the-wire byte stream back into a payload.
 *
 * A garbled LEN field must never black out the whole message: LEN is clamped to
 * what actually arrived, so the receiver still shows every byte it managed to
 * recover (with crcOk false and `truncated` set). Reporting nothing at all is
 * the least informative possible response to a damaged line.
 *
 * @param {Uint8Array|number[]} wire  demodulated bytes (may contain bit errors)
 * @param {{fec?: boolean, framing?: boolean[]}} opts
 *   framing[i] — the demodulator's UART framing verdict for wire byte i
 *   (false = start/stop bits were wrong, so this byte is untrustworthy).
 * @returns {{
 *   payload: Uint8Array, crcOk: boolean, truncated: boolean,
 *   corrected: number, uncorrectable: number, framingErrors: number,
 *   byteStatuses: string[]   // per payload byte: 'ok'|'corrected'|'error'
 * }}
 */
function decodeFrame(wire, { fec = true, framing = null } = {}) {
    const wireBytes = Array.from(wire);
    const frameBytes = [];
    const hammingStatuses = [];   // per frame byte: worst of its codewords
    const framingOk = [];         // per frame byte
    const nCorrected = [];        // per frame byte: codewords repaired in it
    const nUncorrectable = [];    // per frame byte: codewords beyond repair

    // A wire byte with no framing verdict is treated as trustworthy.
    const framedOk = (i) => !framing || framing[i] !== false;

    if (fec) {
        // Two codewords (high nibble, low nibble) per frame byte.
        for (let i = 0; i + 1 < wireBytes.length; i += 2) {
            const hi = hammingDecode(wireBytes[i]);
            const lo = hammingDecode(wireBytes[i + 1]);
            frameBytes.push(((hi.nibble << 4) | lo.nibble) & 0xFF);
            // A byte is only as healthy as its worst nibble, but the damage
            // tallies stay at codeword resolution — that's the interesting number.
            hammingStatuses.push(worstStatus(hi.status, lo.status));
            nCorrected.push([hi.status, lo.status].filter((s) => s === 'corrected').length);
            nUncorrectable.push([hi.status, lo.status].filter((s) => s === 'error').length);
            framingOk.push(framedOk(i) && framedOk(i + 1));
        }
    } else {
        for (let i = 0; i < wireBytes.length; i++) {
            frameBytes.push(wireBytes[i] & 0xFF);
            hammingStatuses.push('ok');
            nCorrected.push(0);
            nUncorrectable.push(0);
            framingOk.push(framedOk(i));
        }
    }

    const result = {
        payload: new Uint8Array(0), crcOk: false, truncated: false,
        corrected: 0, uncorrectable: 0, framingErrors: 0, byteStatuses: []
    };
    if (frameBytes.length < 4) return result;

    // Trust LEN only as far as the bytes we actually received.
    const declaredLen = (frameBytes[0] << 8) | frameBytes[1];
    const len = Math.min(declaredLen, frameBytes.length - 4);
    const truncated = len !== declaredLen;
    const frameLen = len + 4;

    // Damage counts describe the frame we decoded, not any trailing junk that
    // the demodulator read past the end of it.
    for (let i = 0; i < frameLen; i++) {
        result.corrected += nCorrected[i];
        result.uncorrectable += nUncorrectable[i];
        if (!framingOk[i]) result.framingErrors++;
    }

    const crcRx = (frameBytes[2 + len] << 8) | frameBytes[3 + len];
    const crcCalc = crc16(frameBytes.slice(0, 2 + len));

    result.payload = Uint8Array.from(frameBytes.slice(2, 2 + len));
    result.truncated = truncated;
    // A clamped frame's last two bytes aren't really the CRC, so it can't pass.
    result.crcOk = !truncated && crcRx === crcCalc;
    result.byteStatuses = hammingStatuses.slice(2, 2 + len).map(
        (s, j) => framingOk[2 + j] ? s : 'error');
    return result;
}

const FEC = { crc16, hammingEncode, hammingDecode, encodeFrame, decodeFrame, worstStatus };

if (typeof window !== 'undefined') window.FEC = FEC;
if (typeof module !== 'undefined' && module.exports) module.exports = FEC;
