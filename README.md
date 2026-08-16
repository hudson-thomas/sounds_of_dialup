# Sounds of Dialup

A dial-up modem emulator that recreates the nostalgic sounds of Bell 202 modem communication in your browser.

This is a pet project, written with Claude Code.

## Demo

https://github.com/user-attachments/assets/afdc5943-5e51-462b-a287-0ff629da57c3

## Features

- Bell 202 modem audio emulation at 1200 baud (8-N-1)
- **Real modem loopback** — the receiver genuinely demodulates the FSK off the
  audio (Goertzel detector + UART clock recovery), it is not handed the text.
  It also finds the frame itself: all it gets is carrier onset, and it hunts
  down the mark preamble, the first start bit, and the end of the message
  (via the frame's own length field) from the waveform
- **Noisy line + error correction** — a LINE NOISE knob injects impulsive line
  static; Hamming(8,4) FEC repairs bit-flips and a CRC-16 flags what it can't.
  Toggle correction off to watch the same line shred the message — the receiver
  still reports the bytes whose UART framing collapsed, so damage stays visible
- **Full Unicode** — text goes on the wire as UTF-8, so accents, CJK, and emoji
  arrive intact; any mangling you see is the line, not the encoder
- Full dial-up handshake: dial tone, DTMF dialing, ringback, and V.34 negotiation screech
- Retro CRT monitor-style interface with scanlines
- Real-time transmission mode
- TX/RX/CD LED indicators and separate link / line status
- WebSocket-based communication



## Requirements

- Python 3.8+
- Modern web browser with Web Audio API support

## Installation

### Using pip

```bash
pip install -r requirements.txt
python server.py
```

### Using Docker

```bash
docker-compose up
```

Then open http://localhost:8000 in your browser.

## How It Works

The application consists of:

- A FastAPI server that handles WebSocket communication
- A browser-based Bell 202 modem emulator using the Web Audio API
- A retro-styled interface mimicking vintage terminal monitors

Type a message in the sender terminal and click SEND (or enable real-time mode) to hear the modem sounds as your message is transmitted and received.

## Tests

The browser DSP engine has a dependency-free test suite (requires Node 18+) covering
8-N-1 framing, the Goertzel demodulator, blind frame sync, Hamming/CRC error
correction, the UTF-8 text codec, transmit-queue coalescing, and the full
noisy-channel loopback (including the guarantee that a passing CRC never certifies
corrupted data):

```bash
node --test
```
