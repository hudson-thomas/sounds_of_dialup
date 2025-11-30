# Sounds of Dialup

A dial-up modem emulator that recreates the nostalgic sounds of Bell 202 modem communication in your browser.

This is a pet project, written with Claude Code.

## Demo

https://github.com/user-attachments/assets/sounds_of_dialup_v0.1_demo.mp4

[View Demo Video](docs/sounds_of_dialup_v0.1_demo.mp4)

## Features

- Bell 202 modem audio emulation at 1200 baud
- Retro CRT monitor-style interface with scanlines
- Real-time transmission mode
- TX/RX/CD LED indicators
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
