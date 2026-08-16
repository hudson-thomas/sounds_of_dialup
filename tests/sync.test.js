/**
 * Receiver-autonomy tests.
 *
 * The receiver must recover frame sync from the audio itself rather than being
 * handed the transmitter's segment arithmetic, must never black out a message
 * just because the LEN field got hit, and must surface its own UART framing
 * verdict as damage — the only damage signal that exists when FEC is off.
 *
 * node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Bell202Modem = require('../static/bell202.js');
const FEC = require('../static/fec.js');

const encode = (text) => Array.from(new TextEncoder().encode(text));
const decode = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));

function mulberry(seed) {
    return function () {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const MSG = 'The quick brown fox jumps over 13 lazy dogs.';
const SEEDS = Array.from({ length: 30 }, (_, i) => 100 + i * 7);

/** Modulate, optionally damage, then receive with blind sync. */
function receive(text, { noiseLevel = 0, fec = true, seed = 1, prefixSilence = 0 } = {}) {
    const modem = new Bell202Modem();
    const wire = FEC.encodeFrame(encode(text), { fec });
    let buffer = modem.generateTransmissionFromBytes(wire);

    if (prefixSilence) {
        // Simulate carrier-detect firing early: the receiver is pointed at a
        // spot before the burst and must find the data on its own.
        const pad = new Float32Array(prefixSilence + buffer.length);
        pad.set(buffer, prefixSilence);
        buffer = pad;
    }
    if (noiseLevel) modem.addNoise(buffer, noiseLevel, mulberry(seed));

    const start = modem.demodulator.findDataStart(buffer, 0);
    const { frames } = modem.demodulator.demodulate(
        buffer, start >= 0 ? start : prefixSilence + modem.dataStartSamples());
    const decoded = FEC.decodeFrame(frames.map((f) => f.value), {
        fec, framing: frames.map((f) => f.framingOk)
    });
    return { start, truth: prefixSilence + modem.dataStartSamples(), decoded, text: decode(decoded.payload) };
}

test('receiver finds the data start on its own, to within a quarter bit', () => {
    const modem = new Bell202Modem();
    const tolerance = 0.25 * modem.sampleRate / modem.BAUD_RATE;
    const r = receive(MSG);
    assert.ok(r.start >= 0, 'sync should succeed');
    assert.ok(Math.abs(r.start - r.truth) < tolerance,
        `synced at ${r.start}, true start ${r.truth}`);
});

test('blind sync tolerates an arbitrary offset before the burst', () => {
    const modem = new Bell202Modem();
    const tolerance = 0.25 * modem.sampleRate / modem.BAUD_RATE;
    for (const pad of [0, 1000, 22050]) {
        const r = receive(MSG, { prefixSilence: pad });
        assert.ok(Math.abs(r.start - r.truth) < tolerance,
            `pad ${pad}: synced at ${r.start}, true start ${r.truth}`);
        assert.equal(r.text, MSG);
    }
});

test('blind sync survives crackle inside the mark preamble', () => {
    // An impulse burst in the preamble looks exactly like a start bit; the
    // candidate-scoring pass is what stops the receiver locking onto it.
    const modem = new Bell202Modem();
    const tolerance = 0.5 * modem.sampleRate / modem.BAUD_RATE;
    let synced = 0;
    for (const seed of SEEDS) {
        const r = receive(MSG, { noiseLevel: 1.0, seed });
        if (r.start >= 0 && Math.abs(r.start - r.truth) < tolerance) synced++;
    }
    assert.ok(synced >= SEEDS.length * 0.8,
        `blind sync should hold up on a loud line (${synced}/${SEEDS.length})`);
});

