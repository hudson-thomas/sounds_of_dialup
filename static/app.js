/**
 * Dial-up Modem Emulator - Main Application
 *
 * Handles UI, WebSocket communication, and coordinates
 * between the Bell 202 audio engine and the display.
 */

class DialupEmulator {
    constructor() {
        // DOM elements
        this.input = document.getElementById('input');
        this.output = document.getElementById('output');
        this.sendBtn = document.getElementById('send-btn');
        this.clearBtn = document.getElementById('clear-btn');
        this.hangupBtn = document.getElementById('hangup-btn');
        this.realtimeMode = document.getElementById('realtime-mode');
        this.noiseLevel = document.getElementById('noise-level');
        this.noiseReadout = document.getElementById('noise-readout');
        this.fecMode = document.getElementById('fec-mode');
        this.decodeStats = document.getElementById('decode-stats');
        this.txLed = document.getElementById('tx-led');
        this.rxLed = document.getElementById('rx-led');
        this.cdLed = document.getElementById('cd-led');
        this.linkStatus = document.getElementById('link-status');        // WebSocket transport
        this.connectionStatus = document.getElementById('connection-status');  // modem line state
        this.debugStatus = document.getElementById('debug-status');      // diagnostics

        // Modem
        this.modem = new Bell202Modem();

        // WebSocket
        this.ws = null;

        // State
        this.isConnected = false;
        this.transmitQueue = [];
        this.isProcessingQueue = false;
        this.lastInputLength = 0;  // For real-time mode

        // Initialize
        this.init();
    }

    init() {
        this.setupDiagnostics();
        this.setupModemCallbacks();
        this.setupEventListeners();
        this.connectWebSocket();
        this.updateCursor();
    }

    // Surface what's happening (and any error) on-page, so failures are visible
    // without opening DevTools.
    debug(msg, isError = false) {
        if (this.debugStatus) {
            this.debugStatus.textContent = msg;
            this.debugStatus.style.color = isError ? '#ff5555' : '#777';
        }
        (isError ? console.error : console.log)('[dialup]', msg);
    }

    setupDiagnostics() {
        window.addEventListener('error', (e) => {
            this.debug(`JS error: ${e.message}`, true);
        });
        window.addEventListener('unhandledrejection', (e) => {
            this.debug(`promise rejection: ${e.reason && e.reason.message || e.reason}`, true);
        });
    }

    setupModemCallbacks() {
        this.modem.onTransmitStart = () => {
            this.txLed.classList.add('active');
        };

        this.modem.onTransmitEnd = () => {
            this.txLed.classList.remove('active');
            this.rxLed.classList.remove('active');
        };

        this.modem.onCarrierDetect = (detected) => {
            if (detected) {
                this.cdLed.classList.add('carrier');
                this.rxLed.classList.add('active');
            } else {
                this.cdLed.classList.remove('carrier');
            }
        };

        this.modem.onConnectionStatus = (status) => {
            this.updateConnectionDisplay(status);
        };

        this.modem.onDecodeStats = (stats) => {
            this.showDecodeStats(stats);
        };
    }

    showDecodeStats(stats) {
        const parts = [`${stats.bitErrors} bit err`];
        if (stats.fec) parts.push(`${stats.corrected} corrected`);
        if (stats.uncorrectable) parts.push(`${stats.uncorrectable} uncorrectable`);
        parts.push(stats.crcOk ? 'CRC OK' : 'CRC FAIL');
        this.decodeStats.textContent = parts.join(' · ');
        this.decodeStats.className = 'decode-stats ' + (stats.crcOk ? 'crc-ok' : 'crc-fail');
    }

    updateConnectionDisplay(status) {
        const statusMessages = {
            'dialTone': 'DIAL TONE...',
            'dialing': 'DIALING...',
            'ringing': 'RINGING...',
            'negotiating': 'NEGOTIATING...',
            'connected': 'CONNECTED @ 1200 BPS',
            'disconnected': 'DISCONNECTED'
        };

        const message = statusMessages[status] || status;
        this.connectionStatus.textContent = message;

        // Visual feedback for different states
        if (status === 'connected') {
            this.connectionStatus.classList.add('connected');
            this.cdLed.classList.add('carrier');
        } else if (status === 'disconnected') {
            this.connectionStatus.classList.remove('connected');
            this.cdLed.classList.remove('carrier');
        } else {
            // During dial-up sequence
            this.connectionStatus.classList.remove('connected');
        }
    }

