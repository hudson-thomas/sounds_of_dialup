/**
 * Exhaustive tests for the FEC + framing layer.  node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const FEC = require('../static/fec.js');

test('Hamming: clean round-trip for all 16 nibbles', () => {
    for (let n = 0; n < 16; n++) {
        const cw = FEC.hammingEncode(n);
        const dec = FEC.hammingDecode(cw);
        assert.equal(dec.nibble, n);
        assert.equal(dec.status, 'ok');
    }
});

test('Hamming: corrects every single-bit error in every codeword', () => {
    for (let n = 0; n < 16; n++) {
        const cw = FEC.hammingEncode(n);
        for (let bit = 0; bit < 8; bit++) {
            const dec = FEC.hammingDecode(cw ^ (1 << bit));
            assert.equal(dec.nibble, n, `nibble ${n} bit ${bit} not recovered`);
            assert.equal(dec.status, 'corrected');
        }
    }
});

test('Hamming: detects every double-bit error', () => {
    for (let n = 0; n < 16; n++) {
        const cw = FEC.hammingEncode(n);
        for (let a = 0; a < 8; a++) {
            for (let b = a + 1; b < 8; b++) {
                const dec = FEC.hammingDecode(cw ^ (1 << a) ^ (1 << b));
                assert.equal(dec.status, 'error', `nibble ${n} bits ${a},${b} not flagged`);
            }
        }
    }
});

test('CRC-16-CCITT known vector ("123456789" => 0x29B1)', () => {
    const bytes = Array.from('123456789', (c) => c.charCodeAt(0));
    assert.equal(FEC.crc16(bytes), 0x29B1);
});

test('Frame: clean encode/decode round-trip (FEC on)', () => {
    const payload = Array.from('Hello, World!', (c) => c.charCodeAt(0));
    const wire = FEC.encodeFrame(payload, { fec: true });
    const out = FEC.decodeFrame(wire, { fec: true });
    assert.ok(out.crcOk);
    assert.equal(out.corrected, 0);
    assert.deepEqual(Array.from(out.payload), payload);
});

test('Frame: FEC repairs a single-bit error per codeword and CRC passes', () => {
    const payload = Array.from('ACK', (c) => c.charCodeAt(0));
    const wire = FEC.encodeFrame(payload, { fec: true });
    // Flip one bit in each transmitted byte (each is its own codeword).
    for (let i = 0; i < wire.length; i++) wire[i] ^= 1 << (i % 8);
    const out = FEC.decodeFrame(wire, { fec: true });
    assert.ok(out.crcOk, 'CRC should pass after correction');
    assert.equal(out.corrected, wire.length);
    assert.deepEqual(Array.from(out.payload), payload);
});

test('Frame: without FEC the same corruption is caught by CRC, not repaired', () => {
    const payload = Array.from('ACK', (c) => c.charCodeAt(0));
    const wire = FEC.encodeFrame(payload, { fec: false });
    wire[2] ^= 0x01;  // corrupt a payload byte
    const out = FEC.decodeFrame(wire, { fec: false });
    assert.equal(out.crcOk, false, 'CRC must flag uncorrected corruption');
});

test('Frame: payloads longer than 255 bytes round-trip (16-bit length)', () => {
    const payload = Array.from({ length: 1000 }, (_, i) => 32 + (i % 95));
    const wire = FEC.encodeFrame(payload, { fec: true });
    const out = FEC.decodeFrame(wire, { fec: true });
    assert.ok(out.crcOk);
    assert.deepEqual(Array.from(out.payload), payload);
});

test('Frame: double-bit error is detected as uncorrectable', () => {
    const payload = Array.from('OK', (c) => c.charCodeAt(0));
    const wire = FEC.encodeFrame(payload, { fec: true });
    wire[0] ^= 0b11;  // two bits in one codeword
    const out = FEC.decodeFrame(wire, { fec: true });
    assert.ok(out.uncorrectable >= 1, 'double-bit error should be counted');
});
