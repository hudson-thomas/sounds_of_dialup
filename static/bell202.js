/**
 * Bell 202 Modem Audio Generator
 *
 * Implements authentic Bell 202 FSK modulation using the Web Audio API,
 * plus a stylised V.34 dial-up handshake (dial tone, DTMF, ringback,
 * negotiation screech) for the full "connecting" experience.
 *
 * Specifications:
 * - Mark (1): 1200 Hz
 * - Space (0): 2200 Hz
 * - Baud rate: 1200 bps  (bit duration 833.33 us)
 * - Encoding: 8-N-1 (8 data bits, no parity, 1 stop bit)
 *
 * Handshake sequence (per Bellcore Caller ID spec):
 * 1. Channel seizure: 250ms of alternating 01010101 (300 bits)
 * 2. Mark preamble: 130ms of continuous 1200 Hz
 * 3. Data transmission
 *
 * Architecture notes:
 * - The FSK data path renders through renderTones() in a single tight pass
 *   with continuous phase (no per-bit allocation, no clicks).
 * - Every other waveform is built on the fill() / oscillator primitives, then
 *   the dial-up composite is edge-faded and soft-limited so it never clips.
 * - Playback timing is driven off audioContext.currentTime (see transmit()),
 *   not setTimeout, so character display stays locked to the audio.
 */

const TWO_PI = 2 * Math.PI;

// Animation-frame helpers with a non-browser fallback (so the module can be
// imported in Node for testing without a DOM).
const requestFrame = (typeof requestAnimationFrame !== 'undefined')
    ? requestAnimationFrame.bind(globalThis)
    : (fn) => setTimeout(() => fn(), 16);
const cancelFrame = (typeof cancelAnimationFrame !== 'undefined')
    ? cancelAnimationFrame.bind(globalThis)
    : clearTimeout;

// The FEC codec and FSK demodulator live in sibling modules. In the browser
// they are plain globals (load fec.js + demod.js before this file); under Node
// (tests) they are required. Note the underscore-prefixed names: classic
// <script> tags share one global lexical scope, so reusing `FEC` /
// `Bell202Demodulator` here would collide with those modules' own declarations.
let _FEC, _Demodulator;
if (typeof require !== 'undefined') {
    _FEC = require('./fec.js');
    _Demodulator = require('./demod.js');
} else {
    _FEC = globalThis.FEC;
    _Demodulator = globalThis.Bell202Demodulator;
}

// ---- Text codec -------------------------------------------------------------
//
// Text goes on the wire as UTF-8 bytes. Using charCodeAt() directly would
// silently truncate every character above U+00FF to its low byte — and because
// the CRC is computed over the already-truncated frame, the integrity check
// would then certify that corruption as healthy. Encoding properly means the
// only damage the receiver can ever see is damage the *line* caused.

/** Text -> UTF-8 bytes. */
function encodeText(text) {
    return Array.from(new TextEncoder().encode(text));
}

/** UTF-8 bytes -> text. Damaged sequences become U+FFFD instead of throwing. */
function decodeText(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
}

/**
 * UTF-8 bytes -> characters, each tagged with the byte range it came from.
 * The reveal animation needs this: a character can only be displayed once its
 * LAST byte has arrived, and its health is the worst health of all its bytes.
 * @returns {Array<{char: string, firstByte: number, lastByte: number}>}
 */
function decodeTextWithSpans(bytes) {
    const buf = Uint8Array.from(bytes);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const out = [];
    let next = 0;  // first byte not yet attributed to a character

    const emit = (chunk, lastByte) => {
        for (const char of chunk) {
            out.push({ char, firstByte: Math.min(next, lastByte), lastByte });
            next = lastByte + 1;
        }
    };

    for (let i = 0; i < buf.length; i++) {
        emit(decoder.decode(buf.subarray(i, i + 1), { stream: true }), i);
    }
    emit(decoder.decode(), Math.max(0, buf.length - 1));  // flush a dangling sequence
    return out;
}