    setupEventListeners() {
        // Send button
        this.sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });

        // Clear button
        this.clearBtn.addEventListener('click', () => {
            this.clearOutput();
        });

        // Hang up button - aborts any in-flight transmission, drops the line, and
        // clears the queue so the next message redials the full handshake.
        this.hangupBtn.addEventListener('click', () => {
            this.transmitQueue = [];
            this.modem.disconnect();
            this.clearOutput();
        });

        // Keyboard shortcut (Ctrl+Enter to send)
        this.input.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Real-time mode input handler
        this.input.addEventListener('input', () => {
            if (this.realtimeMode.checked) {
                this.handleRealtimeInput();
            }
        });

        // Line-noise slider readout
        this.noiseLevel.addEventListener('input', () => {
            this.noiseReadout.textContent = `${this.noiseLevel.value}%`;
        });

        // Unlock/resume the AudioContext on user gestures. Browser autoplay
        // policy keeps a context 'suspended' until a gesture resumes it, and a
        // context can be re-suspended later — so we (idempotently) resume on
        // every gesture, not just the first, otherwise transmissions that start
        // from a network callback would play to a stopped clock.
        const resumeAudio = () => this.modem.init();
        document.addEventListener('pointerdown', resumeAudio);
        document.addEventListener('keydown', resumeAudio);
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.isConnected = true;
            this.linkStatus.textContent = 'ONLINE';
            this.linkStatus.classList.add('online');
            this.debug('link up');
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            this.linkStatus.textContent = 'OFFLINE';
            this.linkStatus.classList.remove('online');

            // Attempt reconnection after delay
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'receive') {
                this.debug('echo received — queueing');
                this.queueTransmission(message.data);
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    sendMessage() {
        const text = this.input.value;
        if (!text) { this.debug('nothing to send'); return; }
        if (!this.isConnected) { this.debug('link OFFLINE — cannot send', true); return; }
        this.debug(`sending ${text.length} char(s)…`);

        // Resume audio inside this click gesture so the (network-callback-driven)
        // transmission later plays to a running clock.
        this.modem.init();

        // Send via WebSocket
        this.ws.send(JSON.stringify({
            type: 'transmit',
            data: text
        }));

        // Clear input
        this.input.value = '';
        this.lastInputLength = 0;
    }

    handleRealtimeInput() {
        const currentText = this.input.value;
        const currentLength = currentText.length;

        // Only send new characters
        if (currentLength > this.lastInputLength) {
            const newChars = currentText.substring(this.lastInputLength);

            if (this.isConnected) {
                this.ws.send(JSON.stringify({
                    type: 'transmit',
                    data: newChars
                }));
            }
        }

        this.lastInputLength = currentLength;
    }

    queueTransmission(text) {
        this.transmitQueue.push(text);
        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessingQueue || this.transmitQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;
        try {
            while (this.transmitQueue.length > 0) {
                const text = this.transmitQueue.shift();
                await this.receiveTransmission(text);
            }
        } finally {
            // Never leave the queue wedged, even if a transmission throws.
            this.isProcessingQueue = false;
        }
    }

    async receiveTransmission(text) {
        // Hide cursor during transmission
        this.setCursorVisible(false);

        // Send over the (optionally noisy) line; characters appear as the
        // receiver demodulates them, flagged by decode status.
        const options = {
            noiseLevel: parseInt(this.noiseLevel.value, 10) / 100,
            fec: this.fecMode.checked
        };
        try {
            const audioState = this.modem.audioContext ? this.modem.audioContext.state : 'no-context';
            this.debug(`receiving (audio:${audioState}, noise ${Math.round(options.noiseLevel * 100)}%, FEC ${options.fec ? 'on' : 'off'})…`);
            const stats = await this.modem.transmit(text, (char, status) => {
                this.appendCharacter(char, status);
            }, options);
            if (stats) this.debug(`done: ${stats.crcOk ? 'CRC OK' : 'CRC FAIL'}`);
        } catch (err) {
            this.debug(`transmit error: ${err && err.message || err}`, true);
        } finally {
            // Always restore the cursor so the UI never gets stuck mid-receive.
            this.setCursorVisible(true);
        }
    }

    appendCharacter(char, status = 'ok') {
        const cursor = this.output.querySelector('.cursor');

        // Plain text for clean characters; a styled span for corrected/errored
        // ones so line damage is visible.
        let node;
        if (status === 'ok') {
            node = document.createTextNode(char);
        } else {
            node = document.createElement('span');
            node.textContent = char;
            node.className = `ch-${status}`;
        }
        this.output.insertBefore(node, cursor);

        // Auto-scroll to bottom
        this.output.scrollTop = this.output.scrollHeight;
    }

    clearOutput() {
        // Remove all text nodes, keep cursor
        const cursor = this.output.querySelector('.cursor');
        this.output.innerHTML = '';
        this.output.appendChild(cursor);

        // Reset the decode report
        this.decodeStats.textContent = ' ';
        this.decodeStats.className = 'decode-stats';
    }

    setCursorVisible(visible) {
        const cursor = this.output.querySelector('.cursor');
        if (cursor) {
            cursor.style.display = visible ? 'inline-block' : 'none';
        }
    }

    updateCursor() {
        // Ensure cursor exists
        let cursor = this.output.querySelector('.cursor');
        if (!cursor) {
            cursor = document.createElement('span');
            cursor.className = 'cursor';
            this.output.appendChild(cursor);
        }
    }
}

// Start the application
document.addEventListener('DOMContentLoaded', () => {
    window.emulator = new DialupEmulator();
});
