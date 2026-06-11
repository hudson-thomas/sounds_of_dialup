"""
Dial-up Modem Emulator - FastAPI Server
Serves the web app and handles WebSocket communication for modem simulation.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import json

app = FastAPI(title="Dial-up Modem Emulator")

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for real-time modem communication.
    Currently local-only: receives text from sender, echoes back for receiver.
    Future: Could route between different connected clients.
    """
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()

            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                continue  # ignore malformed frames

            if message.get("type") == "transmit":
                # Echo back the data to be "received".
                # In future, this could route to another connected client.
                await websocket.send_text(json.dumps({
                    "type": "receive",
                    "data": message.get("data", "")
                }))
    except WebSocketDisconnect:
        pass  # Client disconnected cleanly


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
