"""Kalshi access for the bot: request signing, public REST reads, the signed websocket URL and, for live mode only
(bot/live.py), one signed order request. The order request is sent once and never retried.

Every REST call goes through one persistent httpx client (2026-11-18): the connection to Kalshi stays open between
calls (the bot reads the balance every 10 s, which keeps it in use), so an order does not pay for a new TCP + TLS
handshake. HTTP/2 is used when Kalshi's host offers it, HTTP/1.1 keep-alive otherwise.

The same responses give Kalshi's clock (the Date header), as the engine reads it (src/engine/feeds/kalshi.ts): `clock`
holds how far this PC's clock is from Kalshi's."""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import threading
import time
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Dict, Optional

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa

REST = 'https://external-api.kalshi.com/trade-api/v2'
WS = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2'
WS_PATH = '/trade-api/ws/v2'
KEEPALIVE_S = 60.0  # an idle connection is kept this long; the 10-second balance read keeps it in use


class Clock:
    """Kalshi's clock minus this PC's, in ms, from the Date header of REST responses. The header has 1-second
    resolution, so half a second is added (the engine does the same) and the value can be ~0.5 s off. It is replaced
    only on the first reading or when it moves by more than 2 s, so that noise does not make the clock jitter."""

    def __init__(self) -> None:
        self.offset_ms = 0.0
        self.synced = False
        self.at = 0.0  # local time of the last reading (seconds)

    def observe(self, date_header: Optional[str], started: float, ended: float) -> None:
        """`started` and `ended` are the local times (seconds) around the request."""
        if not date_header:
            return
        try:
            server_ms = parsedate_to_datetime(date_header).timestamp() * 1000
        except (TypeError, ValueError):
            return
        offset = server_ms + 500 - (started + ended) / 2 * 1000
        if not self.synced or abs(offset - self.offset_ms) > 2000:
            self.offset_ms = offset
        self.synced, self.at = True, ended

    def now(self) -> float:
        """Kalshi's time, in seconds."""
        return time.time() + self.offset_ms / 1000


clock = Clock()

_client: Optional[httpx.Client] = None
_client_lock = threading.Lock()


def client() -> httpx.Client:
    """The one connection pool, made on first use. Thread-safe: requests run on worker threads (asyncio.to_thread)."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = httpx.Client(
                    http2=importlib.util.find_spec('h2') is not None, follow_redirects=False,
                    timeout=httpx.Timeout(10.0, connect=5.0), headers={'Accept': 'application/json'},
                    limits=httpx.Limits(max_connections=4, max_keepalive_connections=4, keepalive_expiry=KEEPALIVE_S))
    return _client


def close() -> None:
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
            _client = None


def _send(method: str, path: str, headers: Optional[Dict[str, str]] = None, data: Optional[bytes] = None, timeout: Optional[float] = None) -> httpx.Response:
    """One request on the shared connection. Never retried here. Reads Kalshi's clock off the response."""
    if not path.startswith('/') or '://' in path:
        raise ValueError('invalid Kalshi API path')
    started = time.time()
    r = client().request(method, REST + path, headers=headers, content=data, **({} if timeout is None else {'timeout': timeout}))
    clock.observe(r.headers.get('date'), started, time.time())
    return r


class Signer:
    """Kalshi signs `timestamp_ms + METHOD + path` with the account's Ed25519 or RSA (PSS, SHA-256, 32-byte salt) key.
    The timestamp is on Kalshi's clock (this PC's time plus `clock.offset_ms`), as the engine signs."""

    def __init__(self, key_id: str, key_path: Path):
        self.key_id = key_id
        self.key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
        if not isinstance(self.key, (ed25519.Ed25519PrivateKey, rsa.RSAPrivateKey)):
            raise ValueError('Kalshi keys must be Ed25519 or RSA PEM')

    def headers(self, path: str, method: str = 'GET', now_ms: Optional[float] = None) -> Dict[str, str]:
        ts = str(int(round(time.time() * 1000 + clock.offset_ms if now_ms is None else now_ms)))
        text = (ts + method + path.split('?')[0]).encode()
        if isinstance(self.key, ed25519.Ed25519PrivateKey):
            sig = self.key.sign(text)
        else:
            sig = self.key.sign(text, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
        return {'KALSHI-ACCESS-KEY': self.key_id, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': base64.b64encode(sig).decode()}


def _get(path: str, timeout: float = 10.0) -> dict:
    """Public (unsigned) read. A read is safe to repeat, so a rate-limit answer is retried."""
    for attempt in range(5):
        r = _send('GET', path, timeout=timeout)
        if r.status_code != 429:
            r.raise_for_status()
            return r.json()
        time.sleep(min(8.0, 0.3 * 2 ** attempt))
    raise RuntimeError('Kalshi rate limit: retries exhausted')


class Refused(Exception):
    """Kalshi answered and did not take the order (HTTP 4xx), or the request never left this PC (status 0: no
    connection could be made). Either way nothing was bought."""

    def __init__(self, status: int, message: str):
        super().__init__(f'HTTP {status}: {message}' if status else message)
        self.status = status


def _signed(signer: Signer, method: str, path: str, body: Optional[dict] = None, timeout: float = 10.0) -> dict:
    """One signed request, never retried: an order is not idempotent, and a retry after a timeout could buy twice.
    Raises Refused when Kalshi clearly said no or the connection could not be made (nothing was sent); any other
    error means the outcome is not known."""
    if not path.startswith('/') or '://' in path:
        raise ValueError('invalid Kalshi API path')
    headers = dict(signer.headers('/trade-api/v2' + path, method))
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    try:
        r = _send(method, path, headers, data, timeout)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as e:
        raise Refused(0, f'no connection to Kalshi ({type(e).__name__}): the request was not sent') from None
    if 400 <= r.status_code < 500:
        try:
            err = r.json()
            err = err.get('error', err)
            message = str(err.get('message') or err.get('code') or 'no reason given')
        except Exception:
            message = 'no reason given'
        raise Refused(r.status_code, message)
    r.raise_for_status()
    return r.json()


async def post(signer: Signer, path: str, body: dict) -> dict:
    return await asyncio.to_thread(_signed, signer, 'POST', path, body)


async def signed_get(signer: Signer, path: str) -> dict:
    return await asyncio.to_thread(_signed, signer, 'GET', path)


async def get(path: str) -> dict:
    """Public (unsigned) GET, run off the event loop."""
    return await asyncio.to_thread(_get, path)
