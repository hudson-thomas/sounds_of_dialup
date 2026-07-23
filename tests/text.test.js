/**
 * Text-codec tests: the payload must survive the wire byte-for-byte.
 *
 * Regression guard for the class of bug where the transmitter corrupts the
 * message *before* the CRC is computed over it — so the receiver shows garbage
 * while the integrity check happily reports "CRC OK". Any such failure is worse
 * than a detected one, because nothing in the UI contradicts it.  node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Bell202Modem = require('../static/bell202.js');
const FEC = require('../static/fec.js');

const encode = (text) => Array.from(new TextEncoder().encode(text));
const decode = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));

/** Full clean-line round trip with blind receiver sync. */
function roundTrip(text, { fec = true } = {}) {
    const modem = new Bell202Modem();
    const wire = FEC.encodeFrame(encode(text), { fec });
    const buffer = modem.generateTransmissionFromBytes(wire);

    const start = modem.demodulator.findDataStart(buffer, 0);
    assert.ok(start >= 0, 'receiver should sync on a clean line');
    const { frames } = modem.demodulator.demodulate(buffer, start);
    const decoded = FEC.decodeFrame(frames.map((f) => f.value), {
        fec, framing: frames.map((f) => f.framingOk)
    });
    return { text: decode(decoded.payload), decoded };
}

const SAMPLES = [
    ['ASCII', 'Hello, World! 1990'],
    ['Latin-1 accents', 'café naïve résumé'],
    ['punctuation above U+00FF', 'em—dash “quotes” … 200% ≈ π'],
    ['CJK', '日本語のテキスト'],
    ['BMP symbols', '☕ ♦ ✓ №'],
    ['astral plane (surrogate pairs)', '👋 🚀 🎉'],
    ['ZWJ emoji sequence', '👋🏽 👨‍👩‍👧‍👦'],
    ['mixed', 'Ünïcödé ☎ 1200 baud 👍'],
];

for (const [label, text] of SAMPLES) {
    test(`text survives the wire intact: ${label}`, () => {
        for (const fec of [true, false]) {
            const r = roundTrip(text, { fec });
            assert.equal(r.text, text, `fec=${fec}: text was altered in transit`);
            assert.ok(r.decoded.crcOk, `fec=${fec}: CRC should pass on a clean line`);
        }
    });
}

test('a passing CRC is never reported for altered text (clean line)', () => {
    // The specific historical failure: '☕' became '' with crcOk true.
    for (const [, text] of SAMPLES) {
        const r = roundTrip(text);
        if (r.decoded.crcOk) {
            assert.equal(r.text, text,
                `CRC certified corrupted text for ${JSON.stringify(text)}`);
        }
    }
});

test('multi-byte characters reach the display as whole characters', () => {
    // The reveal path maps payload bytes back to characters; a 4-byte emoji must
    // surface once, not as four mangled fragments.
    const modem = new Bell202Modem();
    const text = 'a👋b';
    const wire = FEC.encodeFrame(encode(text), { fec: true });
    const buffer = modem.generateTransmissionFromBytes(wire);
    const start = modem.demodulator.findDataStart(buffer, 0);
    const { frames } = modem.demodulator.demodulate(buffer, start);
    const decoded = FEC.decodeFrame(frames.map((f) => f.value), { fec: true });

    assert.equal(decoded.payload.length, 6, 'a + 4-byte emoji + b');
    assert.equal(decode(decoded.payload), text);
    assert.equal(Array.from(decode(decoded.payload)).length, 3, 'three visible characters');
});

test('encodeFrame refuses non-byte payload values instead of truncating', () => {
    // Truncation here is what let corruption slip under the CRC in the first place.
    assert.throws(() => FEC.encodeFrame([65, 9749], { fec: true }), RangeError);
    assert.throws(() => FEC.encodeFrame([-1], { fec: true }), RangeError);
    assert.throws(() => FEC.encodeFrame([256], { fec: true }), RangeError);
    assert.throws(() => FEC.encodeFrame([1.5], { fec: true }), RangeError);
    assert.doesNotThrow(() => FEC.encodeFrame([0, 128, 255], { fec: true }));
});

test('generateTransmission encodes text as UTF-8', () => {
    const modem = new Bell202Modem();
    const bitLen = Math.round(modem.sampleRate / modem.BAUD_RATE);
    const overhead =
        modem.CHANNEL_SEIZURE_BITS * bitLen +
        Math.round(modem.MARK_PREAMBLE_DURATION * modem.sampleRate) +
        Math.round(modem.TRAILING_MARK_DURATION * modem.sampleRate);

    // 'é' is two UTF-8 bytes, so it must occupy two byte-slots on the wire.
    const len = modem.generateTransmission('é').length;
    assert.equal(len, overhead + 2 * 10 * bitLen);
});
