"""Byte-equality with the TypeScript run-contract digests, via the shared golden vectors.

Run from the repository root:  python3 -m unittest discover -s packages/run/python

The canonicalizer is NOT re-implemented here. This imports
packages/work-orders/python/vinci_canonical.py by path — there is one Python
canonical encoder in this repository and this is it. A second hand-written copy
is exactly the failure the shared module was created to end: two encoders that
disagree by a byte cannot verify each other's records, which is the whole point
of having one.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
WORK_ORDERS_PYTHON = os.path.join(REPO, "packages", "work-orders", "python")
if WORK_ORDERS_PYTHON not in sys.path:
    sys.path.insert(0, WORK_ORDERS_PYTHON)

from vinci_canonical import canonicalize, digest  # noqa: E402

VECTORS = os.path.join(HERE, "..", "vectors")

EXPECTED_VECTORS = [
    "agent-1-minimal",
    "context-manifest-1-trust",
    "environment-1-cloud",
    "harness-attestation-1-pass",
    "harness-attestation-2-expired",
    "harness-attestation-3-pinned-checkout",
    "harness-attestation-4-working-tree",
    "human-correction-1",
    "run-1-created",
]

# The digests, pinned IN SOURCE as well as in each vector's digest.txt.
#
# digest.txt is written by vectors/generate.mjs, so comparing against it alone
# cannot distinguish "the vectors are unchanged" from "the generator was re-run
# and the fixture moved" — the regenerated file agrees with the regenerated
# fixture by construction. These literals are the second, independent pin, and
# src/vectors.test.ts pins the identical values from the other language: a
# regeneration must be typed into both, which is what makes it a deliberate act.
PINNED_DIGESTS = {
    "agent-1-minimal": "e77779f93275b68148c6a6bdccad2000fe14bda4c345f06760cf9bd9d441b89b",
    "context-manifest-1-trust": "367ff605647abc9c288560f69aff398227124837016145c0b14d6615aa78a1d5",
    "environment-1-cloud": "03904cc6ece8e357e7926a3b4f959dbf43eac9738650aa2b14559c8c745d10dd",
    "harness-attestation-1-pass": "c8f4412a5a75d879d17a7681091d9982ae5b482591fcc234995265adbd89a2e7",
    "harness-attestation-2-expired": "f0d008c6aee8a08dc29f5d1b4978da8a0ca8a770bd42069e98efa4c1d1957cbe",
    "harness-attestation-3-pinned-checkout": "7e7869a0c516cad5b284883ca7006ff4add3bb9e56db070ba322a6225525c96f",
    "harness-attestation-4-working-tree": "85ebce77a803049d00fd961115bb69070e82a4077130ee8a6b943ef3ea1b036d",
    "human-correction-1": "e7e3e8ed30427461d7a238c301e7ddc49232f161eac1bbf320fe75b764b08f80",
    "run-1-created": "6dc08c3b38320c898bcd2ecac37167ebc75b5d3c1e0775d1d5f34f95b9d54866",
}

# The 24 event types run-events v4 adds, pinned as a literal so a type deleted
# from the vocabulary cannot vanish from the expectation at the same time.
V4_ADDITIONS = [
    "run.stalled",
    "run.attempt_started",
    "agent.turn_started",
    "agent.turn_finished",
    "agent.compaction_started",
    "agent.compaction_finished",
    "agent.retry_started",
    "agent.retry_finished",
    "tool.requested",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "tool.confirmation_required",
    "governor.lease_acquired",
    "governor.lease_renewed",
    "governor.lease_lost",
    "artifact.persisted",
    "artifact.verified",
    "approval.expired",
    "context.loaded",
    "context.invalidated",
    "capability.attested",
    "capability.refused",
    "steer.received",
]

VALUE_KINDS = {"id", "enum", "count", "digest", "at", "flag"}


def _is_hex64(value):
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in "0123456789abcdef" for c in value)
    )


def _flip_one_hex_character(value, state):
    """Return a copy of `value` with ONE character of its first 64-hex string flipped.

    The same mutation the Node test makes: hex to hex, inside a digest field, so
    the mutant is still a well-formed record of the same schema and a changed
    digest is attributable to the changed bytes.
    """
    if isinstance(value, str):
        if not state["changed"] and _is_hex64(value):
            state["changed"] = True
            return value[:-1] + ("1" if value[-1] == "0" else "0")
        return value
    if isinstance(value, list):
        return [_flip_one_hex_character(v, state) for v in value]
    if isinstance(value, dict):
        return {k: _flip_one_hex_character(v, state) for k, v in value.items()}
    return value


class GoldenVectors(unittest.TestCase):
    def _dirs(self):
        return sorted(d for d in os.listdir(VECTORS) if os.path.isdir(os.path.join(VECTORS, d)))

    def test_the_committed_vectors_are_exactly_the_expected_nine(self):
        self.assertEqual(self._dirs(), EXPECTED_VECTORS)
        # A pin map missing an entry would silently stop pinning that vector,
        # and nine distinct fixtures must have nine distinct identities.
        self.assertEqual(sorted(PINNED_DIGESTS), sorted(EXPECTED_VECTORS))
        self.assertEqual(len(set(PINNED_DIGESTS.values())), len(EXPECTED_VECTORS))

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
                # The source-side pin, the same literal the Node test carries.
                self.assertEqual(expected_digest, PINNED_DIGESTS[d])

    def test_one_flipped_character_changes_the_bytes_and_the_digest(self):
        """The connected-instrument control, in Python.

        Without it, this file cannot tell a working comparison from one that was
        deleted: every assertion above would still pass if `digest` returned a
        constant, provided the constant were the pinned one.
        """
        for d in self._dirs():
            with self.subTest(vector=d):
                base = os.path.join(VECTORS, d)
                with open(os.path.join(base, "input.json"), encoding="utf-8") as f:
                    value = json.load(f)
                with open(os.path.join(base, "canonical.txt"), "rb") as f:
                    expected_bytes = f.read()
                with open(os.path.join(base, "digest.txt"), encoding="utf-8") as f:
                    expected_digest = f.read().strip()
                state = {"changed": False}
                mutated = _flip_one_hex_character(value, state)
                self.assertTrue(state["changed"], "every vector must carry a 64-hex field to mutate")
                self.assertNotEqual(canonicalize(mutated).encode("utf-8"), expected_bytes)
                self.assertNotEqual(digest(mutated), expected_digest)
                # The mutation ran on a copy: the original still matches.
                self.assertEqual(canonicalize(value).encode("utf-8"), expected_bytes)
                self.assertEqual(digest(value), expected_digest)


class RunEventsV4Additions(unittest.TestCase):
    """The accept/refuse vectors are shared, so both languages see the same file.

    Python has no run-event validator, so this asserts the file's SHAPE — the
    24 types, and that every payload value is a kinded pair rather than free
    text. The verdicts themselves are executed by src/vectors.test.ts, which
    runs the validator. Claiming more than that here would be a checker that
    reports on a file it cannot evaluate.
    """

    def setUp(self):
        with open(os.path.join(VECTORS, "run-events-v4-additions.json"), encoding="utf-8") as f:
            self.doc = json.load(f)

    def test_covers_all_24_new_types(self):
        self.assertEqual(self.doc["schemaVersion"], 4)
        self.assertEqual([c["type"] for c in self.doc["cases"]], V4_ADDITIONS)

    def test_every_valid_payload_field_is_a_kinded_pair(self):
        for case in self.doc["cases"]:
            with self.subTest(event_type=case["type"]):
                event = case["valid"]
                self.assertEqual(event["type"], case["type"])
                self.assertEqual(event["schemaVersion"], 4)
                for field, value in event["payload"].items():
                    self.assertEqual(
                        sorted(value.keys()), ["kind", "value"],
                        "%s/%s carries something other than a tagged value" % (case["type"], field),
                    )
                    self.assertIn(value["kind"], VALUE_KINDS)

    def test_each_refusal_names_a_path_and_a_code(self):
        codes = set()
        for case in self.doc["cases"]:
            with self.subTest(event_type=case["type"]):
                self.assertEqual(case["invalid"]["type"], case["type"])
                self.assertTrue(case["expectedIssue"]["path"].startswith("/payload/"))
                self.assertNotEqual(case["expectedIssue"]["code"], "")
                codes.add(case["expectedIssue"]["code"])
        # Non-vacuity: twenty-four copies of one refusal shape would exercise one
        # branch of the payload validator and read as full coverage.
        self.assertGreaterEqual(len(codes), 6)


if __name__ == "__main__":
    unittest.main()
