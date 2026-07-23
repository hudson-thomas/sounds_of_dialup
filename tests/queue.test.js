/**
 * Transmit-queue tests.
 *
 * Every transmission carries its own channel seizure + mark preamble + trailing
 * mark, so even a one-character message costs ~0.5s of audio. Real-time mode
 * enqueues one message per keystroke, which fills the queue several times faster
 * than it can drain — so anything left waiting must be coalesced into the next
 * transmission rather than played one at a time.  node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Bell202Modem = require('../static/bell202.js');
const { loadInBrowserLikeContext } = require('./helpers/browser-context.js');

/** Build the app with a modem stub that records what it was asked to send. */
function makeEmulator() {
    const { sandbox, handlers } = loadInBrowserLikeContext();
    handlers.DOMContentLoaded();
    const emulator = sandbox.emulator;

    const sent = [];
    let release;
    emulator.modem = {
        audioContext: { state: 'running' },
        transmit(text) {
            sent.push(text);
            return new Promise((resolve) => { release = () => resolve({ crcOk: true }); });
        },
        init() {}, stop() {}, disconnect() {}
    };
    return { emulator, sent, finish: () => release && release() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('messages queued during a transmission are coalesced into one', async () => {
    const { emulator, sent, finish } = makeEmulator();

    emulator.queueTransmission('a');       // starts immediately
    await tick();
    assert.deepEqual(sent, ['a']);

    // Six more keystrokes land while 'a' is still playing.
    for (const ch of ['b', 'c', 'd', 'e', 'f', 'g']) emulator.queueTransmission(ch);
    await tick();
    assert.deepEqual(sent, ['a'], 'nothing else may start mid-transmission');

    finish();
    await tick();
    assert.deepEqual(sent, ['a', 'bcdefg'],
        'the backlog must drain as a single transmission, in order');
});

test('the queue never grows without bound while input keeps arriving', async () => {
    const { emulator, sent, finish } = makeEmulator();

    emulator.queueTransmission('start');
    await tick();

    // Sustained typing: 40 keystrokes during one in-flight transmission.
    for (let i = 0; i < 40; i++) emulator.queueTransmission(String(i % 10));
    await tick();
    assert.equal(emulator.transmitQueue.length, 40, 'backlog accumulates while busy');

    finish();
    await tick();
    assert.equal(emulator.transmitQueue.length, 0, 'backlog clears in one go');
    assert.equal(sent.length, 2, '40 keystrokes must not become 40 transmissions');
    assert.equal(sent[1].length, 40, 'no characters lost in the merge');
});

test('coalescing preserves the exact character sequence', async () => {
    const { emulator, sent, finish } = makeEmulator();
    const typed = 'Hello, World! ☎';

    emulator.queueTransmission(typed[0]);
    await tick();
    for (const ch of Array.from(typed).slice(1)) emulator.queueTransmission(ch);
    await tick();
    finish();
    await tick();

    assert.equal(sent.join(''), typed);
});

test('a coalesced batch costs far less audio than sending each char alone', () => {
    // Why coalescing matters: the per-transmission overhead dominates entirely.
    const modem = new Bell202Modem();
    const FEC = require('../static/fec.js');
    const audioSeconds = (text) =>
        modem.generateTransmissionFromBytes(
            FEC.encodeFrame(Array.from(new TextEncoder().encode(text)), { fec: true })
        ).length / modem.sampleRate;

    const text = 'abcdefghij';
    const oneAtATime = Array.from(text).reduce((sum, ch) => sum + audioSeconds(ch), 0);
    const batched = audioSeconds(text);

    assert.ok(oneAtATime > 4 * batched,
        `batching should be far cheaper (${oneAtATime.toFixed(2)}s vs ${batched.toFixed(2)}s)`);
});
