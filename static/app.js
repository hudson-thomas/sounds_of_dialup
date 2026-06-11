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
        this.txLed = document.getElementById('tx-led');
        this.rxLed = document.getElementById('rx-led');
        this.cdLed = document.getElementById('cd-led');
        this.linkStatus = document.getElementById('link-status');        // WebSocket transport
        this.connectionStatus = document.getElementById('connection-status');  // modem line state

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
        this.setupModemCallbacks();
        this.setupEventListeners();
        this.connectWebSocket();
        this.updateCursor();
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

        // Initialize audio context on first interaction
        document.addEventListener('click', async () => {
            await this.modem.init();
        }, { once: true });
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.isConnected = true;
            this.linkStatus.textContent = 'ONLINE';
            this.linkStatus.classList.add('online');
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
                this.queueTransmission(message.data);
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    sendMessage() {
        const text = this.input.value;
        if (!text || !this.isConnected) return;

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

        while (this.transmitQueue.length > 0) {
            const text = this.transmitQueue.shift();
            await this.receiveTransmission(text);
        }

        this.isProcessingQueue = false;
    }

    async receiveTransmission(text) {
        // Hide cursor during transmission
        this.setCursorVisible(false);

        // Transmit with audio, displaying each character as it's "received"
        await this.modem.transmit(text, (char) => {
            this.appendCharacter(char);
        });

        // Show cursor again
        this.setCursorVisible(true);
    }

    appendCharacter(char) {
        // Get the cursor element
        const cursor = this.output.querySelector('.cursor');

        // Create text node and insert before cursor
        const textNode = document.createTextNode(char);
        this.output.insertBefore(textNode, cursor);

        // Auto-scroll to bottom
        this.output.scrollTop = this.output.scrollHeight;
    }

    clearOutput() {
        // Remove all text nodes, keep cursor
        const cursor = this.output.querySelector('.cursor');
        this.output.innerHTML = '';
        this.output.appendChild(cursor);
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
