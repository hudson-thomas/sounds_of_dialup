/**
 * Playback robustness: a transmission must always complete, even when the
 * AudioContext is suspended (autoplay policy) so the audio clock never advances
 * and source.onended never fires. If transmit() hangs, the caller's queue
 * wedges and the whole UI dies — the bug this guards against.  node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Bell202Modem = require('../static/bell202.js');

/** A context whose clock is frozen and whose source never reports 'ended'. */
function stuckContext() {
    return {
        state: 'running',          // init() won't try to resume
        currentTime: 0,            // never advances
        destination: {},
        createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
        createBufferSource: () => ({
            buffer: null, onended: null,
            connect() {}, disconnect() {}, start() {}, stop() {}
        })
    };
}

/** A context that "plays": start() reports completion on the next tick. */
function playingContext() {
    return {
        state: 'running',
        currentTime: 0,
        destination: {},
        createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
        createBufferSource() {
            const src = {
                buffer: null, onended: null,
                connect() {}, disconnect() {}, stop() {},
                start: () => setTimeout(() => src.onended && src.onended(), 0)
            };
            return src;
        }
    };
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('transmit() hung')), ms))
    ]);
}

test('transmit resolves even with a suspended/frozen audio clock (backstop)', async () => {
    const m = new Bell202Modem();
    m.isConnected = true;            // skip the long dial-up so the backstop is short
    m.audioContext = stuckContext();

    const result = await withTimeout(m.transmit('Hi', null, { noiseLevel: 0, fec: true }), 5000);
    assert.ok(result, 'should resolve with a decode report');
    assert.equal(result.decoded, 'Hi');
    assert.equal(m.isTransmitting, false, 'state must be reset');
});

test('normal completion fires once and resets cleanly', async () => {
    const m = new Bell202Modem();
    m.isConnected = true;
    m.audioContext = playingContext();

    let endCount = 0;
    m.onTransmitEnd = () => endCount++;

    const result = await withTimeout(m.transmit('OK', null, { noiseLevel: 0, fec: true }), 5000);
    assert.ok(result.crcOk);
    // Give any stray backstop a chance to (wrongly) fire — it must not.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(endCount, 1, 'onTransmitEnd must fire exactly once');
    assert.equal(m.isTransmitting, false);
});

test('a second transmission works after the first (no wedge)', async () => {
    const m = new Bell202Modem();
    m.isConnected = true;
    m.audioContext = stuckContext();

    const r1 = await withTimeout(m.transmit('one', null, {}), 5000);
    const r2 = await withTimeout(m.transmit('two', null, {}), 5000);
    assert.equal(r1.decoded, 'one');
    assert.equal(r2.decoded, 'two');
});