class Bell202Modem {
    constructor() {
        this.audioContext = null;
        this.sampleRate = 44100;

        // Bell 202 frequencies
        this.MARK_FREQ = 1200;   // Binary 1
        this.SPACE_FREQ = 2200;  // Binary 0

        // Timing
        this.BAUD_RATE = 1200;
        this.BIT_DURATION = 1 / this.BAUD_RATE;  // 833.33 microseconds
        this.TRAILING_MARK_DURATION = 0.050;     // brief carrier sustain after data

        // Handshake timing (Bellcore spec)
        this.CHANNEL_SEIZURE_BITS = 300;        // 250ms at 1200 baud
        this.MARK_PREAMBLE_DURATION = 0.130;    // 130ms

        // Dial tone: North American standard
        this.DIAL_TONE_FREQ1 = 350;
        this.DIAL_TONE_FREQ2 = 440;

        // DTMF frequencies
        this.DTMF_ROW = [697, 770, 852, 941];
        this.DTMF_COL = [1209, 1336, 1477, 1633];
        this.DTMF_MAP = {
            '1': [0, 0], '2': [0, 1], '3': [0, 2], 'A': [0, 3],
            '4': [1, 0], '5': [1, 1], '6': [1, 2], 'B': [1, 3],
            '7': [2, 0], '8': [2, 1], '9': [2, 2], 'C': [2, 3],
            '*': [3, 0], '0': [3, 1], '#': [3, 2], 'D': [3, 3]
        };

        // Ringback tone: North American standard
        this.RINGBACK_FREQ1 = 440;
        this.RINGBACK_FREQ2 = 480;

        // Modem negotiation frequencies
        this.ANSWER_TONE_FREQ = 2100;           // ITU-T V.25 answer tone
        this.V21_ANSWER_MARK = 2225;            // V.21 answer channel
        this.V21_ANSWER_SPACE = 2025;

        // Dial-up timing
        this.DIAL_TONE_DURATION = 1.0;          // 1 second of dial tone
        this.DTMF_TONE_DURATION = 0.1;          // 100ms per digit
        this.DTMF_PAUSE_DURATION = 0.05;        // 50ms between digits
        this.RINGBACK_ON_DURATION = 2.0;        // 2 seconds on
        this.RINGBACK_OFF_DURATION = 4.0;       // 4 seconds off
        this.RING_CYCLES = 1;                   // Number of ring cycles
        this.ANSWER_TONE_DURATION = 2.5;        // 2.5 seconds of answer tone

        // Anti-click fade applied to each dial-up segment boundary
        this.SEGMENT_FADE_DURATION = 0.005;     // 5ms raised-cosine ramp

        // Line-noise model. Dial-up lines are dominated by *impulsive* noise
        // (crackles/pops), not smooth hiss — and impulse bursts produce the
        // sparse, localised bit errors that FEC is actually good at. So the
        // channel is: gentle always-harmless background hiss + occasional
        // ~1-bit-long noise bursts whose rate scales with the noise level.
        this.NOISE_HISS_SIGMA = 0.12;     // background hiss at level 1.0 (cosmetic)
        this.NOISE_BURST_RATE = 0.0016;   // burst-start probability/sample at level 1.0
        this.NOISE_BURST_SIGMA = 2.6;     // burst strength (enough to flip its bit)

        // State
        this.isTransmitting = false;
        this.isConnected = false;       // Has the dial-up handshake completed?
        this.phase = 0;                 // Continuous phase for FSK data
        this._rngState = 0x2545f491;    // Seeded RNG (deterministic line probing)

        // Active-playback handles (so stop() can truly interrupt)
        this._activeSource = null;
        this._activeResolve = null;
        this._frameId = null;
        this._backstopId = null;
        this._events = null;
        this._eventIndex = 0;

        // Receiver: a real FSK demodulator decodes the (noisy) audio.
        this.demodulator = new _Demodulator({
            sampleRate: this.sampleRate,
            markFreq: this.MARK_FREQ,
            spaceFreq: this.SPACE_FREQ,
            baud: this.BAUD_RATE
        });
        this._decodeStats = null;

        // Callbacks
        this.onTransmitStart = null;
        this.onTransmitEnd = null;
        this.onCarrierDetect = null;
        this.onConnectionStatus = null; // Called with status updates during dial-up
        this.onDecodeStats = null;      // Called with the decode report when done
    }

