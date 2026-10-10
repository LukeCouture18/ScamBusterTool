"""
A tiny in-process publish/subscribe event bus used to push live updates to the
browser via Server-Sent Events (SSE). No extra dependencies (no websockets
library needed) — SSE is plain HTTP, which Flask handles natively by streaming
a generator response.

Design:
- Each browser tab opens one long-lived GET /events connection.
- That connection registers a Queue with the bus and blocks reading from it.
- Any part of the program (the runner, the navigator, the pipeline, log
  handler) calls `publish(event_type, data)` and every connected browser tab
  receives it immediately.
- Queues are bounded and drop the oldest event on overflow rather than
  blocking the publisher — a slow/disconnected browser tab must never stall
  the scanner.
"""
import json
import queue
import threading
import time

_subscribers: list[queue.Queue] = []
_lock = threading.Lock()

MAX_QUEUE_SIZE = 200


def subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE_SIZE)
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: queue.Queue):
    with _lock:
        if q in _subscribers:
            _subscribers.remove(q)


def publish(event_type: str, data: dict):
    payload = {"type": event_type, "data": data, "ts": time.time()}
    with _lock:
        targets = list(_subscribers)
    for q in targets:
        try:
            q.put_nowait(payload)
        except queue.Full:
            # Slow consumer: drop the oldest event to make room rather than
            # blocking the publisher (which would stall the scanner itself).
            try:
                q.get_nowait()
                q.put_nowait(payload)
            except queue.Empty:
                pass


def format_sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def sse_stream():
    """Generator for a Flask streaming response. Yields SSE-formatted events forever."""
    q = subscribe()
    try:
        # Send an initial comment to open the stream promptly in some browsers/proxies.
        yield ": connected\n\n"
        while True:
            try:
                payload = q.get(timeout=15)
                yield format_sse(payload)
            except queue.Empty:
                yield ": keepalive\n\n"  # SSE comment line, ignored by EventSource, keeps connection open
    finally:
        unsubscribe(q)
