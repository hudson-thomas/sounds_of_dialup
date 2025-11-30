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

        // State
        this.isTransmitting = false;
        this.phase = 0;  // For phase-continuous FSK

        // Callbacks
        this.onBitTransmit = null;      // Called for each bit
        this.onByteTransmit = null;     // Called for each byte
        this.onTransmitStart = null;
        this.onTransmitEnd = null;
        this.onCarrierDetect = null;
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
     * Generate FSK samples for a single bit
     */
    generateBitSamples(bit) {
        const freq = bit ? this.MARK_FREQ : this.SPACE_FREQ;
        return this.generateToneSamples(freq, this.BIT_DURATION);
    }

    /**
     * Generate channel seizure signal (alternating 01010101 pattern)
     * This is 300 bits per Bellcore spec
     */
    generateChannelSeizure() {
        const allSamples = [];

        for (let i = 0; i < this.CHANNEL_SEIZURE_BITS; i++) {
            // Alternating 0 and 1, starting with 0
            const bit = i % 2;
            allSamples.push(this.generateBitSamples(bit));
        }

        return this.concatenateSamples(allSamples);
    }

    /**
     * Generate mark preamble (continuous 1200 Hz)
     */
    generateMarkPreamble() {
        return this.generateToneSamples(this.MARK_FREQ, this.MARK_PREAMBLE_DURATION);
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
     * Generate audio samples for a byte
     */
    generateByteSamples(byte) {
        const bits = this.encodeByte(byte);
        const allSamples = [];

        for (const bit of bits) {
            allSamples.push(this.generateBitSamples(bit));
        }

        return this.concatenateSamples(allSamples);
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

        const allSamples = [];

        // 1. Channel seizure (250ms alternating pattern)
        allSamples.push(this.generateChannelSeizure());

        // 2. Mark preamble (130ms of 1200 Hz)
        allSamples.push(this.generateMarkPreamble());

        // 3. Data bytes
        for (const char of text) {
            const byte = char.charCodeAt(0);
            allSamples.push(this.generateByteSamples(byte));
        }

        // 4. Trailing mark (brief carrier sustain)
        allSamples.push(this.generateToneSamples(this.MARK_FREQ, 0.050));

        return this.concatenateSamples(allSamples);
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
     */
    async transmit(text, onCharacter) {
        if (this.isTransmitting) {
            throw new Error('Already transmitting');
        }

        await this.init();
        this.isTransmitting = true;

        if (this.onTransmitStart) {
            this.onTransmitStart();
        }

        // Generate audio
        const samples = this.generateTransmission(text);
        const timings = this.calculateCharacterTimings(text);

        // Create audio buffer
        const buffer = this.audioContext.createBuffer(1, samples.length, this.sampleRate);
        buffer.getChannelData(0).set(samples);

        // Create and start source
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);

        const startTime = this.audioContext.currentTime;
        source.start(startTime);

        // Signal carrier detect after channel seizure
        if (this.onCarrierDetect) {
            const channelSeizureDuration = this.CHANNEL_SEIZURE_BITS * this.BIT_DURATION;
            setTimeout(() => {
                this.onCarrierDetect(true);
            }, channelSeizureDuration * 1000);
        }

        // Schedule character callbacks
        if (onCharacter) {
            for (const timing of timings.timings) {
                setTimeout(() => {
                    onCharacter(timing.char);
                }, timing.startTime * 1000);
            }
        }

        // Return promise that resolves when done
        return new Promise((resolve) => {
            setTimeout(() => {
                this.isTransmitting = false;
                if (this.onCarrierDetect) {
                    this.onCarrierDetect(false);
                }
                if (this.onTransmitEnd) {
                    this.onTransmitEnd();
                }
                resolve();
            }, timings.totalDuration * 1000);
        });
    }

    /**
     * Get transmission duration for text (for progress indication)
     */
    getTransmissionDuration(text) {
        const timings = this.calculateCharacterTimings(text);
        return timings.totalDuration;
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
