/**
 * End-to-end channel tests: the real signal chain
 *
 *   text -> CRC frame -> FEC -> FSK modulate -> + line noise
 *        -> demodulate -> FEC correct -> CRC check -> text
 *
 * This is exactly what Bell202Modem.transmit() runs, minus the AudioContext
 * playback (which can't exist under Node). Noise uses a seeded RNG so every
 * assertion is deterministic.  node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Bell202Modem = require('../static/bell202.js');
const Bell202Demodulator = require('../static/demod.js');
const FEC = require('../static/fec.js');

const modem = new Bell202Modem();
const demod = new Bell202Demodulator({
    sampleRate: modem.sampleRate, markFreq: modem.MARK_FREQ,
    spaceFreq: modem.SPACE_FREQ, baud: modem.BAUD_RATE
});

function mulberry(seed) {
    return function () {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Run one message through the whole chain. */
function channel(text, { noiseLevel = 0, fec = true, seed = 1 } = {}) {
    const payload = Array.from(text, (c) => c.charCodeAt(0));
    const wire = FEC.encodeFrame(payload, { fec });
    const buf = modem.generateTransmissionFromBytes(wire);
    if (noiseLevel) modem.addNoise(buf, noiseLevel, mulberry(seed));
    const { frames } = demod.demodulate(buf, modem.dataStartSamples(), wire.length);
    const decoded = FEC.decodeFrame(frames.map((f) => f.value), { fec });
    return { decoded, text: String.fromCharCode(...decoded.payload) };
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 100 + i * 7);
const MSG = 'The quick brown fox jumps over 13 lazy dogs.';

test('clean line: a long (>255 char) message demodulates exactly', () => {
    const long = MSG.repeat(8);  // ~350 chars, exceeds the old 1-byte length limit
    assert.ok(long.length > 255);
    const r = channel(long, { noiseLevel: 0, fec: true });
    assert.equal(r.text, long);
    assert.ok(r.decoded.crcOk);
});

test('clean line: exact recovery, CRC ok, nothing to correct', () => {
    const r = channel(MSG, { noiseLevel: 0, fec: true });
    assert.equal(r.text, MSG);
    assert.ok(r.decoded.crcOk);
    assert.equal(r.decoded.corrected, 0);
});

test('integrity: a passing CRC never certifies wrong data', () => {
    // The crucial safety property — across noise levels and seeds, if the CRC
    // says OK then the decoded text must actually match what was sent.
    for (const fec of [true, false]) {
        for (const noiseLevel of [0.1, 0.3, 0.5, 0.8, 1.0]) {
            for (const seed of SEEDS) {
                const r = channel(MSG, { noiseLevel, fec, seed });
                if (r.decoded.crcOk) {
                    assert.equal(r.text, MSG,
                        `false accept at fec=${fec} level=${noiseLevel} seed=${seed}`);
                }
            }
        }
    }
});

test('FEC repairs line noise the bare frame cannot survive', () => {
    const level = 0.3;
    let fecOk = 0, rawOk = 0, everCorrected = false;
    for (const seed of SEEDS) {
        const withFec = channel(MSG, { noiseLevel: level, fec: true, seed });
        const withoutFec = channel(MSG, { noiseLevel: level, fec: false, seed });
        if (withFec.decoded.crcOk) fecOk++;
        if (withoutFec.decoded.crcOk) rawOk++;
        if (withFec.decoded.crcOk && withFec.decoded.corrected > 0) everCorrected = true;
    }
    assert.ok(fecOk > rawOk, `FEC (${fecOk}) should beat raw (${rawOk})`);
    assert.ok(fecOk >= SEEDS.length * 0.7, `FEC should recover most messages (${fecOk}/${SEEDS.length})`);
    assert.ok(everCorrected, 'expected at least one message recovered via active correction');
});

test('heavy noise degrades and is detected, never silently wrong', () => {
    let ok = 0;
    for (const seed of SEEDS) {
        const r = channel(MSG, { noiseLevel: 1.0, fec: true, seed });
        if (r.decoded.crcOk) ok++;
    }
    // Some get through, but a loud line clearly breaks things (detected via CRC).
    assert.ok(ok < SEEDS.length, 'a very noisy line should fail at least sometimes');
});

test('decode stats report bit errors and corrections', () => {
    const payload = Array.from('ACK', (c) => c.charCodeAt(0));
    const wire = FEC.encodeFrame(payload, { fec: true });
    const buf = modem.generateTransmissionFromBytes(wire);
    modem.addNoise(buf, 0.3, mulberry(7));
    const rx = demod.demodulate(buf, modem.dataStartSamples(), wire.length).bytes;
    const decoded = FEC.decodeFrame(rx, { fec: true });
    const stats = modem._buildDecodeStats('ACK', wire, rx, decoded, true, 0.3);
    assert.equal(typeof stats.bitErrors, 'number');
    assert.equal(typeof stats.crcOk, 'boolean');
    assert.equal(stats.sent, 'ACK');
});
