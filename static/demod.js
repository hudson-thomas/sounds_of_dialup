/**
 * Bell 202 FSK demodulator.
 *
 * This is a genuine receiver: it recovers bytes from raw audio samples, it is
 * not told the bit pattern. The chain is:
 *
 *   1. Discriminator — a 1-bit-wide Goertzel pair measures energy at the mark
 *      (1200 Hz) and space (2200 Hz) frequencies. d = E_mark - E_space; its
 *      sign is the instantaneous symbol, its magnitude is a soft confidence.
 *   2. Clock recovery — UART-style asynchronous framing. For each byte we look
 *      for the mark->space start-bit edge near where the bit clock expects it,
 *      lock onto it, then sample the 10 bits (start + 8 data + stop) at their
 *      centres. Re-syncing per byte tolerates noise and small timing drift.
 *   3. Framing check — the start bit must be space and the stop bit mark; if
 *      not, the byte is flagged so the upper layers know the frame is suspect.
 *
 * Because it reads the actual (optionally noisy) waveform, demodulation can and
 * does fail under heavy noise — which is the whole point of the FEC/CRC above it.
 */

class Bell202Demodulator {
    constructor({ sampleRate = 44100, markFreq = 1200, spaceFreq = 2200, baud = 1200 } = {}) {
        this.sampleRate = sampleRate;
        this.markFreq = markFreq;
        this.spaceFreq = spaceFreq;
        this.baud = baud;
        this.samplesPerBit = sampleRate / baud;        // keep fractional for accuracy
        this.windowLen = Math.round(this.samplesPerBit);
    }

    /** Goertzel energy of `freq` over samples[start .. start+len). */
    goertzel(samples, start, len, freq) {
        const w = 2 * Math.PI * freq / this.sampleRate;
        const coeff = 2 * Math.cos(w);
        let s1 = 0, s2 = 0;
        const end = Math.min(start + len, samples.length);
        for (let i = Math.max(0, start); i < end; i++) {
            const s0 = samples[i] + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        return s1 * s1 + s2 * s2 - coeff * s1 * s2;
    }

    /**
     * Discriminator at a bit centre: positive => mark (1), negative => space (0).
     * The window is centred on `center` and one bit wide.
     */
    discriminator(samples, center) {
        const start = Math.round(center - this.windowLen / 2);
        const mark = this.goertzel(samples, start, this.windowLen, this.markFreq);
        const space = this.goertzel(samples, start, this.windowLen, this.spaceFreq);
        return mark - space;
    }

    /** Sample one bit (1/0) at its centre. */
    sampleBit(samples, center) {
        return this.discriminator(samples, center) > 0 ? 1 : 0;
    }

    /**
     * Find the next mark->space transition (start-bit edge) at/after `from`,
     * searching up to `limit`. Returns the sub-sample edge position or -1.
     */
    findStartEdge(samples, from, limit) {
        const step = 1;
        let prev = this.discriminator(samples, from) > 0;  // true = mark
        for (let c = from + step; c <= limit; c += step) {
            const isMark = this.discriminator(samples, c) > 0;
            if (prev && !isMark) return c - step / 2;        // high->low crossing
            prev = isMark;
        }
        return -1;
    }

    /**
     * Demodulate UART 8-N-1 bytes starting around `dataStart`.
     * @param {Float32Array} samples
     * @param {number} dataStart   sample index of (roughly) the first start bit
     * @param {number} maxBytes    stop after this many bytes
     * @returns {{bytes: number[], frames: Array<{value:number, framingOk:boolean, center:number}>}}
     */
    demodulate(samples, dataStart, maxBytes) {
        const spb = this.samplesPerBit;
        const search = Math.round(spb * 0.5);   // how far to hunt for each start edge
        const bytes = [];
        const frames = [];

        let clock = dataStart;  // where we expect the next start edge
        for (let n = 0; n < maxBytes; n++) {
            if (clock + 10 * spb > samples.length) break;

            // Re-sync on the start-bit edge; free-run from the clock if not found.
            const edge = this.findStartEdge(samples, clock - search, clock + search);
            const frameStart = (edge >= 0) ? edge : clock;

            const bits = [];
            for (let k = 0; k < 10; k++) {
                bits.push(this.sampleBit(samples, frameStart + (k + 0.5) * spb));
            }

            const framingOk = bits[0] === 0 && bits[9] === 1;
            let value = 0;
            for (let i = 0; i < 8; i++) value |= bits[1 + i] << i;

            const center = frameStart + 5 * spb;
            bytes.push(value);
            frames.push({ value, framingOk, center });

            clock = frameStart + 10 * spb;  // next byte follows immediately
        }

        return { bytes, frames };
    }
}

if (typeof window !== 'undefined') window.Bell202Demodulator = Bell202Demodulator;
if (typeof module !== 'undefined' && module.exports) module.exports = Bell202Demodulator;
