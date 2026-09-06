"""Byte-equality with the TypeScript Oracle-record digests, via the shared golden vectors.

Run from the repository root:  python3 -m unittest discover -s packages/oracle-records/python

The canonicalizer is NOT re-implemented here. This imports
packages/work-orders/python/vinci_canonical.py by path — there is one Python
canonical encoder in this repository and this is it. A second hand-written copy
is exactly the failure the shared module was created to end: two encoders that
disagree by a byte cannot verify each other's records, which is the whole point
of having one.

What this file can and cannot check is worth stating plainly. Python has no
validator for these records, so it does not evaluate the refusals in
refusal-cases.json — src/vectors.test.ts runs those. What Python DOES evaluate
independently is the enum drift: it carries its own pinned copies of the closed
vocabularies and checks, for every drift case, that the offending value is
outside the vocabulary while the corresponding field in the valid vectors is
inside it. That makes "enum drift fails consistently in both languages" a
checked property rather than a claim, without pretending to run a validator
that does not exist here.
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
    "claim-assessment-1-supported",
    "claim-assessment-2-check-unavailable",
    "claim-assessment-3-not-assessed",
    "claim-record-1-observed",
    "claim-record-2-hypothesis",
    "context-binding-1-complete",
    "context-binding-2-incomplete",
    "decision-proposal-1-request-observation",
    "decision-proposal-2-no-change",
    "outcome-record-1-helpful-disproved",
    "research-report-1-partial",
    "research-request-1-admitted",
    "research-request-2-unicode-numbers",
    "source-citation-1-delivered",
    "source-record-1-repository-read",
    "source-record-2-provider-reported",
    "source-record-3-unsupported-format",
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
    "claim-assessment-1-supported": "a08b1e31fffc816ce69d987e3150a6acb192b26688dc7351daa52f251da628b0",
    "claim-assessment-2-check-unavailable": "0da93a35f4d2dba1049bba747e18162c0773cc44e8bf294169e87d24bfdd740f",
    "claim-assessment-3-not-assessed": "56a03d670b42375b9aa4bea4dec5f9a80464ae7cf16e7071d822ea127505998f",
    "claim-record-1-observed": "afbf2347a919afb2b8799c8f5329a30b0de1ec7f383c43ba1a88860d4c2fb637",
    "claim-record-2-hypothesis": "6851e2e45c793affef1e8ee3496bd45defa876e82ca528c9d054a52bd7e9289b",
    "decision-proposal-1-request-observation": "2b1a89a24fd1254e4afd578271bc42dbd8f074e4a4bcadda3df9889063179cf0",
    "decision-proposal-2-no-change": "8262f70dc99b4ccee8da357a29dec6a043145b03ff5656237ab8aebbdb3ceed6",
    "outcome-record-1-helpful-disproved": "ba3d60a5e63aff08b67ba5bea2f589ce767b48e41719edb9965b20282144a76d",
    "research-report-1-partial": "53daedc62d8b5919fd498d34ccd062196b2f55c38bcfbec18400fdc259e0753c",
    "context-binding-1-complete": "95c49a42f4ce350d3113ea6ba5210a6db7a8c12096c36150dcf4b293132389f7",
    "context-binding-2-incomplete": "362feb622e1e54719d884e5ddf893332a9408e3c85a8f156a2b4907015096497",
    "research-request-1-admitted": "a722101e72a63e022944a3a7fc336d86c6410efb93751a015d74f94017a34bb0",
    "research-request-2-unicode-numbers": "aecd39c102b9e188400e47438286a4d5c36640700e4161be7ebae74c51268451",
    "source-citation-1-delivered": "b2544375f40901d9090c2aeb64c0602edb9652bf0025b1104c4d6c37ec95f208",
    "source-record-1-repository-read": "37facd652807911463cd52bb021d0d18af3fe2cd600911fe6939edd20e3ef19d",
    "source-record-2-provider-reported": "48039508f1f51d7e8e20f99cf131e5c5028c7377e6d666ac79ff79f43a25b202",
    "source-record-3-unsupported-format": "32cf1b46f8ad43128a37de1012bd36b53320812a6be042cb505ff2a4ee539c2b",
}

# The closed vocabularies, pinned HERE rather than read from anything the
# TypeScript side produces. Deriving them from the vectors would make the
# membership checks below vacuous — a renamed member would move on both sides at
# once and every assertion would still pass.
VOCABULARIES = {
    "ATTESTED_ENVELOPE_KINDS": [
        "oracle_research_request",
        "oracle_source_citation",
        "oracle_decision_proposal",
    ],
    "RESEARCH_MODES": ["investigation", "verification", "monitoring", "exploration"],
    "SOURCE_MATCH_STATES": ["MATCHED", "NO_MATCH", "NOT_SEARCHED"],
    "SOURCE_READ_OUTCOMES": [
        "READ_COMPLETE",
        "READ_PARTIAL",
        "SEARCH_NO_RESULTS",
        "SEARCH_FAILED",
        "FETCH_FAILED",
        "UNSUPPORTED_FORMAT",
        "ACCESS_DENIED",
    ],
    "SOURCE_COMPLETENESS": [
        "FULL_REQUESTED_RANGE",
        "PARTIAL",
        "SNIPPET_ONLY",
        "NOT_OBTAINED",
    ],
    "CONTEXT_COMPLETENESS": ["CONTEXT_COMPLETE", "CONTEXT_INCOMPLETE"],
    "SOURCE_OBSERVATION_MODES": ["INDEPENDENT_RETRIEVAL", "PROVIDER_REPORTED"],
    "ASSESSMENT_STATUSES": [
        "SUPPORTED",
        "CONTRADICTED",
        "INSUFFICIENT_EVIDENCE",
        "CHECK_UNAVAILABLE",
        "NOT_ASSESSED",
    ],
    "ASSESSMENT_METHODS": ["DETERMINISTIC", "EXECUTION", "MODEL", "HUMAN"],
    "CLAIM_TYPES": [
        "OBSERVED",
        "EXTERNALLY_REPORTED",
        "INFERRED",
        "HYPOTHESIS",
        "RECOMMENDATION",
    ],
    "PROPOSAL_KINDS": [
        "ANSWER_ONLY",
        "REQUEST_OBSERVATION",
        "EXPERIMENT_PROPOSAL",
        "IMPLEMENTATION_PROPOSAL",
        "NO_CHANGE",
        "DEFER",
        "STOP_PROPOSAL",
        "ESCALATE",
    ],
    "PROPOSAL_ADMISSIBILITY": ["ADMISSIBLE", "INADMISSIBLE_RETAINED_AS_ADVISORY"],
    "ORACLE_PROPOSE_SCOPES": ["advisory_only", "advisory_with_job_shape_ref"],
    "OUTCOME_CLASSES": [
        "HELPFUL_OBSERVED",
        "NOT_HELPFUL_OBSERVED",
        "INCONCLUSIVE",
        "NOT_ATTEMPTED",
        "OBSERVATION_UNAVAILABLE",
    ],
    "HYPOTHESIS_RESULTS": ["SUPPORTED_BY_RESULT", "DISPROVED_BY_RESULT", "NOT_APPLICABLE"],
    "REPORT_COMPLETENESS": ["COMPLETE", "PARTIAL", "FAILED"],
    "RUN_TERMINAL_STATES": ["SUCCEEDED", "PARTIALLY_COMPLETED", "FAILED", "ABORTED"],
}


def _read_json(*parts):
    with open(os.path.join(VECTORS, *parts), encoding="utf-8") as f:
        return json.load(f)


def _at_pointer(root, pointer):
    """Resolve a JSON pointer, or return the sentinel below when it does not exist."""
    node = root
    for segment in pointer.split("/")[1:]:
        if isinstance(node, list):
            index = int(segment)
            if index >= len(node):
                return _MISSING
            node = node[index]
            continue
        if not isinstance(node, dict) or segment not in node:
            return _MISSING
        node = node[segment]
    return node


_MISSING = object()


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

    def test_the_committed_vectors_are_exactly_the_expected_seventeen(self):
        self.assertEqual(self._dirs(), EXPECTED_VECTORS)
        # A pin map missing an entry would silently stop pinning that vector,
        # and eight distinct fixtures must have eight distinct identities.
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

        Without it this file cannot tell a working comparison from one that was
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

    def test_the_unicode_vector_reaches_the_encoder_edges(self):
        """The one vector written to make the two encoders disagree if they can.

        Astral-plane characters are a surrogate PAIR in UTF-16 and one code
        point in Python; a control character must be escaped rather than emitted
        raw; and MAX_SAFE_INTEGER is where a naive float formatter starts
        printing exponents. Node's side asserts the same three things.
        """
        value = _read_json("research-request-2-unicode-numbers", "input.json")
        text = value["payload"]["decisionToInform"] + value["payload"]["question"]
        self.assertIn("\U0001d11e", text)   # astral plane
        self.assertIn("́", text)       # combining acute
        self.assertIn("ע", text)       # right-to-left
        self.assertIn("‍", text)       # zero-width joiner
        self.assertIn("", text)       # control character
        effort = value["hostResolved"]["effort"]
        self.assertEqual(effort["maxBytes"], 9007199254740991)
        self.assertEqual(effort["budgetMicrousd"], 0)
        canonical = canonicalize(value)
        self.assertIn('"budgetMicrousd":0', canonical)
        self.assertIn('"maxBytes":9007199254740991', canonical)
        self.assertIn("\\u0001", canonical)


class SharedVocabularies(unittest.TestCase):
    """Every enum-valued field in the valid vectors names a member Python knows.

    This is the half of T08 Python can actually execute. The vocabularies above
    are pinned independently of anything the TypeScript build emits, so a member
    renamed on one side breaks here rather than moving quietly on both.
    """

    def test_envelope_kinds(self):
        for d in ["research-request-1-admitted", "research-request-2-unicode-numbers"]:
            value = _read_json(d, "input.json")
            self.assertIn(value["envelopeKind"], VOCABULARIES["ATTESTED_ENVELOPE_KINDS"])
            self.assertIn(
                value["hostResolved"]["effort"]["mode"], VOCABULARIES["RESEARCH_MODES"]
            )
        citation = _read_json("source-citation-1-delivered", "input.json")
        self.assertIn(citation["envelopeKind"], VOCABULARIES["ATTESTED_ENVELOPE_KINDS"])

    def test_source_records_name_members_and_cover_three_read_outcomes(self):
        outcomes = set()
        modes = set()
        for d in [
            "source-record-1-repository-read",
            "source-record-2-provider-reported",
            "source-record-3-unsupported-format",
        ]:
            value = _read_json(d, "input.json")
            self.assertIn(value["readOutcome"], VOCABULARIES["SOURCE_READ_OUTCOMES"])
            self.assertIn(value["matchState"], VOCABULARIES["SOURCE_MATCH_STATES"])
            self.assertIn(value["completeness"], VOCABULARIES["SOURCE_COMPLETENESS"])
            self.assertIn(
                value["observation"]["mode"], VOCABULARIES["SOURCE_OBSERVATION_MODES"]
            )
            outcomes.add(value["readOutcome"])
            modes.add(value["observation"]["mode"])
        self.assertEqual(len(outcomes), 3)
        self.assertEqual(sorted(modes), sorted(VOCABULARIES["SOURCE_OBSERVATION_MODES"]))

    def test_context_bindings_cover_both_completeness_states(self):
        states = [
            _read_json(d, "input.json")["completeness"]
            for d in ["context-binding-1-complete", "context-binding-2-incomplete"]
        ]
        self.assertEqual(sorted(states), sorted(VOCABULARIES["CONTEXT_COMPLETENESS"]))

    def test_assessment_vectors_carry_the_states_an_error_path_would_skip(self):
        """CLM-01, checked from the committed bytes rather than from a validator.

        The SUPPORTED vector carries the evidence that earns it — the spans the
        evaluator actually reviewed, and a reviewer run marked completed — and
        neither of the other two carries either field at all. That is the
        structural rule visible in the data: a CHECK_UNAVAILABLE record has
        nowhere to put a review it did not perform.
        """
        supported = _read_json("claim-assessment-1-supported", "input.json")
        unavailable = _read_json("claim-assessment-2-check-unavailable", "input.json")
        not_assessed = _read_json("claim-assessment-3-not-assessed", "input.json")
        for record in [supported, unavailable, not_assessed]:
            self.assertIn(record["status"], VOCABULARIES["ASSESSMENT_STATUSES"])
        self.assertEqual(
            sorted(r["status"] for r in [supported, unavailable, not_assessed]),
            ["CHECK_UNAVAILABLE", "NOT_ASSESSED", "SUPPORTED"],
        )
        self.assertGreater(len(supported["reviewedSpans"]), 0)
        self.assertIs(supported["execution"]["completed"], True)
        self.assertIn(supported["method"], VOCABULARIES["ASSESSMENT_METHODS"])
        for record in [unavailable, not_assessed]:
            self.assertNotIn("reviewedSpans", record)
            self.assertNotIn("execution", record)
        # NOT_ASSESSED names no evaluator because none ran; CHECK_UNAVAILABLE
        # names one because a check ran and produced nothing usable. Absence of
        # assessment must never read as absence of problems.
        self.assertNotIn("evaluator", not_assessed)
        self.assertIn("evaluator", unavailable)
        self.assertIn(unavailable["unavailableReason"], ["timed_out", "parse_error",
                                                         "empty_material", "missing_citation",
                                                         "incomplete_reviewer_execution",
                                                         "evaluator_unavailable"])

    def test_claim_vectors_cover_an_observation_and_an_unsourced_hypothesis(self):
        """CLM-04: the hypothesis vector has NO source spans and is still valid.

        A validator demanding source support for the future outcome of a
        proposed experiment would have made this record unrepresentable, and
        INV-15 says a package that refuses everything has not qualified.
        """
        observed = _read_json("claim-record-1-observed", "input.json")
        hypothesis = _read_json("claim-record-2-hypothesis", "input.json")
        for record in [observed, hypothesis]:
            self.assertIn(record["claimType"], VOCABULARIES["CLAIM_TYPES"])
        self.assertEqual(observed["claimType"], "OBSERVED")
        self.assertGreater(len(observed["sourceSpans"]), 0)
        self.assertIsNone(observed["derivation"])
        self.assertEqual(hypothesis["claimType"], "HYPOTHESIS")
        self.assertEqual(hypothesis["sourceSpans"], [])
        self.assertIsNotNone(hypothesis["discriminatingTest"])
        # Both arms of the test, because one arm is a plan to find agreement.
        self.assertIn("wouldSupport", hypothesis["discriminatingTest"])
        self.assertIn("wouldRefute", hypothesis["discriminatingTest"])

    def test_proposal_vectors_never_carry_execution_authority(self):
        """PROP-01/INV-01, pinned in the committed bytes.

        Python has no validator for these records, so what it can check is the
        DATA: neither proposal says true, both propose scopes are represented,
        and no key anywhere in either model-authored payload names an authority.
        """
        proposals = [
            _read_json("decision-proposal-1-request-observation", "input.json"),
            _read_json("decision-proposal-2-no-change", "input.json"),
        ]
        scopes = []
        states = []
        for proposal in proposals:
            host = proposal["hostResolved"]
            self.assertIs(host["authorityToExecute"], False)
            scopes.append(host["proposeScope"])
            states.append(host["admissibility"]["state"])
            self.assertIn(proposal["payload"]["kind"], VOCABULARIES["PROPOSAL_KINDS"])
            self.assertGreater(len(proposal["payload"]["alternatives"]), 0)
            self._assert_no_authority_key(proposal["payload"], "/payload")
        self.assertEqual(sorted(scopes), sorted(VOCABULARIES["ORACLE_PROPOSE_SCOPES"]))
        self.assertEqual(sorted(states), sorted(VOCABULARIES["PROPOSAL_ADMISSIBILITY"]))
        # PROP-02: the inadmissible one is RETAINED, and names the missing decision.
        inadmissible = proposals[1]["hostResolved"]["admissibility"]
        self.assertEqual(inadmissible["state"], "INADMISSIBLE_RETAINED_AS_ADVISORY")
        self.assertIsNotNone(inadmissible["missingDecision"])
        self.assertNotEqual(inadmissible["missingDecision"]["owner"].strip(), "")

    def _assert_no_authority_key(self, node, path):
        terms = ["authority", "principal", "workspace", "grant", "budget", "digest",
                 "policy", "credential", "token", "actor", "attest", "signature",
                 "permission", "receipt"]
        if isinstance(node, list):
            for i, child in enumerate(node):
                self._assert_no_authority_key(child, "%s/%d" % (path, i))
            return
        if not isinstance(node, dict):
            return
        for key, child in node.items():
            folded = key.lower()
            for term in terms:
                self.assertNotIn(term, folded, "%s/%s" % (path, key))
            self._assert_no_authority_key(child, "%s/%s" % (path, key))

    def test_the_report_keeps_its_three_status_fields_apart(self):
        """REP-02, as committed data: the three fields disagree on purpose."""
        report = _read_json("research-report-1-partial", "input.json")
        self.assertIn(report["reportCompleteness"], VOCABULARIES["REPORT_COMPLETENESS"])
        self.assertIn(report["runTerminalState"], VOCABULARIES["RUN_TERMINAL_STATES"])
        self.assertEqual(report["reportCompleteness"], "PARTIAL")
        self.assertEqual(report["runTerminalState"], "PARTIALLY_COMPLETED")
        self.assertEqual(
            report["assessmentCoverage"],
            {"claimsTotal": 2, "claimsWithStoredAssessment": 1, "claimsNotAssessed": 1},
        )
        # The counts are checkable against the claim list, which is what stops
        # coverage from being a number a report simply asserts.
        self.assertEqual(len(report["claims"]), report["assessmentCoverage"]["claimsTotal"])
        stored = [c for c in report["claims"] if c["assessmentRef"] is not None]
        self.assertEqual(len(stored), report["assessmentCoverage"]["claimsWithStoredAssessment"])
        # §22.2: the entries REFERENCE an assessment; none carries a status.
        for entry in report["claims"]:
            self.assertNotIn("assessmentStatus", entry)
            self.assertNotIn("assessment_status", entry)
            self.assertNotIn("status", entry)
        self.assertIsNotNone(report["stopExplanation"])

    def test_an_outcome_that_disproved_its_hypothesis_is_still_helpful(self):
        """OUT-01, and OUT-02's independence, from the data."""
        outcome = _read_json("outcome-record-1-helpful-disproved", "input.json")
        self.assertIn(outcome["outcomeClass"], VOCABULARIES["OUTCOME_CLASSES"])
        self.assertIn(outcome["hypothesisResult"], VOCABULARIES["HYPOTHESIS_RESULTS"])
        self.assertEqual(outcome["outcomeClass"], "HELPFUL_OBSERVED")
        self.assertEqual(outcome["hypothesisResult"], "DISPROVED_BY_RESULT")
        self.assertNotEqual(outcome["authoringIdentity"], outcome["assessingIdentity"])
        # OUT-03: three separate evidence fields, not one ranked enum.
        self.assertEqual(
            sorted(outcome["evidence"]),
            ["linkedFollowThrough", "measuredCounterfactual", "temporalAssociation"],
        )
        self.assertIs(outcome["causationClaimed"], False)

    def test_the_failed_read_carries_no_content_at_all(self):
        """SRC-04, checked from the data rather than from a validator.

        A success record with empty text is the shape the rule exists to refuse,
        so the committed failure vector must have `content` genuinely absent —
        null, not an object whose strings happen to be "".
        """
        value = _read_json("source-record-3-unsupported-format", "input.json")
        self.assertIsNone(value["content"])
        self.assertEqual(value["completeness"], "NOT_OBTAINED")
        self.assertEqual(value["matchState"], "NOT_SEARCHED")
        self.assertIsNone(value["coversEntireDocument"])
        # The positive control on the same three fields: the obtained read fills
        # every one of them, so the nulls above are the failure being recorded
        # and not a fixture that forgot to say anything.
        obtained = _read_json("source-record-1-repository-read", "input.json")
        self.assertIsNotNone(obtained["content"])
        self.assertEqual(obtained["completeness"], "FULL_REQUESTED_RANGE")
        self.assertEqual(obtained["matchState"], "MATCHED")
        self.assertIs(obtained["coversEntireDocument"], False)


