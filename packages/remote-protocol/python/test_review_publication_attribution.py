"""Cross-language contract and signature checks for the shared golden vector."""

import base64
import copy
import json
import os
import subprocess
import tempfile
import unittest

from review_publication_attribution import (
    ContractError,
    attribution_digest,
    canonical_signing_bytes,
    decode_public_key,
    format_review_reference,
    parse_attribution_json,
    parse_review_reference,
    parse_strict_json,
    validate_attribution,
)


HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "..", "vectors")
NOW = "2026-09-04T12:05:00.000Z"


def read(name, binary=False):
    mode = "rb" if binary else "r"
    kwargs = {} if binary else {"encoding": "utf-8"}
    with open(os.path.join(VECTORS, name), mode, **kwargs) as handle:
        return handle.read()


def signature_bytes(value):
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def openssl_verifies(public_key, payload, signature):
    # SubjectPublicKeyInfo prefix for a raw Ed25519 public key (RFC 8410).
    spki = bytes.fromhex("302a300506032b6570032100") + public_key
    with tempfile.TemporaryDirectory() as directory:
        paths = {
            "key": os.path.join(directory, "public.der"),
            "payload": os.path.join(directory, "payload.bin"),
            "signature": os.path.join(directory, "signature.bin"),
        }
        for name, content in (("key", spki), ("payload", payload), ("signature", signature)):
            with open(paths[name], "wb") as handle:
                handle.write(content)
        result = subprocess.run(
            [
                "openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
                "-inkey", paths["key"], "-rawin", "-in", paths["payload"],
                "-sigfile", paths["signature"],
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0


class GoldenVector(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = read("valid-v1.json")
        cls.value = parse_attribution_json(cls.source, NOW)

    def test_canonical_bytes_and_digest_are_identical(self):
        self.assertEqual(canonical_signing_bytes(self.value), read("canonical.txt", binary=True))
        self.assertEqual(attribution_digest(self.value), read("digest.txt").strip())

    def test_signature_is_identical_and_cryptographically_valid(self):
        expected = read("signature.txt").strip()
        self.assertEqual(self.value["signature"]["value"], expected)
        self.assertTrue(openssl_verifies(
            decode_public_key(read("public-key.txt").strip()),
            canonical_signing_bytes(self.value),
            signature_bytes(expected),
        ))

    def test_one_byte_change_fails_signature_verification(self):
        payload = bytearray(canonical_signing_bytes(self.value))
        payload[len(payload) // 2] ^= 1
        self.assertFalse(openssl_verifies(
            decode_public_key(read("public-key.txt").strip()),
            bytes(payload),
            signature_bytes(read("signature.txt").strip()),
        ))

    def test_compact_reference_is_identical(self):
        pointer = read("pointer.txt").strip()
        parsed = parse_review_reference(pointer)
        self.assertEqual(format_review_reference(parsed["reviewId"], parsed["publicationDigest"]), pointer)


class FailClosedValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.value = json.loads(read("valid-v1.json"))

    def test_every_required_top_level_field_is_reachable(self):
        for field in self.value:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.value)
                del changed[field]
                with self.assertRaises(ContractError):
                    validate_attribution(changed, NOW)

    def test_every_required_binding_and_subject_field_is_reachable(self):
        for compartment in ("binding", "subject"):
            for field in self.value[compartment]:
                with self.subTest(compartment=compartment, field=field):
                    changed = copy.deepcopy(self.value)
                    del changed[compartment][field]
                    with self.assertRaises(ContractError):
                        validate_attribution(changed, NOW)

    def test_wrong_fixed_values_times_and_encodings_fail(self):
        cases = [
            ("purpose", "other"),
            ("audience", "other"),
            ("verdict", "PASS"),
            ("recordSetDigest", "D" * 64),
            ("issuedAt", "2026-09-04T12:00:00Z"),
            ("expiresAt", "2026-09-04T12:00:00.000Z"),
            ("expiresAt", "2026-09-04T12:10:00.001Z"),
        ]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(self.value)
                changed[field] = value
                with self.assertRaises(ContractError):
                    validate_attribution(changed, NOW)

    def test_actor_independence_cannot_be_omitted_or_smuggled(self):
        for actor in (
            {"kind": "verifier", "verifierId": "v"},
            {"kind": "worker", "workerId": "w", "independent": True},
            {"kind": "verifier", "verifierId": "v", "independent": "yes"},
        ):
            changed = copy.deepcopy(self.value)
            changed["actor"] = actor
            with self.subTest(actor=actor), self.assertRaises(ContractError):
                validate_attribution(changed, NOW)

    def test_strict_json_rejects_duplicate_unsafe_and_invalid_unicode(self):
        bad = [
            '{"a":1,"a":2}',
            '{"a":1,"\\u0061":2}',
            '{"n":9007199254740992}',
            '{"n":-0}',
            '{"n":1e0}',
            '{"s":"\\ud800"}',
            '{"s":"e\\u0301"}',
        ]
        for source in bad:
            with self.subTest(source=source), self.assertRaises(ContractError):
                parse_strict_json(source)
        with self.assertRaises(ContractError):
            parse_strict_json(b'{"s":"\xff"}')

    def test_unknown_fields_and_malformed_pointers_fail(self):
        changed = copy.deepcopy(self.value)
        changed["organizationId"] = "client-shortcut"
        with self.assertRaises(ContractError):
            validate_attribution(changed, NOW)
        for pointer in (
            "grv_@sha256:" + "a" * 64,
            "grv_x@sha256:" + "A" * 64,
            "grv_x @sha256:" + "a" * 64,
            "grv_x@sha256:" + "a" * 64 + "\n",
        ):
            with self.subTest(pointer=pointer), self.assertRaises(ContractError):
                parse_review_reference(pointer)

    def test_committed_invalid_vectors_fail_with_the_same_code(self):
        cases = json.loads(read("invalid-v1.json"))
        self.assertGreaterEqual(len(cases), 12)
        for case in cases:
            with self.subTest(vector=case["name"]):
                with self.assertRaises(ContractError) as caught:
                    parse_attribution_json(case["input"], NOW)
                self.assertEqual(caught.exception.code, case["code"])


if __name__ == "__main__":
    unittest.main()
