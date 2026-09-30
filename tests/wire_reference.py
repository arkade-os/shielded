"""Independent wire/transcript specification, NOT a covenant or ZK verifier."""
from __future__ import annotations
from dataclasses import dataclass
from hashlib import sha256


def h(data: bytes) -> bytes:
    return sha256(data).digest()


def uint_le(value: int, width: int) -> bytes:
    if not 1 <= width <= 32 or not 0 <= value < 1 << (8 * width):
        raise ValueError("unsigned range")
    return value.to_bytes(width, "little")


def scriptnum(raw: bytes) -> int:
    if not raw:
        return 0
    magnitude = int.from_bytes(raw, "little")
    negative = bool(raw[-1] & 0x80)
    if negative:
        magnitude &= ~(0x80 << (8 * (len(raw) - 1)))
    return -magnitude if negative else magnitude


def read_u(data: bytes, offset: int, width: int) -> int:
    if offset < 0 or not 1 <= width <= 32 or offset + width > len(data):
        raise ValueError("read bounds")
    return scriptnum(data[offset:offset + width] + b"\0")


def digest_limbs(digest: bytes) -> tuple[int, ...]:
    if len(digest) != 32:
        raise ValueError("digest width")
    return tuple(read_u(digest, i * 4, 4) for i in range(8))


def state_packet(domain: bytes, params: bytes, records: tuple[bytes, ...]) -> bytes:
    if len(domain) != 32 or len(params) != 32 or not 0 < len(records) <= 64:
        raise ValueError("state header")
    if any(len(r) != 160 for r in records):
        raise ValueError("state record")
    return b"AKS1" + domain + params + uint_le(len(records), 4) + b"".join(records)


def record(packet: bytes, domain: bytes, params: bytes, previous_vout: int) -> bytes:
    if len(packet) < 72 or packet[:4] != b"AKS1":
        raise ValueError("state header")
    if packet[4:36] != domain or packet[36:68] != params:
        raise ValueError("wrong domain/profile")
    n = read_u(packet, 68, 4)
    if not 0 < n <= 64 or len(packet) != 72 + n * 160 or not 0 <= previous_vout < n:
        raise ValueError("state bounds")
    return packet[72 + previous_vout * 160:72 + (previous_vout + 1) * 160]


@dataclass(frozen=True)
class Input:
    txid: bytes
    vout: int
    value: int
    program: bytes
    sequence: int = 0xFFFFFFFF


@dataclass(frozen=True)
class Output:
    value: int
    program: bytes
    asset_count: int = 0


def native_io(inputs: tuple[Input, ...], outputs: tuple[Output, ...],
              version: int = 3, locktime: int = 0) -> bytes:
    if not 2 <= len(inputs) <= 8 or not 3 <= len(outputs) <= 12:
        raise ValueError("capacity")
    if outputs[-1].value or outputs[-1].asset_count:
        raise ValueError("funded extension")
    result = h(b"ArkShieldNativeIO:v1" + uint_le(version, 4) + uint_le(locktime, 4)
               + uint_le(len(inputs), 4) + uint_le(len(outputs), 4))
    for i, x in enumerate(inputs):
        if len(x.txid) != 32:
            raise ValueError("txid width")
        item = h(uint_le(i, 4) + x.txid + uint_le(x.vout, 4) + uint_le(x.value, 8)
                 + h(x.program) + uint_le(x.sequence, 4))
        result = h(result + b"\0" + item)
    for i, x in enumerate(outputs[:-1]):
        item = h(uint_le(i, 4) + uint_le(x.value, 8) + h(x.program))
        result = h(result + b"\1" + item)
    return result


def intent_hash(domain: bytes, params: bytes, intent: bytes) -> bytes:
    return h(b"ArkShieldIntent:v1" + domain + params + h(intent))


def transition_hash(domain: bytes, params: bytes, intent: bytes, io: bytes,
                    plan: bytes, state: bytes, asset_packet: bytes) -> bytes:
    return h(b"ArkShieldTransition:v1" + domain + params + intent_hash(domain, params, intent)
             + io + h(plan) + h(state) + h(asset_packet))
