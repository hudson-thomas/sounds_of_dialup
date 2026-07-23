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
 *      not, the byte is flagged so the upper layers know the frame is suspect
 *      (see `framing` in FEC.decodeFrame, which folds this into byte statuses).
 *
 * Frame sync is also recovered from the audio, not supplied by the transmitter:
 * findDataStart() hunts for the mark preamble — a long run of unbroken mark that
 * only occurs between the channel seizure and the first data byte — and returns
 * the mark->space edge that ends it. All the receiver is told is roughly where
 * carrier begins, which is exactly what a real modem's carrier-detect gives it.
 *
 * Because it reads the actual (optionally noisy) waveform, demodulation can and
 * does fail under heavy noise — which is the whole point of the FEC/CRC above it.
 */

// Blind-sync tuning: how many candidate start edges to consider, and how many
// bytes to probe when judging each one.
const MAX_SYNC_CANDIDATES = 32;
const SYNC_PROBE_BYTES = 4;

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
     * Blind frame sync: locate the first data start bit at/after `from`.
     *
     * The transmitter's preamble is a long unbroken run of mark (130ms ≈ 156
     * bits). Nothing else in the signal looks like that — the channel seizure
     * that precedes it alternates every single bit — so a sustained mark run is
     * an unambiguous "data is about to start" marker. Once we've seen enough of
     * it, the next confirmed space is the first start bit.
     *
     * Scans at half-bit resolution and requires the space to persist for two
     * consecutive steps, so an impulse crackle inside the preamble can't fake a
     * start bit. Returns a sub-sample edge position, or -1 if sync failed.
     */
    findDataStart(samples, from = 0, limit = samples.length, minMarkBits = 4) {
        const step = this.samplesPerBit / 2;
        const needMarkSteps = Math.ceil(minMarkBits * 2);
        const end = Math.min(limit, samples.length - this.windowLen);

        // Gather every plausible "long mark, then space" edge. On a noisy line an
        // impulse crackle inside the preamble looks exactly like a start bit, so
        // we can't just take the first one — we collect and then adjudicate.
        const candidates = [];
        let markRun = 0;
        for (let c = Math.max(from, this.windowLen / 2); c <= end; c += step) {
            if (this.discriminator(samples, c) > 0) { markRun++; continue; }
            if (markRun >= needMarkSteps) {
                const edge = this.findStartEdge(samples, c - step, c);
                candidates.push(edge >= 0 ? edge : c - step / 2);
                if (candidates.length >= MAX_SYNC_CANDIDATES) break;
            }
            markRun = 0;
        }
        if (candidates.length === 0) return -1;

        // Adjudicate by UART plausibility: at the true start bit the following
        // bytes all frame correctly, whereas a crackle-induced candidate is still
        // inside the preamble, so the "start bits" after it read as mark and the
        // framing check collapses. Take the earliest confident lock — a later
        // candidate may frame just as well but has already lost leading bytes.
        let best = candidates[0];
        let bestScore = -1;
        for (const candidate of candidates) {
            const score = this.framingScore(samples, candidate, SYNC_PROBE_BYTES);
            if (score >= SYNC_PROBE_BYTES - 1) return candidate;
            if (score > bestScore) { bestScore = score; best = candidate; }
        }
        return best;
    }

    /** How many of the next `n` bytes at `start` have valid UART framing. */
    framingScore(samples, start, n) {
        const spb = this.samplesPerBit;
        let score = 0;
        for (let b = 0; b < n; b++) {
            const frameStart = start + b * 10 * spb;
            if (frameStart + 10 * spb > samples.length) break;
            if (this.sampleBit(samples, frameStart + 0.5 * spb) === 0 &&
                this.sampleBit(samples, frameStart + 9.5 * spb) === 1) {
                score++;
            }
        }
        return score;
    }

    /**
     * Demodulate UART 8-N-1 bytes starting around `dataStart`.
     * @param {Float32Array} samples
     * @param {number} dataStart   sample index of (roughly) the first start bit
     * @param {number} [maxBytes]  stop after this many bytes; omit to read until
     *                             the samples run out (the frame's own LEN field
     *                             then decides where the message actually ends)
     * @returns {{bytes: number[], frames: Array<{value:number, framingOk:boolean, center:number}>}}
     */
    demodulate(samples, dataStart, maxBytes = Infinity) {
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
