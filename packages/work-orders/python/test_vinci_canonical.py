"""Byte-equality with the TypeScript canonicalizer, via the shared golden vectors.

Run from the repository root:  python3 -m unittest discover -s packages/work-orders/python
"""
import json
import os
import struct
import unittest

from vinci_canonical import canonicalize, digest

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vectors")


def _from_hex(h):
    return struct.unpack(">d", bytes.fromhex(h))[0]


class GoldenVectors(unittest.TestCase):
    def _dirs(self):
        return sorted(d for d in os.listdir(VECTORS) if os.path.isdir(os.path.join(VECTORS, d)))

    def test_there_are_eight_vectors(self):
        dirs = self._dirs()
        self.assertEqual(len([d for d in dirs if d.startswith("work-order-")]), 4)
        self.assertEqual(len([d for d in dirs if d.startswith("execution-spec-")]), 4)

    def test_canonical_bytes_and_digest_match_node(self):
        for d in self._dirs():
            with self.subTest(vector=d):
                base = os.path.join(VECTORS, d)
                with open(os.path.join(base, "input.json"), encoding="utf-8") as f:
                    value = json.load(f)
                with open(os.path.join(base, "canonical.txt"), "rb") as f:
                    expected_bytes = f.read()
                with open(os.path.join(base, "digest.txt"), encoding="utf-8") as f:
                    expected_digest = f.read().strip()
                self.assertEqual(canonicalize(value).encode("utf-8"), expected_bytes)
                self.assertEqual(digest(value), expected_digest)


class SharedFloatCases(unittest.TestCase):
    """vectors/float-cases.json, read by src/vectors.test.ts too: byte equality on floats."""

    def test_float_cases_match_pinned_bytes(self):
        with open(os.path.join(VECTORS, "float-cases.json"), encoding="utf-8") as f:
            cases = json.load(f)
        pinned = [c["canonical"] for c in cases]
        for required in ("1e+21", "1e-7", "0.1"):
            self.assertIn(required, pinned)
        self.assertGreaterEqual(len(cases), 3)
        for case in cases:
            with self.subTest(canonical=case["canonical"]):
                self.assertIsInstance(case["input"], float)
                self.assertEqual(canonicalize(case["input"]).encode("utf-8"), case["canonical"].encode("utf-8"))


class Rfc8785Numbers(unittest.TestCase):
    """The RFC's Section 3.2.2.3 table: this is where a Python port goes wrong."""

    TABLE = [
        ("0000000000000000", "0"),
        ("8000000000000000", "0"),
        ("0000000000000001", "5e-324"),
        ("8000000000000001", "-5e-324"),
        ("7fefffffffffffff", "1.7976931348623157e+308"),
        ("ffefffffffffffff", "-1.7976931348623157e+308"),
        ("4340000000000000", "9007199254740992"),
        ("c340000000000000", "-9007199254740992"),
        ("4430000000000000", "295147905179352830000"),
        ("44b52d02c7e14af5", "9.999999999999997e+22"),
        ("44b52d02c7e14af6", "1e+23"),
        ("44b52d02c7e14af7", "1.0000000000000001e+23"),
        ("444b1ae4d6e2ef4e", "999999999999999700000"),
        ("444b1ae4d6e2ef4f", "999999999999999900000"),
        ("444b1ae4d6e2ef50", "1e+21"),
        ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
        ("3eb0c6f7a0b5ed8d", "0.000001"),
        ("41b3de4355555553", "333333333.3333332"),
        ("41b3de4355555554", "333333333.33333325"),
        ("41b3de4355555555", "333333333.3333333"),
        ("41b3de4355555556", "333333333.3333334"),
        ("41b3de4355555557", "333333333.33333343"),
        ("becbf647612f3696", "-0.0000033333333333333333"),
        ("43143ff3c1cb0959", "1424953923781206.2"),
    ]

    def test_table(self):
        for h, expected in self.TABLE:
            with self.subTest(hex=h):
                self.assertEqual(canonicalize(_from_hex(h)), expected)

    def test_prose_examples_and_ints(self):
        self.assertEqual(canonicalize(1e30), "1e+30")
        self.assertEqual(canonicalize(0.0000001), "1e-7")
        self.assertEqual(canonicalize(10000000000000000000), "10000000000000000000")
        self.assertEqual(canonicalize(-0.0), "0")
        self.assertEqual(canonicalize(56.0), "56")
        self.assertEqual(canonicalize(12.5), "12.5")
        self.assertEqual(canonicalize(0.1), "0.1")
        self.assertEqual(canonicalize(9007199254740991), "9007199254740991")

    def test_non_finite_raise(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(ValueError):
                canonicalize(bad)


class Rfc8785StringsAndKeys(unittest.TestCase):
    def test_string_escaping(self):
        rfc = "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"/"
        self.assertEqual(canonicalize(rfc), '"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"')
        self.assertEqual(canonicalize("\b\f\n\r\t"), '"\\b\\f\\n\\r\\t"')
        self.assertEqual(canonicalize("\u0000\u001f"), '"\\u0000\\u001f"')
        self.assertEqual(canonicalize("\u007f\u0080"), '"\u007f\u0080"')
        # Lone surrogates are escaped, as well-formed JSON.stringify does.
        self.assertEqual(canonicalize("\ud800"), '"\\ud800"')
        self.assertEqual(canonicalize("x\udfffy"), '"x\\udfffy"')

    def test_appendix_a_key_order_is_utf16_code_units(self):
        value = {
            "€": "Euro Sign",
            "\r": "Carriage Return",
            "דּ": "Hebrew Letter Dalet With Dagesh",
            "1": "One",
            "\U0001f600": "Emoji: Grinning Face",
            "\u0080": "Control",
            "ö": "Latin Small Letter O With Diaeresis",
        }
        self.assertEqual(
            canonicalize(value),
            '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",'
            '"€":"Euro Sign","\U0001f600":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
        )

    def test_appendix_b(self):
        value = {"1": {"f": {"f": "hi", "F": 5}, "\n": 56.0}, "10": {}, "": "empty", "a": {}, "111": [{"e": "yes", "E": "no"}], "A": {}}
        self.assertEqual(
            canonicalize(value),
            '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
        )

    def test_literals_and_rejections(self):
        self.assertEqual(canonicalize([True, False, None]), "[true,false,null]")
        with self.assertRaises(TypeError):
            canonicalize({"a": object()})


if __name__ == "__main__":
    unittest.main()
