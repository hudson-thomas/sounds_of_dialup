/**
 * Bell 202 Modem Audio Generator
 *
 * Implements authentic Bell 202 FSK modulation using Web Audio API.
 *
 * Specifications:
 * - Mark (1): 1200 Hz
 * - Space (0): 2200 Hz
 * - Baud rate: 1200 bps
 * - Bit duration: 833.33 microseconds
 * - Encoding: 8-N-1 (8 data bits, no parity, 1 stop bit)
 *
 * Handshake sequence (per Bellcore Caller ID spec):
 * 1. Channel seizure: 250ms of alternating 01010101 (300 bits)
 * 2. Mark preamble: 130ms of continuous 1200 Hz
 * 3. Data transmission
 */

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

        // Handshake timing (Bellcore spec)
        this.CHANNEL_SEIZURE_BITS = 300;        // 250ms at 1200 baud
        this.MARK_PREAMBLE_DURATION = 0.130;    // 130ms

        // Dial-up sequence frequencies
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
        this.V21_ORIGINATE_MARK = 1270;         // V.21 originate channel
        this.V21_ORIGINATE_SPACE = 1070;
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
        this.NEGOTIATION_DURATION = 3.0;        // 3 seconds of negotiation

        // State
        this.isTransmitting = false;
        this.isConnected = false;       // Has the dial-up handshake completed?
        this.phase = 0;  // For phase-continuous FSK

        // Callbacks
        this.onTransmitStart = null;
        this.onTransmitEnd = null;
        this.onCarrierDetect = null;
        this.onConnectionStatus = null; // Called with status updates during dial-up
    }

    /**
     * Initialize audio context (must be called from user gesture)
     */
    async init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        return this;
    }

    /**
     * Generate samples for a tone at given frequency, maintaining phase continuity
     */
    generateToneSamples(frequency, duration) {
        const numSamples = Math.round(duration * this.sampleRate);
        const samples = new Float32Array(numSamples);
        const angularFreq = 2 * Math.PI * frequency / this.sampleRate;

        for (let i = 0; i < numSamples; i++) {
            samples[i] = Math.sin(this.phase);
            this.phase += angularFreq;
        }

        // Keep phase in reasonable range to avoid floating point issues
        this.phase = this.phase % (2 * Math.PI);

        return samples;
    }

    /**
     * Render a list of FSK tone segments into a single buffer in one pass.
     * Each segment is {freq, duration}. Phase is carried continuously across
     * segments (this.phase) so there are no discontinuities between tones.
     *
     * This avoids allocating a separate Float32Array per bit and the repeated
     * concatenation passes the old per-bit/per-byte helpers required.
     */
    renderTones(segments) {
        const lengths = segments.map(s => Math.round(s.duration * this.sampleRate));
        const total = lengths.reduce((sum, n) => sum + n, 0);
        const out = new Float32Array(total);

        let offset = 0;
        for (let s = 0; s < segments.length; s++) {
            const angularFreq = 2 * Math.PI * segments[s].freq / this.sampleRate;
            for (let i = 0; i < lengths[s]; i++) {
                out[offset++] = Math.sin(this.phase);
                this.phase += angularFreq;
            }
            // Keep phase bounded to avoid floating point growth over long runs
            this.phase %= 2 * Math.PI;
        }

        return out;
    }

    /**
     * Generate dual-tone samples (for dial tone, ringback, DTMF)
     */
    generateDualToneSamples(freq1, freq2, duration, amplitude = 0.5) {
        const numSamples = Math.round(duration * this.sampleRate);
        const samples = new Float32Array(numSamples);
        const angularFreq1 = 2 * Math.PI * freq1 / this.sampleRate;
        const angularFreq2 = 2 * Math.PI * freq2 / this.sampleRate;

        for (let i = 0; i < numSamples; i++) {
            // Combine two sine waves at half amplitude each
            samples[i] = amplitude * (Math.sin(i * angularFreq1) + Math.sin(i * angularFreq2));
        }

        return samples;
    }

    /**
     * Generate silence
     */
    generateSilence(duration) {
        const numSamples = Math.round(duration * this.sampleRate);
        return new Float32Array(numSamples);
    }

    /**
     * Generate dial tone (350 Hz + 440 Hz)
     */
    generateDialTone(duration = null) {
        duration = duration || this.DIAL_TONE_DURATION;
        return this.generateDualToneSamples(
            this.DIAL_TONE_FREQ1,
            this.DIAL_TONE_FREQ2,
            duration,
            0.3
        );
    }

    /**
     * Generate DTMF tone for a single digit
     */
    generateDTMFDigit(digit) {
        const mapping = this.DTMF_MAP[digit];
        if (!mapping) return this.generateSilence(this.DTMF_TONE_DURATION);

        const freq1 = this.DTMF_ROW[mapping[0]];
        const freq2 = this.DTMF_COL[mapping[1]];

        return this.generateDualToneSamples(freq1, freq2, this.DTMF_TONE_DURATION, 0.4);
    }

    /**
     * Generate DTMF sequence for a phone number
     */
    generateDTMFSequence(phoneNumber) {
        const allSamples = [];

        for (const digit of phoneNumber) {
            if (this.DTMF_MAP[digit]) {
                allSamples.push(this.generateDTMFDigit(digit));
                allSamples.push(this.generateSilence(this.DTMF_PAUSE_DURATION));
            }
        }

        return this.concatenateSamples(allSamples);
    }

    /**
     * Generate ringback tone with proper cadence (2s on, 4s off)
     */
    generateRingback(cycles = null) {
        cycles = cycles || this.RING_CYCLES;
        const allSamples = [];

        for (let i = 0; i < cycles; i++) {
            // Ring on
            allSamples.push(this.generateDualToneSamples(
                this.RINGBACK_FREQ1,
                this.RINGBACK_FREQ2,
                this.RINGBACK_ON_DURATION,
                0.3
            ));
            // Ring off (silence) - skip on last cycle
            if (i < cycles - 1) {
                allSamples.push(this.generateSilence(this.RINGBACK_OFF_DURATION));
            }
        }

        return this.concatenateSamples(allSamples);
    }

    /**
     * Generate ANSam tone (2100 Hz with 15 Hz amplitude modulation + phase reversals)
     * This is the proper ITU-T V.8 answer tone
     */
    generateAnswerTone(duration = null) {
        duration = duration || this.ANSWER_TONE_DURATION;
        const numSamples = Math.round(duration * this.sampleRate);
        const samples = new Float32Array(numSamples);

        const carrierFreq = this.ANSWER_TONE_FREQ;
        const amFreq = 15;  // 15 Hz amplitude modulation
        const amDepth = 0.2;  // 20% modulation depth per ITU-T

        // Phase reversal every 450ms
        const reversalInterval = Math.round(0.45 * this.sampleRate);
        let phase = 0;
        let phaseOffset = 0;

        for (let i = 0; i < numSamples; i++) {
            // Check for phase reversal
            if (i > 0 && i % reversalInterval === 0) {
                phaseOffset += Math.PI;  // 180° phase reversal
            }

            // Amplitude modulation envelope
            const amEnvelope = 1 - amDepth + amDepth * Math.sin(2 * Math.PI * amFreq * i / this.sampleRate);

            phase += 2 * Math.PI * carrierFreq / this.sampleRate;
            samples[i] = 0.4 * amEnvelope * Math.sin(phase + phaseOffset);
        }

        return samples;
    }

    /**
     * Generate pure tone with phase reversals (for A/B signals)
     */
    generateToneWithPhaseReversals(freq, duration, reversalInterval = 0.45) {
        const numSamples = Math.round(duration * this.sampleRate);
        const samples = new Float32Array(numSamples);
        const reversalSamples = Math.round(reversalInterval * this.sampleRate);

        let phase = 0;
        let phaseOffset = 0;

        for (let i = 0; i < numSamples; i++) {
            if (i > 0 && i % reversalSamples === 0) {
                phaseOffset += Math.PI;
            }
            phase += 2 * Math.PI * freq / this.sampleRate;
            samples[i] = 0.4 * Math.sin(phase + phaseOffset);
        }

        return samples;
    }

    /**
     * Generate V.21 handshake tones (low-speed channel establishment)
     */
    generateV21Handshake(duration = 0.5) {
        const allSamples = [];
        const bitDuration = 1 / 300; // V.21 is 300 baud

        // Generate alternating pattern on answer channel
        const numBits = Math.round(duration / bitDuration);
        for (let i = 0; i < numBits; i++) {
            const freq = (i % 2 === 0) ? this.V21_ANSWER_MARK : this.V21_ANSWER_SPACE;
            const numSamples = Math.round(bitDuration * this.sampleRate);
            const samples = new Float32Array(numSamples);
            const angularFreq = 2 * Math.PI * freq / this.sampleRate;

            for (let j = 0; j < numSamples; j++) {
                samples[j] = 0.5 * Math.sin(this.phase);
                this.phase += angularFreq;
            }
            this.phase = this.phase % (2 * Math.PI);
            allSamples.push(samples);
        }

        return this.concatenateSamples(allSamples);
    }

    /**
     * Simple pseudo-random number generator (for deterministic scrambling)
     */
    scrambleBit(lfsr) {
        // 15-bit LFSR with taps at 15 and 14 (V.34 style scrambler)
        const bit = ((lfsr >> 14) ^ (lfsr >> 13)) & 1;
        return ((lfsr << 1) | bit) & 0x7FFF;
    }

    /**
     * Generate V.34 line probing signal - 21 tones across the spectrum
     */
    generateLineProbing(duration = 0.5) {
        const numSamples = Math.round(duration * this.sampleRate);
        const samples = new Float32Array(numSamples);

        // V.34 probing uses tones from ~150 Hz to ~3750 Hz
        // 21 tones spaced across the telephone bandwidth
        const probeTones = [];
        for (let i = 0; i < 21; i++) {
            probeTones.push(150 + i * 171);  // ~150 to ~3750 Hz
        }

        const phases = probeTones.map(() => Math.random() * 2 * Math.PI);

        for (let i = 0; i < numSamples; i++) {
            let sample = 0;
            for (let t = 0; t < probeTones.length; t++) {
                phases[t] += 2 * Math.PI * probeTones[t] / this.sampleRate;
                sample += Math.sin(phases[t]);
            }
            samples[i] = 0.08 * sample;
        }

        return samples;
    }

    /**
     * Generate scrambled training - QAM-like signal at given carrier
     */
    generateScrambledTraining(duration, carrierFreq, symbolRate = 2400) {
        const numSamples = Math.round(duration * this.sampleRate);
        const samples = new Float32Array(numSamples);
        const samplesPerSymbol = Math.round(this.sampleRate / symbolRate);

        let lfsr = 0x5A5A;
        let phase = 0;
        let currentPhase = 0;

        for (let i = 0; i < numSamples; i++) {
            if (i % samplesPerSymbol === 0) {
                lfsr = this.scrambleBit(lfsr);
                // 8-PSK style phase shifts
                currentPhase = ((lfsr & 0x7) / 8) * 2 * Math.PI;
            }
            phase += 2 * Math.PI * carrierFreq / this.sampleRate;
            samples[i] = 0.4 * Math.sin(phase + currentPhase);
        }

        return samples;
    }

    /**
     * Generate the V.34 modem negotiation sequence
     * Based on ITU-T V.34 specification phases
     */
    generateModemNegotiation() {
        const allSamples = [];

        // Phase 1: ANSam - Answer tone with AM and phase reversals (2100 Hz)
        // The characteristic "warbly" answering sound
        allSamples.push(this.generateAnswerTone(2.0));

        // Phase 2: V.21 low channel - short FSK bursts for capability exchange
        allSamples.push(this.generateV21Handshake(0.2));
        allSamples.push(this.generateSilence(0.05));

        // Phase 2 continued: INFO sequences at 600 bps DPSK
        // Sounds like low-pitched warble
        allSamples.push(this.generateScrambledTraining(0.3, 600, 600));

        // Phase 2: L1/L2 Line probing - 21 tones test the line
        // Creates a harsh broadband sound
        allSamples.push(this.generateLineProbing(0.8));

        // Phase 2: A signal - 2400 Hz with phase reversals
        allSamples.push(this.generateToneWithPhaseReversals(2400, 0.3));

        // Phase 2: B signal - 1200 Hz with phase reversals
        allSamples.push(this.generateToneWithPhaseReversals(1200, 0.2));

        // Phase 3: Equalizer training (TRN) - scrambled ones at 1800 Hz carrier
        // This is the main "screech" - sounds like harsh static
        allSamples.push(this.generateScrambledTraining(1.5, 1800, 3000));

        // Phase 4: Final training - higher symbol rate
        // Slightly different pitch as rate increases
        allSamples.push(this.generateScrambledTraining(0.8, 1800, 3200));

        // Final J pattern and sync - brief pure tones
        allSamples.push(this.generateToneSamples(1800, 0.1));
        allSamples.push(this.generateSilence(0.05));

        return this.concatenateSamples(allSamples);
    }

    /**
     * Generate complete dial-up connection sequence
     * Returns samples and timing info for UI synchronization
     */
    generateDialupSequence(phoneNumber = '5551234') {
        const allSamples = [];
        const events = [];
        let currentTime = 0;

        // 1. Dial tone
        events.push({ type: 'dialTone', time: currentTime });
        const dialTone = this.generateDialTone();
        allSamples.push(dialTone);
        currentTime += this.DIAL_TONE_DURATION;

        // 2. DTMF dialing
        events.push({ type: 'dialing', time: currentTime });
        const dtmfDuration = phoneNumber.length * (this.DTMF_TONE_DURATION + this.DTMF_PAUSE_DURATION);
        allSamples.push(this.generateDTMFSequence(phoneNumber));
        currentTime += dtmfDuration;

        // Brief silence after dialing
        allSamples.push(this.generateSilence(0.5));
        currentTime += 0.5;

        // 3. Ringback
        events.push({ type: 'ringing', time: currentTime });
        const ringback = this.generateRingback();
        allSamples.push(ringback);
        currentTime += this.RINGBACK_ON_DURATION;

        // Silence after pickup
        allSamples.push(this.generateSilence(0.3));
        currentTime += 0.3;

        // 4. Modem negotiation
        events.push({ type: 'negotiating', time: currentTime });
        const negotiation = this.generateModemNegotiation();
        allSamples.push(negotiation);
        currentTime += negotiation.length / this.sampleRate;

        // 5. Connected
        events.push({ type: 'connected', time: currentTime });

        return {
            samples: this.concatenateSamples(allSamples),
            events: events,
            totalDuration: currentTime
        };
    }

    /**
     * Encode a single byte using 8-N-1 format
     * Returns array of 10 bits: [start, d0, d1, d2, d3, d4, d5, d6, d7, stop]
     */
    encodeByte(byte) {
        const bits = [];

        // Start bit (always 0/space)
        bits.push(0);

        // 8 data bits, LSB first
        for (let i = 0; i < 8; i++) {
            bits.push((byte >> i) & 1);
        }

        // Stop bit (always 1/mark)
        bits.push(1);

        return bits;
    }

    /**
     * Concatenate multiple Float32Arrays
     */
    concatenateSamples(arrays) {
        const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Float32Array(totalLength);
        let offset = 0;

        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }

        return result;
    }

    /**
     * Generate complete transmission audio for text
     * Includes handshake + data
     */
    generateTransmission(text) {
        // Reset phase for new transmission
        this.phase = 0;

        const segments = [];

        // 1. Channel seizure: 300 bits of alternating space/mark (01010101...)
        for (let i = 0; i < this.CHANNEL_SEIZURE_BITS; i++) {
            segments.push({
                freq: (i % 2) ? this.MARK_FREQ : this.SPACE_FREQ,
                duration: this.BIT_DURATION
            });
        }

        // 2. Mark preamble (130ms of continuous 1200 Hz)
        segments.push({ freq: this.MARK_FREQ, duration: this.MARK_PREAMBLE_DURATION });

        // 3. Data bytes (8-N-1, LSB first)
        for (const char of text) {
            for (const bit of this.encodeByte(char.charCodeAt(0))) {
                segments.push({
                    freq: bit ? this.MARK_FREQ : this.SPACE_FREQ,
                    duration: this.BIT_DURATION
                });
            }
        }

        // 4. Trailing mark (brief carrier sustain)
        segments.push({ freq: this.MARK_FREQ, duration: 0.050 });

        return this.renderTones(segments);
    }

    /**
     * Calculate timing for character display synchronization
     * Returns array of {char, startTime} objects
     */
    calculateCharacterTimings(text) {
        const timings = [];

        // Handshake duration
        const channelSeizureDuration = this.CHANNEL_SEIZURE_BITS * this.BIT_DURATION;
        const handshakeDuration = channelSeizureDuration + this.MARK_PREAMBLE_DURATION;

        // Each character is 10 bits (start + 8 data + stop)
        const charDuration = 10 * this.BIT_DURATION;

        let currentTime = handshakeDuration;

        for (const char of text) {
            timings.push({
                char: char,
                startTime: currentTime
            });
            currentTime += charDuration;
        }

        return {
            timings: timings,
            handshakeDuration: handshakeDuration,
            totalDuration: currentTime + 0.050  // Include trailing mark
        };
    }

    /**
     * Transmit text with audio
     * Returns a promise that resolves when transmission is complete
     * If not connected, plays full dial-up handshake first
     */
    async transmit(text, onCharacter, phoneNumber = '5551234') {
        if (this.isTransmitting) {
            throw new Error('Already transmitting');
        }

        await this.init();
        this.isTransmitting = true;

        if (this.onTransmitStart) {
            this.onTransmitStart();
        }

        const allSamples = [];
        let dialupDuration = 0;

        // If not connected, generate dial-up sequence first
        if (!this.isConnected) {
            const dialup = this.generateDialupSequence(phoneNumber);
            allSamples.push(dialup.samples);
            dialupDuration = dialup.totalDuration;

            // Schedule connection status callbacks
            if (this.onConnectionStatus) {
                for (const event of dialup.events) {
                    setTimeout(() => {
                        this.onConnectionStatus(event.type);
                    }, event.time * 1000);
                }
            }
        }

        // Generate data transmission audio
        const dataSamples = this.generateTransmission(text);
        allSamples.push(dataSamples);

        // Calculate character timings (offset by dialup duration)
        const timings = this.calculateCharacterTimings(text);

        // Combine all audio
        const combinedSamples = this.concatenateSamples(allSamples);

        // Create audio buffer
        const buffer = this.audioContext.createBuffer(1, combinedSamples.length, this.sampleRate);
        buffer.getChannelData(0).set(combinedSamples);

        // Create and start source
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);

        const startTime = this.audioContext.currentTime;
        source.start(startTime);

        // Signal carrier detect after channel seizure (offset by dialup duration)
        if (this.onCarrierDetect) {
            const channelSeizureDuration = this.CHANNEL_SEIZURE_BITS * this.BIT_DURATION;
            setTimeout(() => {
                this.onCarrierDetect(true);
            }, (dialupDuration + channelSeizureDuration) * 1000);
        }

        // Schedule character callbacks (offset by dialup duration)
        if (onCharacter) {
            for (const timing of timings.timings) {
                setTimeout(() => {
                    onCharacter(timing.char);
                }, (dialupDuration + timing.startTime) * 1000);
            }
        }

        // Calculate total duration
        const totalDuration = dialupDuration + timings.totalDuration;

        // Return promise that resolves when done
        return new Promise((resolve) => {
            setTimeout(() => {
                this.isTransmitting = false;
                this.isConnected = true;  // Mark as connected after first transmission
                if (this.onCarrierDetect) {
                    this.onCarrierDetect(false);
                }
                if (this.onTransmitEnd) {
                    this.onTransmitEnd();
                }
                resolve();
            }, totalDuration * 1000);
        });
    }

    /**
     * Disconnect the modem (resets connection state)
     * Next transmission will play dial-up sequence again
     */
    disconnect() {
        this.isConnected = false;
        if (this.onConnectionStatus) {
            this.onConnectionStatus('disconnected');
        }
    }

    /**
     * Stop any current transmission
     */
    stop() {
        this.isTransmitting = false;
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
}

// Export for use in app.js
window.Bell202Modem = Bell202Modem;