class RefusalCases(unittest.TestCase):
    """The shared refusal file, evaluated as far as Python honestly can.

    src/vectors.test.ts runs the validators over these records and asserts the
    exact issue each one produces. Python asserts the file's shape, and
    independently evaluates the enum-drift cases against its own pinned
    vocabularies — the one part of the refusal contract that does not need a
    validator to check.
    """

    def setUp(self):
        self.doc = _read_json("refusal-cases.json")

    def test_the_refusals_are_not_all_one_shape(self):
        self.assertEqual(self.doc["schemaVersion"], 1)
        cases = self.doc["cases"]
        self.assertGreaterEqual(len(cases), 20)
        codes = set()
        for case in cases:
            with self.subTest(label=case["label"]):
                self.assertTrue(case["expectedIssue"]["path"].startswith("/"))
                self.assertNotEqual(case["expectedIssue"]["code"], "")
                self.assertIn(
                    case["kind"],
                    [
                        "research-request",
                        "context-binding",
                        "source-record",
                        "source-citation",
                        "claim-record",
                        "claim-assessment",
                        "research-report",
                        "decision-proposal",
                        "outcome-record",
                    ],
                )
                codes.add(case["expectedIssue"]["code"])
        # Twenty copies of one refusal shape would exercise one branch of one
        # allowlist and read as full coverage.
        self.assertGreaterEqual(len(codes), 15)
        self.assertEqual(len(set(c["label"] for c in cases)), len(cases))

    def test_the_codes_the_oracle_exists_for_are_present(self):
        """Named codes, so deleting the case that carries one fails here.

        A count floor cannot notice which case went missing, and the cases
        below are the ones the requirement documents name: support that was not
        earned, a review a failed check did not perform, an inline model-written
        status, a proposal claiming execution, and an author certifying its own
        work useful.
        """
        codes = set(c["expectedIssue"]["code"] for c in self.doc["cases"])
        for code in [
            "unearned_support",
            "unavailable_check_claims_review",
            "inline_assessment_status",
            "proposal_claims_execution_authority",
            "authority_field_in_model_payload",
            "self_certified_usefulness",
            "causation_without_counterfactual",
            "inference_labeled_as_observed",
            "hypothesis_without_discriminating_test",
        ]:
            self.assertIn(code, codes)

    def test_enum_drift_values_are_outside_their_vocabularies(self):
        drifts = [c for c in self.doc["cases"] if "vocabulary" in c]
        self.assertGreaterEqual(len(drifts), 4)
        for case in drifts:
            with self.subTest(label=case["label"]):
                vocabulary = VOCABULARIES[case["vocabulary"]]
                drifted = _at_pointer(case["record"], case["expectedIssue"]["path"])
                self.assertIsNot(drifted, _MISSING)
                self.assertNotIn(drifted, vocabulary)

    def test_the_valid_vectors_name_members_at_the_same_paths(self):
        """The positive control for the check above.

        Without it, "the drifted value is not a member" would also hold for a
        vocabulary that is empty, for a pointer that resolves to nothing, and
        for a field nobody reads.
        """
        drifts = [c for c in self.doc["cases"] if "vocabulary" in c]
        checked = 0
        for name in EXPECTED_VECTORS:
            record = _read_json(name, "input.json")
            for case in drifts:
                value = _at_pointer(record, case["expectedIssue"]["path"])
                if value is _MISSING:
                    continue
                with self.subTest(vector=name, path=case["expectedIssue"]["path"]):
                    self.assertIn(value, VOCABULARIES[case["vocabulary"]])
                checked += 1
        self.assertGreaterEqual(checked, len(drifts))


if __name__ == "__main__":
    unittest.main()
