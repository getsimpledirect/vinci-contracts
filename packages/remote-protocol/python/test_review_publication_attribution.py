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
    MAX_SIGNED_JSON_BYTES,
    MAX_SIGNED_JSON_DEPTH,
    MAX_SIGNED_JSON_MEMBERS,
    MAX_SIGNED_JSON_NODES,
    MAX_SIGNED_JSON_STRING_BYTES,
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

    def test_wrong_key_and_noncanonical_scalar_signature_fail(self):
        public_key = bytearray(decode_public_key(read("public-key.txt").strip()))
        signature = bytearray(signature_bytes(read("signature.txt").strip()))
        public_key[0] ^= 1
        self.assertFalse(openssl_verifies(bytes(public_key), canonical_signing_bytes(self.value), bytes(signature)))

        order = (1 << 252) + 27742317777372353535851937790883648493
        scalar = int.from_bytes(signature[32:], "little") + order
        signature[32:] = scalar.to_bytes(32, "little")
        self.assertFalse(openssl_verifies(
            decode_public_key(read("public-key.txt").strip()),
            canonical_signing_bytes(self.value),
            bytes(signature),
        ))

    def test_noncanonical_key_and_signature_encodings_are_refused(self):
        public_key = read("public-key.txt").strip()
        for candidate in (public_key[1:], public_key + "AA", public_key + "=", "not+base64url"):
            with self.subTest(key=candidate), self.assertRaises(ContractError):
                decode_public_key(candidate)

        signature = read("signature.txt").strip()
        for candidate in (signature[1:], signature + "AA", signature + "=", "not+base64url"):
            changed = copy.deepcopy(self.value)
            changed["signature"]["value"] = candidate
            with self.subTest(signature=candidate), self.assertRaises(ContractError):
                validate_attribution(changed, NOW)

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

    def test_raw_resource_limits_are_stable_contract_refusals(self):
        self.assertEqual(MAX_SIGNED_JSON_BYTES, 1_000_000)
        self.assertEqual(MAX_SIGNED_JSON_DEPTH, 32)
        self.assertEqual(MAX_SIGNED_JSON_NODES, 200_000)
        self.assertEqual(MAX_SIGNED_JSON_MEMBERS, 10_000)
        self.assertEqual(MAX_SIGNED_JSON_STRING_BYTES, 262_144)
        row = "[" + ",".join(["0"] * MAX_SIGNED_JSON_MEMBERS) + "]"
        cases = [
            ("[" * 1_100 + "0" + "]" * 1_100, "too_deep"),
            ("[" + ",".join(["0"] * (MAX_SIGNED_JSON_MEMBERS + 1)) + "]", "too_many_keys"),
            ("[" + ",".join([row] * 21) + "]", "too_many_nodes"),
            ('{"value":"' + "a" * (MAX_SIGNED_JSON_STRING_BYTES + 1) + '"}', "too_large"),
            (" " * (MAX_SIGNED_JSON_BYTES + 1), "too_large"),
        ]
        for source, code in cases:
            with self.subTest(code=code), self.assertRaises(ContractError) as caught:
                parse_attribution_json(source, NOW)
            self.assertEqual(caught.exception.code, code)

    def test_exact_raw_resource_boundaries_are_accepted(self):
        self.assertIsNotNone(parse_strict_json("[" * MAX_SIGNED_JSON_DEPTH + "0" + "]" * MAX_SIGNED_JSON_DEPTH))
        self.assertEqual(len(parse_strict_json("[" + ",".join(["0"] * MAX_SIGNED_JSON_MEMBERS) + "]")), MAX_SIGNED_JSON_MEMBERS)
        self.assertEqual(len(parse_strict_json('"' + "a" * MAX_SIGNED_JSON_STRING_BYTES + '"')), MAX_SIGNED_JSON_STRING_BYTES)
        self.assertEqual(parse_strict_json(" " * (MAX_SIGNED_JSON_BYTES - 1) + "0"), 0)

        full_row = "[" + ",".join(["0"] * MAX_SIGNED_JSON_MEMBERS) + "]"
        final_row = "[" + ",".join(["0"] * 9_979) + "]"
        exact_nodes = "[" + ",".join([full_row] * 19 + [final_row]) + "]"
        self.assertEqual(len(parse_strict_json(exact_nodes)), 20)
        over_nodes = "[" + ",".join([full_row] * 19 + ["[" + ",".join(["0"] * 9_980) + "]"]) + "]"
        with self.assertRaises(ContractError) as caught:
            parse_strict_json(over_nodes)
        self.assertEqual(caught.exception.code, "too_many_nodes")

    def test_direct_object_depth_cycles_width_and_nodes_fail_closed(self):
        cyclic_unknown = copy.deepcopy(self.value)
        cyclic_unknown["unknown"] = cyclic_unknown
        with self.assertRaises(ContractError) as caught:
            validate_attribution(cyclic_unknown, NOW)
        self.assertEqual(caught.exception.code, "invalid_fields")

        cyclic_actor = {"kind": "verifier", "verifierId": None, "independent": True}
        cyclic_actor["verifierId"] = cyclic_actor
        cyclic_value = copy.deepcopy(self.value)
        cyclic_value["actor"] = cyclic_actor
        with self.assertRaises(ContractError) as caught:
            validate_attribution(cyclic_value, NOW)
        self.assertEqual(caught.exception.code, "not_serializable")

        deep = "verifier-1"
        for _index in range(1_100):
            deep = [deep]
        deep_value = copy.deepcopy(self.value)
        deep_value["actor"]["verifierId"] = deep
        with self.assertRaises(ContractError) as caught:
            validate_attribution(deep_value, NOW)
        self.assertEqual(caught.exception.code, "too_deep")

        wide_value = copy.deepcopy(self.value)
        wide_value["actor"]["verifierId"] = ["x"] * (MAX_SIGNED_JSON_MEMBERS + 1)
        with self.assertRaises(ContractError) as caught:
            validate_attribution(wide_value, NOW)
        self.assertEqual(caught.exception.code, "too_many_keys")

        row = [0] * MAX_SIGNED_JSON_MEMBERS
        nodes_value = copy.deepcopy(self.value)
        nodes_value["actor"]["verifierId"] = [row] * 21
        with self.assertRaises(ContractError) as caught:
            validate_attribution(nodes_value, NOW)
        self.assertEqual(caught.exception.code, "too_many_nodes")

    def test_nested_unknown_field_is_rejected_before_its_value_is_walked(self):
        changed = copy.deepcopy(self.value)
        hostile = {}
        hostile["self"] = hostile
        changed["actor"]["unknown"] = hostile
        with self.assertRaises(ContractError) as caught:
            validate_attribution(changed, NOW)
        self.assertEqual(caught.exception.code, "invalid_actor")


class SharedTimestampDomain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.value = json.loads(read("valid-v1.json"))
        cls.cases = json.loads(read("timestamp-v1.json"))

    def test_validity_codes_and_canonical_digests_match_typescript(self):
        for case in self.cases:
            candidate = copy.deepcopy(self.value)
            candidate["issuedAt"] = case["issuedAt"]
            candidate["expiresAt"] = case["expiresAt"]
            with self.subTest(vector=case["name"]):
                if case["valid"]:
                    checked = validate_attribution(candidate, case["now"])
                    self.assertEqual(attribution_digest(checked), case["digest"])
                else:
                    with self.assertRaises(ContractError) as caught:
                        validate_attribution(candidate, case["now"])
                    self.assertEqual(caught.exception.code, case["code"])

                if case.get("code") in ("invalid_timestamp", "invalid_time_order", "lifetime_exceeded"):
                    with self.assertRaises(ContractError) as caught:
                        canonical_signing_bytes(candidate)
                    self.assertEqual(caught.exception.code, case["code"])


if __name__ == "__main__":
    unittest.main()
