"""Canonical JSON + SHA-256, byte-compatible with packages/contracts/src/canonical.ts.

Standard library only. The rule (RFC 8785 / JCS, for the value domain in use):
object keys sorted by UTF-16 code unit at every level, arrays in order,
numbers as ECMAScript Number::toString, strings escaped as JSON.stringify
does, no whitespace. Non-finite numbers raise. packages/work-orders/vectors/
pins this and the TypeScript implementation to the same bytes.
"""
import hashlib
import json
import math
from decimal import Decimal

_SHORT = {8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\"}


def _string(s: str) -> str:
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if cp in _SHORT:
            out.append(_SHORT[cp])
        elif cp < 0x20 or 0xD800 <= cp <= 0xDFFF:  # controls, and lone surrogates
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _number(x) -> str:
    """ECMAScript Number::toString(x) for a finite double."""
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        x = float(x)  # JSON numbers are doubles; JS would have parsed it as one
    if not math.isfinite(x):
        raise ValueError("cannot canonicalize a non-finite number")
    if x == 0:
        return "0"  # covers -0
    sign = "-" if x < 0 else ""
    # repr() gives the shortest round-tripping digits, like JS; only the layout differs.
    d = Decimal(repr(abs(x))).as_tuple()
    digits = "".join(map(str, d.digits)).rstrip("0") or "0"
    k = len(digits)
    n = len(d.digits) + d.exponent  # decimal point position: value = 0.digits * 10^n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exp = ("e+" if e >= 0 else "e-") + str(abs(e))
    if k == 1:
        return sign + digits + exp
    return sign + digits[0] + "." + digits[1:] + exp


def canonicalize(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        # UTF-16 code-unit order == byte order of the UTF-16-BE encoding.
        keys = sorted(value, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(_string(k) + ":" + canonicalize(value[k]) for k in keys) + "}"
    raise TypeError("cannot canonicalize a value of type %s" % type(value).__name__)


def digest(value) -> str:
    """SHA-256 hex over the UTF-8 bytes of the canonical encoding.

    Strict UTF-8: lone surrogates are escaped by canonicalize, so none can
    reach here, and an encoder that let one through would differ from Node.
    """
    return hashlib.sha256(canonicalize(value).encode("utf-8")).hexdigest()


if __name__ == "__main__":
    import sys
    print(digest(json.loads(sys.stdin.read())))
