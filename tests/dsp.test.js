/**
 * DSP tests for the Bell 202 modem engine.
 *
 * Dependency-free — run with:  node --test
 *
 * These exercise the pure signal-generation layer (no AudioContext / DOM needed)
 * and include a full demodulation round-trip: text is FSK-encoded to audio and
 * then recovered straight from the samples with a Goertzel detector.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Bell202Modem = require('../static/bell202.js');

const SR = 44100;

/** Goertzel power of `freq` over samples[start .. start+len). */
function goertzel(samples, start, len, freq) {
    const w = 2 * Math.PI * freq / SR;
    const coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
        const s0 = samples[start + i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Recover text from a full FSK transmission buffer by demodulating each bit. */
function demodulate(modem, buffer, length) {
    const bitLen = Math.round(SR / modem.BAUD_RATE);
    const seizureLen = modem.CHANNEL_SEIZURE_BITS * bitLen;
    const preambleLen = Math.round(modem.MARK_PREAMBLE_DURATION * SR);
    const dataStart = seizureLen + preambleLen;

    let chars = '';
    for (let c = 0; c < length; c++) {
        const bits = [];
        for (let j = 0; j < 10; j++) {
            const start = dataStart + (c * 10 + j) * bitLen;
            const mark = goertzel(buffer, start, bitLen, modem.MARK_FREQ);   // 1 -> 1200 Hz
            const space = goertzel(buffer, start, bitLen, modem.SPACE_FREQ); // 0 -> 2200 Hz
            bits.push(mark > space ? 1 : 0);
        }
        // bits = [start(0), d0..d7 LSB first, stop(1)]
        let byte = 0;
        for (let i = 0; i < 8; i++) byte |= bits[1 + i] << i;
        chars += String.fromCharCode(byte);
    }
    return chars;
}

test('encodeByte produces correct 8-N-1 framing (LSB first)', () => {
    const m = new Bell202Modem();
    const bits = m.encodeByte(0x41); // 'A' = 0b01000001
    assert.equal(bits.length, 10);
    assert.equal(bits[0], 0, 'start bit is space');
    assert.equal(bits[9], 1, 'stop bit is mark');
    assert.deepEqual(bits.slice(1, 9), [1, 0, 0, 0, 0, 0, 1, 0], 'data bits LSB first');
});

test('generateTransmission length matches the spec math', () => {
    const m = new Bell202Modem();
    const text = 'Hi';
    const bitLen = Math.round(SR / m.BAUD_RATE);
    const expected =
        m.CHANNEL_SEIZURE_BITS * bitLen +
        Math.round(m.MARK_PREAMBLE_DURATION * SR) +
        text.length * 10 * bitLen +
        Math.round(m.TRAILING_MARK_DURATION * SR);
    assert.equal(m.generateTransmission(text).length, expected);
});

test('FSK round-trip: text demodulates back to itself', () => {
    const m = new Bell202Modem();
    const text = 'Hello, World! 1990';
    const buffer = m.generateTransmission(text);
    assert.equal(demodulate(m, buffer, text.length), text);
});

test('transmission never exceeds full scale', () => {
    const m = new Bell202Modem();
    const buffer = m.generateTransmission('The quick brown fox');
    for (let i = 0; i < buffer.length; i++) {
        assert.ok(Math.abs(buffer[i]) <= 1.0, `sample ${i} = ${buffer[i]} out of range`);
    }
});

test('dial-up sequence is soft-limited below clipping', () => {
    const m = new Bell202Modem();
    const { samples } = m.generateDialupSequence('5551234');
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    assert.ok(peak < 1.0, `dial-up peak ${peak} should stay below full scale`);
    assert.ok(peak > 0.5, `dial-up peak ${peak} should still be reasonably loud`);
});

test('dial-up events are ordered and span the audio', () => {
    const m = new Bell202Modem();
    const seq = m.generateDialupSequence('5551234');
    assert.deepEqual(
        seq.events.map((e) => e.type),
        ['dialTone', 'dialing', 'ringing', 'negotiating', 'connected']);
    for (let i = 1; i < seq.events.length; i++) {
        assert.ok(seq.events[i].time >= seq.events[i - 1].time, 'event times are monotonic');
    }
    // totalDuration should match the rendered sample count (within one fade).
    const renderedDuration = seq.samples.length / SR;
    assert.ok(Math.abs(renderedDuration - seq.totalDuration) < 0.02,
        `rendered ${renderedDuration}s vs reported ${seq.totalDuration}s`);
});

test('line probing is deterministic across instances', () => {
    const a = new Bell202Modem().generateLineProbing(0.1);
    const b = new Bell202Modem().generateLineProbing(0.1);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});