    /**
     * Initialize the audio context. Best called from a user gesture (browser
     * autoplay policy), but safe to call repeatedly and from anywhere.
     *
     * We do NOT force the context sample rate: some browsers/devices throw
     * NotSupportedError if asked for a rate the hardware can't run at. Our
     * buffers declare 44.1 kHz and the context resamples on playback, while the
     * demodulator works on the raw 44.1 kHz samples directly — so the context's
     * own rate is irrelevant to correctness.
     */
    async init() {
        if (!this.audioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new Ctx();
        }
        if (this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
            } catch (e) {
                /* resume() needs a user gesture; the wall-clock backstop covers us */
            }
        }
        return this;
    }

    // ---- Low-level synthesis primitives -------------------------------------

    /** Sample count for a duration in seconds. */
    samples(duration) {
        return Math.round(duration * this.sampleRate);
    }

    /** Angular frequency (radians/sample) for a frequency in Hz. */
    omega(freq) {
        return TWO_PI * freq / this.sampleRate;
    }

    /**
     * Allocate `n` samples and fill them from a per-sample function fn(i) -> value.
     * This is the single oscillator loop every non-FSK waveform is built on.
     */
    fill(n, fn) {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            out[i] = fn(i);
        }
        return out;
    }

    /** Deterministic PRNG in [0, 1) (mulberry32) — keeps line probing reproducible. */
    random() {
        this._rngState = (this._rngState + 0x6d2b79f5) | 0;
        let t = this._rngState;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Raised-cosine fade on both edges of a buffer (mutates and returns it). */
    fadeEdges(buffer, fadeSamples) {
        const f = Math.min(fadeSamples, buffer.length >> 1);
        for (let i = 0; i < f; i++) {
            const gain = 0.5 * (1 - Math.cos(Math.PI * i / f));
            buffer[i] *= gain;
            buffer[buffer.length - 1 - i] *= gain;
        }
        return buffer;
    }

    /**
     * Soft limiter (tanh knee above a threshold) — guarantees |sample| < 1 while
     * leaving quiet passages untouched. Used on summed signals that would
     * otherwise clip (e.g. the 21-tone line probe).
     */
    softLimit(buffer, threshold = 0.8) {
        const range = 1 - threshold;
        for (let i = 0; i < buffer.length; i++) {
            const x = buffer[i];
            if (x > threshold) {
                buffer[i] = threshold + range * Math.tanh((x - threshold) / range);
            } else if (x < -threshold) {
                buffer[i] = -threshold + range * Math.tanh((x + threshold) / range);
            }
        }
        return buffer;
    }

    /** Generate samples for a pure tone (independent phase). */
    generateToneSamples(frequency, duration) {
        const w = this.omega(frequency);
        return this.fill(this.samples(duration), (i) => Math.sin(w * i));
    }

    /** Generate dual-tone samples (dial tone, ringback, DTMF). */
    generateDualToneSamples(freq1, freq2, duration, amplitude = 0.5) {
        const w1 = this.omega(freq1);
        const w2 = this.omega(freq2);
        return this.fill(this.samples(duration),
            (i) => amplitude * (Math.sin(w1 * i) + Math.sin(w2 * i)));
    }

    /** Generate silence. */
    generateSilence(duration) {
        return new Float32Array(this.samples(duration));
    }

    // ---- Dial-up sequence components ----------------------------------------

    /** Dial tone (350 Hz + 440 Hz). */
    generateDialTone(duration = this.DIAL_TONE_DURATION) {
        return this.generateDualToneSamples(
            this.DIAL_TONE_FREQ1, this.DIAL_TONE_FREQ2, duration, 0.3);
    }

    /** DTMF tone for a single digit. */
    generateDTMFDigit(digit) {
        const mapping = this.DTMF_MAP[digit];
        if (!mapping) return this.generateSilence(this.DTMF_TONE_DURATION);
        return this.generateDualToneSamples(
            this.DTMF_ROW[mapping[0]], this.DTMF_COL[mapping[1]],
            this.DTMF_TONE_DURATION, 0.4);
    }

    /** DTMF sequence for a phone number. */
    generateDTMFSequence(phoneNumber) {
        const parts = [];
        for (const digit of phoneNumber) {
            if (this.DTMF_MAP[digit]) {
                parts.push(this.generateDTMFDigit(digit));
                parts.push(this.generateSilence(this.DTMF_PAUSE_DURATION));
            }
        }
        return this.concatenateSamples(parts);
    }

    /** Ringback tone with proper cadence (2s on, 4s off). */
    generateRingback(cycles = this.RING_CYCLES) {
        const parts = [];
        for (let i = 0; i < cycles; i++) {
            parts.push(this.generateDualToneSamples(
                this.RINGBACK_FREQ1, this.RINGBACK_FREQ2,
                this.RINGBACK_ON_DURATION, 0.3));
            if (i < cycles - 1) {
                parts.push(this.generateSilence(this.RINGBACK_OFF_DURATION));
            }
        }
        return this.concatenateSamples(parts);
    }

    /**
     * ANSam answer tone: 2100 Hz with 15 Hz amplitude modulation and a 180°
     * phase reversal every 450ms (ITU-T V.8). The characteristic "warble".
     */
    generateAnswerTone(duration = this.ANSWER_TONE_DURATION) {
        const wc = this.omega(this.ANSWER_TONE_FREQ);
        const wm = this.omega(15);
        const rev = this.samples(0.45);
        const depth = 0.2;  // 20% modulation depth per ITU-T
        return this.fill(this.samples(duration), (i) => {
            const am = 1 - depth + depth * Math.sin(wm * i);
            const reversal = Math.PI * Math.floor(i / rev);
            return 0.4 * am * Math.sin(wc * i + reversal);
        });
    }

    /** Pure tone with periodic 180° phase reversals (V.34 A/B signals). */
    generateToneWithPhaseReversals(freq, duration, reversalInterval = 0.45) {
        const w = this.omega(freq);
        const rev = this.samples(reversalInterval);
        return this.fill(this.samples(duration),
            (i) => 0.4 * Math.sin(w * i + Math.PI * Math.floor(i / rev)));
    }

    /** V.21 low-channel handshake FSK (300 baud, answer channel), phase-continuous. */
    generateV21Handshake(duration = 0.5) {
        const samplesPerBit = this.samples(1 / 300);
        const wMark = this.omega(this.V21_ANSWER_MARK);
        const wSpace = this.omega(this.V21_ANSWER_SPACE);
        const numBits = Math.round(duration * 300);
        let phase = 0;
        return this.fill(numBits * samplesPerBit, (i) => {
            const bit = Math.floor(i / samplesPerBit);
            phase += (bit % 2 === 0) ? wMark : wSpace;
            return 0.5 * Math.sin(phase);
        });
    }

    /** Advance a 15-bit LFSR scrambler (V.34 style, taps 15/14). */
    scrambleBit(lfsr) {
        const bit = ((lfsr >> 14) ^ (lfsr >> 13)) & 1;
        return ((lfsr << 1) | bit) & 0x7FFF;
    }

    /** V.34 line probing: 21 tones spread across the telephone band (~150–3750 Hz). */
    generateLineProbing(duration = 0.5) {
        const tones = Array.from({ length: 21 }, (_, i) => this.omega(150 + i * 171));
        const phases = tones.map(() => this.random() * TWO_PI);
        return this.fill(this.samples(duration), (i) => {
            let sample = 0;
            for (let t = 0; t < tones.length; t++) {
                sample += Math.sin(phases[t] + tones[t] * i);
            }
            return 0.08 * sample;
        });
    }

    /** Scrambled QAM-like training tone (the "screech") at a given carrier. */
    generateScrambledTraining(duration, carrierFreq, symbolRate = 2400) {
        const w = this.omega(carrierFreq);
        const samplesPerSymbol = Math.round(this.sampleRate / symbolRate);
        let lfsr = 0x5A5A;
        let symbolPhase = 0;
        return this.fill(this.samples(duration), (i) => {
            if (i % samplesPerSymbol === 0) {
                lfsr = this.scrambleBit(lfsr);
                symbolPhase = ((lfsr & 0x7) / 8) * TWO_PI;  // 8-PSK style steps
            }
            return 0.4 * Math.sin(w * i + symbolPhase);
        });
    }

    /**
     * V.34 modem negotiation sequence (ITU-T V.34 phases, stylised for sound).
     */
    generateModemNegotiation() {
        return [
            // Phase 1: ANSam answer tone (warbly 2100 Hz)
            this.generateAnswerTone(2.0),
            // Phase 2: V.21 capability exchange
            this.generateV21Handshake(0.2),
            this.generateSilence(0.05),
            // Phase 2: INFO sequences (low-pitched warble)
            this.generateScrambledTraining(0.3, 600, 600),
            // Phase 2: L1/L2 line probing (harsh broadband)
            this.generateLineProbing(0.8),
            // Phase 2: A signal (2400 Hz) and B signal (1200 Hz) with reversals
            this.generateToneWithPhaseReversals(2400, 0.3),
            this.generateToneWithPhaseReversals(1200, 0.2),
            // Phase 3: equalizer training — the main screech
            this.generateScrambledTraining(1.5, 1800, 3000),
            // Phase 4: final training at higher symbol rate
            this.generateScrambledTraining(0.8, 1800, 3200),
            // Final J pattern / sync
            this.generateToneSamples(1800, 0.1),
            this.generateSilence(0.05)
        ];
    }

    /**
     * Build the complete dial-up connection sequence.
     * Returns { samples, events, totalDuration }. Each segment is edge-faded to
     * remove boundary clicks and the whole thing is soft-limited so it can't clip.
     */
    generateDialupSequence(phoneNumber = '5551234') {
        const fade = this.samples(this.SEGMENT_FADE_DURATION);
        const segments = [];
        const events = [];
        let time = 0;

        const push = (buffer) => segments.push(this.fadeEdges(buffer, fade));
        const wait = (buffer) => { push(buffer); time += buffer.length / this.sampleRate; };

        // 1. Dial tone
        events.push({ type: 'dialTone', time });
        wait(this.generateDialTone());

        // 2. DTMF dialing
        events.push({ type: 'dialing', time });
        wait(this.generateDTMFSequence(phoneNumber));
        wait(this.generateSilence(0.5));

        // 3. Ringback
        events.push({ type: 'ringing', time });
        wait(this.generateRingback());
        wait(this.generateSilence(0.3));

        // 4. Modem negotiation
        events.push({ type: 'negotiating', time });
        for (const part of this.generateModemNegotiation()) {
            wait(part);
        }

        // 5. Connected
        events.push({ type: 'connected', time });

        const samples = this.softLimit(this.concatenateSamples(segments));
        return { samples, events, totalDuration: time };
    }

    // ---- FSK data path ------------------------------------------------------

    /**
     * Encode a single byte using 8-N-1 format.
     * Returns 10 bits: [start, d0..d7 (LSB first), stop].
     */
    encodeByte(byte) {
        const bits = [0];                       // start bit (space)
        for (let i = 0; i < 8; i++) {
            bits.push((byte >> i) & 1);
        }
        bits.push(1);                           // stop bit (mark)
        return bits;
    }

    /**
     * Render a list of FSK tone segments ({freq, duration}) into one buffer in a
     * single pass. Phase is carried continuously across segments so there are no
     * discontinuities — and no per-bit allocation.
     */
    renderTones(segments) {
        const lengths = segments.map((s) => this.samples(s.duration));
        const total = lengths.reduce((sum, n) => sum + n, 0);
        const out = new Float32Array(total);

        let offset = 0;
        for (let s = 0; s < segments.length; s++) {
            const w = this.omega(segments[s].freq);
            for (let i = 0; i < lengths[s]; i++) {
                out[offset++] = Math.sin(this.phase);
                this.phase += w;
            }
            this.phase %= TWO_PI;  // keep phase bounded over long runs
        }
        return out;
    }

    /**
     * Generate the complete FSK transmission for a sequence of bytes: channel
     * seizure, mark preamble, 8-N-1 data bytes, and a trailing mark.
     */
    generateTransmissionFromBytes(bytes) {
        this.phase = 0;
        const segments = [];

        // 1. Channel seizure: alternating space/mark (01010101...)
        for (let i = 0; i < this.CHANNEL_SEIZURE_BITS; i++) {
            segments.push({
                freq: (i % 2) ? this.MARK_FREQ : this.SPACE_FREQ,
                duration: this.BIT_DURATION
            });
        }

        // 2. Mark preamble (continuous 1200 Hz)
        segments.push({ freq: this.MARK_FREQ, duration: this.MARK_PREAMBLE_DURATION });

        // 3. Data bytes (8-N-1, LSB first)
        for (const byte of bytes) {
            for (const bit of this.encodeByte(byte)) {
                segments.push({
                    freq: bit ? this.MARK_FREQ : this.SPACE_FREQ,
                    duration: this.BIT_DURATION
                });
            }
        }

        // 4. Trailing mark
        segments.push({ freq: this.MARK_FREQ, duration: this.TRAILING_MARK_DURATION });

        return this.renderTones(segments);
    }

    /** Generate the FSK transmission for text (UTF-8 encoded). */
    generateTransmission(text) {
        return this.generateTransmissionFromBytes(encodeText(text));
    }

    /**
     * Sample offset of the first start bit within a transmission buffer
     * (i.e. the end of channel seizure + mark preamble). Matches the per-segment
     * rounding used by renderTones, so a demodulator can be pointed straight at
     * the data region.
     */
    dataStartSamples() {
        return this.CHANNEL_SEIZURE_BITS * this.samples(this.BIT_DURATION)
            + this.samples(this.MARK_PREAMBLE_DURATION);
    }

    /**
     * Mix "static on the line" into a buffer in place: gentle background hiss
     * plus impulsive noise bursts (crackles) whose rate scales with `level`
     * (0..1). Each burst is about one bit long, so it tends to corrupt a single
     * bit — the sparse error pattern FEC can repair. Soft-limited so it never
     * clips. Pass a seeded `rng` for reproducible results.
     */
    addNoise(buffer, level, rng = Math.random) {
        if (!level) return buffer;

        // Box-Muller standard normal.
        const gauss = () => {
            const u1 = Math.max(rng(), 1e-12);
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
        };

        const hissSigma = level * this.NOISE_HISS_SIGMA;
        const burstProb = level * this.NOISE_BURST_RATE;
        const burstLen = this.samples(this.BIT_DURATION);
        let burstRemaining = 0;

        for (let i = 0; i < buffer.length; i++) {
            let n = hissSigma * gauss();
            if (burstRemaining === 0 && rng() < burstProb) {
                burstRemaining = burstLen;
            }
            if (burstRemaining > 0) {
                n += this.NOISE_BURST_SIGMA * gauss();
                burstRemaining--;
            }
            buffer[i] += n;
        }
        return this.softLimit(buffer);
    }

    /** Concatenate multiple Float32Arrays into one. */
    concatenateSamples(arrays) {
        const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Float32Array(total);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    /**
     * Character display timings for the data region.
     * Returns { timings: [{char, startTime}], handshakeDuration, totalDuration }.
     */
    calculateCharacterTimings(text) {
        const handshakeDuration =
            this.CHANNEL_SEIZURE_BITS * this.BIT_DURATION + this.MARK_PREAMBLE_DURATION;
        const charDuration = 10 * this.BIT_DURATION;  // start + 8 data + stop

        const timings = [];
        let time = handshakeDuration;
        for (const char of text) {
            timings.push({ char, startTime: time });
            time += charDuration;
        }

        return {
            timings,
            handshakeDuration,
            totalDuration: time + this.TRAILING_MARK_DURATION
        };
    }

    // ---- Playback -----------------------------------------------------------

    /**
     * Transmit text as a real modem loopback over a (optionally noisy) line:
     *
     *   text -> CRC frame -> FEC -> FSK modulate -> + line noise -> play
     *        -> demodulate the SAME waveform -> FEC correct -> CRC check -> show
     *
     * The receiver decodes the actual audio, so under heavy noise the recovered
     * text really can differ from what was sent. `onCharacter(char, status)`
     * fires per recovered character (status: 'ok' | 'corrected' | 'error'),
     * driven off the audio clock. Resolves with — and reports via onDecodeStats
     * — a decode report.
     *
     * options: { phoneNumber, noiseLevel (0..1), fec (bool), rng }
     */
    async transmit(text, onCharacter, options = {}) {
        if (this.isTransmitting) {
            throw new Error('Already transmitting');
        }
        const { phoneNumber = '5551234', noiseLevel = 0, fec = true, rng } = options;

        await this.init();
        this.isTransmitting = true;
        if (this.onTransmitStart) this.onTransmitStart();

        // ---- Transmitter: frame + FEC + modulate ----
        const wire = _FEC.encodeFrame(encodeText(text), { fec });

        const parts = [];
        const events = [];
        let dialupDuration = 0;
        if (!this.isConnected) {
            const dialup = this.generateDialupSequence(phoneNumber);
            parts.push(dialup.samples);
            dialupDuration = dialup.totalDuration;
            for (const ev of dialup.events) {
                events.push({ time: ev.time, fn: () => this.onConnectionStatus && this.onConnectionStatus(ev.type) });
            }
        }
        const dialupSampleCount = parts.reduce((sum, a) => sum + a.length, 0);
        parts.push(this.generateTransmissionFromBytes(wire));
        const combined = this.concatenateSamples(parts);

        // ---- Channel: mix in line noise (mutates the buffer we both play AND decode) ----
        if (noiseLevel) this.addNoise(combined, noiseLevel, rng || Math.random);

        // ---- Receiver: demodulate the exact waveform, then FEC/CRC decode ----
        // The receiver syncs itself: all it gets is carrier onset (what a real
        // modem's carrier-detect provides), and it finds the preamble, the first
        // start bit, and the end of the message (via the frame's LEN field) on
        // its own — no borrowing the transmitter's segment arithmetic.
        const carrierOnset = dialupSampleCount;
        const synced = this.demodulator.findDataStart(combined, carrierOnset);
        const dataStartAbs = (synced >= 0) ? synced : carrierOnset + this.dataStartSamples();
        const { frames } = this.demodulator.demodulate(combined, dataStartAbs);
        const rxBytes = frames.map((f) => f.value);
        const framing = frames.map((f) => f.framingOk);
        const decoded = _FEC.decodeFrame(rxBytes, { fec, framing });
        const stats = this._buildDecodeStats(text, wire, rxBytes, decoded, fec, noiseLevel);
        this._decodeStats = stats;

        // ---- Schedule UI events on the audio clock ----
        const seizureDuration = this.CHANNEL_SEIZURE_BITS * this.BIT_DURATION;
        if (this.onCarrierDetect) {
            events.push({ time: dialupDuration + seizureDuration, fn: () => this.onCarrierDetect(true) });
        }
        if (onCharacter) {
            const per = fec ? 2 : 1;
            // A multi-byte character isn't readable until its last byte lands,
            // and it's only as healthy as the worst byte it's made of.
            for (const { char, firstByte, lastByte } of decodeTextWithSpans(decoded.payload)) {
                // Frame is [LEN_hi, LEN_lo, payload...], so payload byte b is
                // frame byte (2 + b); take the last codeword of it for reveal time.
                const wireIdx = (2 + lastByte + 1) * per - 1;
                const frame = frames[wireIdx];
                const time = frame
                    ? frame.center / this.sampleRate
                    : dataStartAbs / this.sampleRate + (wireIdx + 1) * 10 * this.BIT_DURATION;
                let status = 'ok';
                for (let b = firstByte; b <= lastByte; b++) {
                    status = _FEC.worstStatus(status, decoded.byteStatuses[b] || 'ok');
                }
                events.push({ time, fn: () => onCharacter(char, status) });
            }
        }
        events.sort((a, b) => a.time - b.time);

        // ---- Play the line audio ----
        const buffer = this.audioContext.createBuffer(1, combined.length, this.sampleRate);
        buffer.getChannelData(0).set(combined);
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);

        this._activeSource = source;
        this._events = events;
        this._eventIndex = 0;
        const startTime = this.audioContext.currentTime;
        const durationMs = (combined.length / this.sampleRate) * 1000;

        return new Promise((resolve) => {
            this._activeResolve = resolve;

            const tick = () => {
                if (!this.isTransmitting) return;  // aborted via stop()
                const elapsed = this.audioContext.currentTime - startTime;
                while (this._eventIndex < events.length && events[this._eventIndex].time <= elapsed) {
                    events[this._eventIndex++].fn();
                }
                if (this._eventIndex < events.length) {
                    this._frameId = requestFrame(tick);
                }
            };

            // Wall-clock backstop: if the audio clock never advances (e.g. a
            // suspended AudioContext) source.onended would never fire and this
            // promise would hang forever, wedging the caller's queue. Guarantee
            // completion regardless.
            this._backstopId = setTimeout(() => this._finishTransmission(), durationMs + 1000);

            source.onended = () => this._finishTransmission();
            source.start(startTime);
            this._frameId = requestFrame(tick);
        });
    }

    /** Assemble the decode report (also used by tests). */
    _buildDecodeStats(sentText, wire, rxBytes, decoded, fec, noiseLevel) {
        let bitErrors = 0;
        const n = Math.min(wire.length, rxBytes.length);
        for (let i = 0; i < n; i++) {
            let x = (wire[i] ^ rxBytes[i]) & 0xFF;
            while (x) { bitErrors += x & 1; x >>= 1; }
        }
        // Only a shortfall is an error: the receiver reads past the frame into
        // the trailing mark by design, and that junk isn't line damage.
        bitErrors += Math.max(0, wire.length - rxBytes.length) * 8;
        return {
            sent: sentText,
            decoded: decodeText(decoded.payload),
            fec,
            noiseLevel,
            bitErrors,
            corrected: decoded.corrected,
            uncorrectable: decoded.uncorrectable,
            framingErrors: decoded.framingErrors,
            truncated: decoded.truncated,
            crcOk: decoded.crcOk
        };
    }

    /** Natural completion: flush remaining events, emit stats, resolve. */
    _finishTransmission() {
        if (!this.isTransmitting) return;  // idempotent: onended + backstop may race
        if (this._events) {
            while (this._eventIndex < this._events.length) {
                this._events[this._eventIndex++].fn();
            }
        }
        this.isConnected = true;  // handshake done after first transmission
        const stats = this._decodeStats;
        if (stats && this.onDecodeStats) this.onDecodeStats(stats);
        this._teardown(stats);
    }

    /** Shared cleanup for both natural completion and stop(). */
    _teardown(result = null) {
        if (this._frameId !== null) {
            cancelFrame(this._frameId);
            this._frameId = null;
        }
        if (this._backstopId !== null && this._backstopId !== undefined) {
            clearTimeout(this._backstopId);
            this._backstopId = null;
        }
        if (this._activeSource) {
            this._activeSource.onended = null;
            try { this._activeSource.stop(); } catch (e) { /* already stopped */ }
            try { this._activeSource.disconnect(); } catch (e) { /* noop */ }
            this._activeSource = null;
        }
        this._events = null;
        this._eventIndex = 0;
        this._decodeStats = null;
        this.isTransmitting = false;

        if (this.onCarrierDetect) this.onCarrierDetect(false);
        if (this.onTransmitEnd) this.onTransmitEnd();

        const resolve = this._activeResolve;
        this._activeResolve = null;
        if (resolve) resolve(result);
    }

    /**
     * Stop the current transmission immediately (does NOT close the AudioContext,
     * so the next transmission starts instantly). Safe to call when idle.
     */
    stop() {
        if (!this.isTransmitting) return;
        this._teardown();
    }

    /**
     * Disconnect the modem (resets connection state). Aborts any in-flight
     * transmission so the next one replays the dial-up sequence.
     */
    disconnect() {
        this.stop();
        this.isConnected = false;
        if (this.onConnectionStatus) this.onConnectionStatus('disconnected');
    }
}

// Export for browser (script tag) and Node (tests).
if (typeof window !== 'undefined') window.Bell202Modem = Bell202Modem;
if (typeof module !== 'undefined' && module.exports) module.exports = Bell202Modem;