test('blind sync does not regress end-to-end recovery', () => {
    // Self-syncing must cost nothing: FEC still has to clearly beat the raw frame.
    const level = 0.3;
    let fecOk = 0, rawOk = 0;
    for (const seed of SEEDS) {
        if (receive(MSG, { noiseLevel: level, fec: true, seed }).decoded.crcOk) fecOk++;
        if (receive(MSG, { noiseLevel: level, fec: false, seed }).decoded.crcOk) rawOk++;
    }
    assert.ok(fecOk > rawOk, `FEC (${fecOk}) should beat raw (${rawOk})`);
    assert.ok(fecOk >= SEEDS.length * 0.6, `FEC should recover most (${fecOk}/${SEEDS.length})`);
});

test('a damaged LEN field never blanks the whole message', () => {
    // Historically LEN corruption made decodeFrame bail with an empty payload,
    // so the loudest lines produced the emptiest screens.
    let shown = 0, total = 0;
    for (const fec of [true, false]) {
        for (const noiseLevel of [0.6, 1.0]) {
            for (const seed of SEEDS) {
                total++;
                if (receive(MSG, { noiseLevel, fec, seed }).decoded.payload.length > 0) shown++;
            }
        }
    }
    assert.equal(shown, total, 'every message should put something on screen');
});

test('an impossible LEN is clamped and flagged, not obeyed', () => {
    const wire = FEC.encodeFrame(encode('hi'), { fec: false });
    wire[0] = 0xFF;  // claim a 65000-byte payload
    const out = FEC.decodeFrame(wire, { fec: false });
    assert.ok(out.truncated, 'over-long LEN should be reported as truncated');
    assert.equal(out.crcOk, false, 'a clamped frame cannot pass CRC');
    assert.ok(out.payload.length > 0, 'recoverable bytes should still be returned');
    assert.ok(out.payload.length <= wire.length, 'payload cannot exceed what arrived');
});

test('framing verdicts reach the payload byte statuses (FEC off)', () => {
    // With FEC off, framing errors are the receiver's only way to say
    // "I know this byte is wrong" — they must not be silently discarded.
    const clean = receive(MSG, { noiseLevel: 0, fec: false });
    assert.equal(clean.decoded.framingErrors, 0, 'a clean line has no framing errors');
    assert.ok(clean.decoded.byteStatuses.every((s) => s === 'ok'));

    let flagged = 0, framingErrors = 0;
    for (const seed of SEEDS) {
        const r = receive(MSG, { noiseLevel: 0.8, fec: false, seed });
        framingErrors += r.decoded.framingErrors;
        flagged += r.decoded.byteStatuses.filter((s) => s !== 'ok').length;
    }
    assert.ok(framingErrors > 0, 'a loud line should produce framing errors');
    assert.ok(flagged > 0, 'framing errors should mark payload bytes as damaged');
});

test('damage counts describe the frame, not trailing junk', () => {
    // The receiver now reads past the frame into the trailing mark; that junk
    // must not inflate the correction counters on a clean line.
    const r = receive(MSG, { noiseLevel: 0, fec: true });
    assert.ok(r.decoded.crcOk);
    assert.equal(r.decoded.corrected, 0);
    assert.equal(r.decoded.uncorrectable, 0);
    assert.equal(r.decoded.framingErrors, 0);
    assert.equal(r.text, MSG);
});

test('decode stats do not count trailing junk as bit errors', () => {
    const modem = new Bell202Modem();
    const wire = FEC.encodeFrame(encode('ACK'), { fec: true });
    const buffer = modem.generateTransmissionFromBytes(wire);
    const start = modem.demodulator.findDataStart(buffer, 0);
    const { frames } = modem.demodulator.demodulate(buffer, start);
    const rx = frames.map((f) => f.value);
    assert.ok(rx.length > wire.length, 'receiver reads past the frame by design');

    const decoded = FEC.decodeFrame(rx, { fec: true, framing: frames.map((f) => f.framingOk) });
    const stats = modem._buildDecodeStats('ACK', wire, rx, decoded, true, 0);
    assert.equal(stats.bitErrors, 0, 'a clean line has zero bit errors');
    assert.equal(stats.decoded, 'ACK');
});
