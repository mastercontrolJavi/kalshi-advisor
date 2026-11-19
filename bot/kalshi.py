"""Kalshi access for the bot: request signing, public REST reads, the signed websocket URL and, for live mode only
(bot/live.py), one signed order request. The order request is sent once and never retried."""
from __future__ import annotations

import asyncio
import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa

REST = 'https://external-api.kalshi.com/trade-api/v2'
WS = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2'
WS_PATH = '/trade-api/ws/v2'


class Signer:
    """Kalshi signs `timestamp_ms + METHOD + path` with the account's Ed25519 or RSA (PSS, SHA-256, 32-byte salt) key."""

    def __init__(self, key_id: str, key_path: Path):
        self.key_id = key_id
        self.key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
        if not isinstance(self.key, (ed25519.Ed25519PrivateKey, rsa.RSAPrivateKey)):
            raise ValueError('Kalshi keys must be Ed25519 or RSA PEM')

    def headers(self, path: str, method: str = 'GET', now_ms: Optional[float] = None) -> Dict[str, str]:
        ts = str(int(round(time.time() * 1000 if now_ms is None else now_ms)))
        text = (ts + method + path.split('?')[0]).encode()
        if isinstance(self.key, ed25519.Ed25519PrivateKey):
            sig = self.key.sign(text)
        else:
            sig = self.key.sign(text, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
        return {'KALSHI-ACCESS-KEY': self.key_id, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': base64.b64encode(sig).decode()}


def _get(path: str, timeout: float = 10.0) -> dict:
    if not path.startswith('/') or '://' in path:
        raise ValueError('invalid Kalshi API path')
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(REST + path, headers={'Accept': 'application/json'}), timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(min(8.0, 0.3 * 2 ** attempt))
    raise RuntimeError('Kalshi rate limit: retries exhausted')


class Refused(Exception):
    """Kalshi answered and did not take the order (HTTP 4xx): nothing was bought."""

    def __init__(self, status: int, message: str):
        super().__init__(f'HTTP {status}: {message}')
        self.status = status


def _signed(signer: Signer, method: str, path: str, body: Optional[dict] = None, timeout: float = 10.0) -> dict:
    """One signed request, never retried: an order is not idempotent, and a retry after a timeout could buy twice.
    Raises Refused when Kalshi clearly said no; any other error means the outcome is not known."""
    if not path.startswith('/') or '://' in path:
        raise ValueError('invalid Kalshi API path')
    headers = {**signer.headers('/trade-api/v2' + path, method), 'Accept': 'application/json'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(REST + path, data=data, headers=headers, method=method), timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            try:
                err = json.loads(e.read())
                err = err.get('error', err)
                message = str(err.get('message') or err.get('code') or 'no reason given')
            except Exception:
                message = 'no reason given'
            raise Refused(e.code, message) from None
        raise


async def post(signer: Signer, path: str, body: dict) -> dict:
    return await asyncio.to_thread(_signed, signer, 'POST', path, body)


async def signed_get(signer: Signer, path: str) -> dict:
    return await asyncio.to_thread(_signed, signer, 'GET', path)


async def get(path: str) -> dict:
    """Public (unsigned) GET, run off the event loop."""
    return await asyncio.to_thread(_get, path)
