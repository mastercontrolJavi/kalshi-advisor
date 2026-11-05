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
from .service import EdgeService

MAX_BODY = 64 * 1024


def log_json(data: dict) -> None:
    print(json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%S'), **data}, default=str), flush=True)


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
                        return self._send(200, service.tick(body))
                    if self.path == '/settle':
                        return self._send(200, service.settle(body))
                self._send(404, {'error': 'not found'})
            except (ValueError, KeyError, TypeError) as e:
                service.errors += 1
                self._send(400, {'error': str(e)})
            except Exception as e:  # never let one bad tick kill the sidecar
                service.errors += 1
                log_json({'event': 'edge-error', 'path': self.path, 'message': repr(e)})
                self._send(500, {'error': repr(e)})

        def log_message(self, *args) -> None:  # silence per-request access logs
            pass

    return Handler


def serve(cfg: Optional[EdgeConfig] = None) -> None:
    cfg = cfg or load_config()
    service = EdgeService(cfg, log=log_json)
    server = ThreadingHTTPServer((cfg.HOST, cfg.PORT), make_handler(service, threading.Lock()))
    log_json({'event': 'edge-start', 'host': cfg.HOST, 'port': cfg.PORT, 'db': cfg.DB_PATH, 'mode': cfg.MODE,
              'engine_validated': cfg.ENGINE_VALIDATED, 'blackouts': len(service.governor.blackouts), 'python': sys.version.split()[0]})
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log_json({'event': 'edge-stop'})
