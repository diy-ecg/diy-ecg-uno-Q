"""
RPC transport and frame parser for the Arduino UNO Q Bridge endpoint.

The STM32 sketch exposes `ecg_get_frame` via Bridge/RPC, returning either a
MsgPack binary payload or (legacy) hex-encoded frame:
[uint8 count][uint32 t0_ms][count * (uint16 sample + uint8 dt_ms)][uint16 crc16]
Optional leading 0x21 ('!') represents an overflow marker and is ignored.
"""
from __future__ import annotations

import struct
from typing import List, Tuple

try:
    from arduino.app_utils import Bridge
except ImportError as exc:  # pragma: no cover - only relevant on non-UNO-Q hosts
    Bridge = None
    _bridge_import_error = exc
else:
    _bridge_import_error = None

CRC_POLY = 0xA001
MAX_SAMPLES = 255


def crc16_ibm(data: bytes) -> int:
    """Compute CRC-16/IBM over given bytes (poly 0xA001, init 0)."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ CRC_POLY
            else:
                crc >>= 1
    return crc & 0xFFFF


def _looks_like_hex(data: bytes) -> bool:
    if not data or (len(data) % 2) != 0:
        return False
    hex_bytes = b"0123456789abcdefABCDEF"
    return all(b in hex_bytes for b in data)


def _parse_frame_bytes(buf: bytes) -> Tuple[List[int], List[int]]:
    if not buf:
        return [], []
    if buf[0] == 0x21 and len(buf) > 1:
        buf = buf[1:]

    if len(buf) < 1 + 2 + 2:
        return [], []

    count = buf[0]
    if count == 0 or count > MAX_SAMPLES:
        return [], []

    expected = 1 + 4 + count * 3 + 2
    if len(buf) != expected:
        return [], []

    crc_recv = buf[-2] | (buf[-1] << 8)
    crc_calc = crc16_ibm(buf[:-2])
    if crc_calc != crc_recv:
        return [], []

    offset = 1
    t0 = struct.unpack_from("<I", buf, offset)[0]
    offset += 4
    samples: List[int] = []
    timestamps: List[int] = []
    prev_t = t0
    for _ in range(count):
        sample = struct.unpack_from("<H", buf, offset)[0]
        offset += 2
        dt = buf[offset]
        offset += 1
        ts = prev_t + dt
        samples.append(sample)
        timestamps.append(ts)
        prev_t = ts
    return samples, timestamps


def parse_frame(resp: object) -> Tuple[List[int], List[int]]:
    """Decode binary or hex frame to samples/timestamps, validating CRC and length."""
    if not resp:
        return [], []

    if isinstance(resp, (bytes, bytearray)):
        raw = bytes(resp)
        if _looks_like_hex(raw):
            try:
                buf = bytes.fromhex(raw.decode("ascii"))
            except ValueError:
                return [], []
        else:
            buf = raw
    else:
        text = str(resp).strip()
        if not text:
            return [], []
        try:
            buf = bytes.fromhex(text)
        except ValueError:
            return [], []

    return _parse_frame_bytes(buf)


class ArduinoQRpcClient:
    """Lightweight RPC client that mirrors the SerialPort API used by the viewer."""

    def __init__(self) -> None:
        if Bridge is None:
            raise ImportError(
                "arduino.app_utils.Bridge is not available; run on the UNO Q Linux side."
            ) from _bridge_import_error

    def request_frame(self) -> Tuple[List[int], List[int]]:
        """Call the MCU RPC endpoint and parse the returned frame."""
        resp = Bridge.call("ecg_get_frame")
        #print(type(resp), resp if resp is None else len(resp), flush=True)
        if resp is None:
            return [], []

        return parse_frame(resp)

    def close(self) -> None:
        """Provided for API symmetry with SerialPort; nothing to close here."""
        return


def open_rpc() -> ArduinoQRpcClient:
    """Factory mirroring open_serial() from the legacy transport."""
    return ArduinoQRpcClient()
