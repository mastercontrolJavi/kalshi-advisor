"""Local HTTP for the engine: POST /tick (one snapshot per second -> decision JSON), POST /settle, GET /health,
GET /state (last decision). Loopback only; one lock serialises the service so SQLite sees a single writer."""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from .config import EdgeConfig, load_config
from .risk import blackout_horizon_warning
from .service import EdgeService

MAX_BODY = 64 * 1024


def log_json(data: dict) -> None:
    print(json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%S'), **data}, default=str), flush=True)


def lower_priority() -> str:
    """Below-normal CPU priority (Windows BELOW_NORMAL_PRIORITY_CLASS, POSIX nice +5): the sidecar gets the CPU only
    after the engine and your foreground apps. Deliberately not EcoQoS / efficiency mode: that throttles the clock and
    could push a tick past the engine's 300 ms timeout."""
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes as w
            k = ctypes.WinDLL('kernel32', use_last_error=True)
            # Typed: untyped ctypes truncates the 64-bit process handle and the call silently fails.
            k.GetCurrentProcess.restype = w.HANDLE
            k.SetPriorityClass.argtypes, k.SetPriorityClass.restype = [w.HANDLE, w.DWORD], w.BOOL
            k.GetPriorityClass.argtypes, k.GetPriorityClass.restype = [w.HANDLE], w.DWORD
            h = k.GetCurrentProcess()
            ok = k.SetPriorityClass(h, 0x00004000) and k.GetPriorityClass(h) == 0x00004000
            return 'below-normal' if ok else f'unchanged (SetPriorityClass error {ctypes.get_last_error()})'
        import os
        os.nice(5)
        return 'nice +5'
    except Exception as e:  # never fail startup over priority
        return f'unchanged ({e!r})'


def make_handler(service: EdgeService, lock: threading.Lock):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0 or n > MAX_BODY:
                raise ValueError('body missing or too large')
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict):
                raise ValueError('body must be a JSON object')
            return data

        def do_GET(self) -> None:  # noqa: N802
            with lock:
                if self.path == '/health':
                    return self._send(200, service.health())
                if self.path == '/state':
                    return self._send(200, service.last_response or {'status': 'IDLE'})
            self._send(404, {'error': 'not found'})

        def do_POST(self) -> None:  # noqa: N802
            try:
                body = self._body()
                with lock:
                    if self.path == '/tick':
                        started = time.perf_counter()
                        reply = service.tick(body)
                        service.record_ms((time.perf_counter() - started) * 1000)
                        return self._send(200, reply)
                    if self.path == '/settle':
                        return self._send(200, service.settle(body))
                self._send(404, {'error': 'not found'})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # The engine gave up waiting (its 300 ms timeout) and closed the connection: a dropped reply, not a fault.
                service.aborted += 1
            except (ValueError, KeyError, TypeError) as e:
                service.note_error(self.path, 400, str(e))
                self._send(400, {'error': str(e)})
            except Exception as e:  # never let one bad tick kill the sidecar
                service.note_error(self.path, 500, repr(e))
                log_json({'event': 'edge-error', 'path': self.path, 'message': repr(e)})
                self._send(500, {'error': repr(e)})

        def handle(self) -> None:
            # The engine closes kept-alive connections when it times out or restarts; that reset is expected, not a fault.
            try:
                super().handle()
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                service.aborted += 1

        def log_message(self, *args) -> None:  # silence per-request access logs
            pass

    return Handler


class _Server(ThreadingHTTPServer):
    # http.server sets SO_REUSEADDR, which on Windows lets a second sidecar bind a port an orphaned one still holds (two
    # writers on edge.db, requests split between them). Fail to bind instead; the launcher restarts with backoff.
    allow_reuse_address = sys.platform != 'win32'


def serve(cfg: Optional[EdgeConfig] = None) -> None:
    cfg = cfg or load_config()
    priority = lower_priority() if cfg.PRIORITY == 'low' else 'normal'
    service = EdgeService(cfg, log=log_json)
    server = _Server((cfg.HOST, cfg.PORT), make_handler(service, threading.Lock()))
    log_json({'event': 'edge-start', 'host': cfg.HOST, 'port': cfg.PORT, 'db': cfg.DB_PATH, 'mode': cfg.MODE,
              'engine_validated': cfg.ENGINE_VALIDATED, 'blackouts': len(service.governor.blackouts), 'python': sys.version.split()[0],
              'priority': priority, 'bankroll': cfg.BANKROLL})
    warning = blackout_horizon_warning(service.governor.blackouts, time.time())
    if warning:
        log_json({'event': 'edge-warning', 'message': warning})
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log_json({'event': 'edge-stop'})
