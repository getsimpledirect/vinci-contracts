"""Strict Python implementation of ReviewPublicationAttribution v1.

This module mirrors the TypeScript transport contract for cross-language
fixtures. Validation never grants publication authority: VGC must derive actor
and session binding server-side, and Acceptance must authenticate, resolve the
issuer key and role/status, verify the signature, and re-resolve the PR.
"""

import base64
import binascii
import hashlib
import json
import re
import unicodedata
from datetime import datetime


PURPOSE = "guard_review.publish"
AUDIENCE = "vinci-acceptance"
MAX_LIFETIME_MS = 600_000
SAFE_INTEGER = 9_007_199_254_740_991

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
REVIEW_ID = re.compile(r"^grv_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
NODE_ID = re.compile(r"^[\x21-\x7e]{1,255}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")

ATTRIBUTION_FIELDS = {
    "schemaVersion", "purpose", "audience", "actor", "binding", "subject",
    "verdict", "recordSetDigest", "idempotencyKey", "issuedAt", "expiresAt",
    "issuerKeyId", "signature",
}
BINDING_FIELDS = {
    "protocolVersion", "organizationId", "workspaceId", "runId", "sessionId",
}
SUBJECT_FIELDS = {
    "provider", "repositoryNodeId", "pullRequestNumber", "headSha", "baseSha",
    "headTreeSha",
}
SIGNATURE_FIELDS = {"alg", "value"}
ACTOR_RULES = {
    "user": ({"kind", "userId", "deviceId"}, {"userId"}),
    "worker": ({"kind", "workerId"}, {"workerId"}),
    "policy": ({"kind", "policyId", "policyVersion"}, {"policyId", "policyVersion"}),
    "system": ({"kind", "component"}, {"component"}),
    "verifier": ({"kind", "verifierId", "independent"}, {"verifierId", "independent"}),
}


class ContractError(ValueError):
    """Fail-closed wire validation error with a stable code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _error(code, message):
    raise ContractError(code, message)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _error("duplicate_field", "duplicate object member names are forbidden")
        result[key] = value
    return result


def _integer(token):
    value = int(token)
    if token == "-0" or abs(value) > SAFE_INTEGER:
        _error("unsafe_integer", "JSON integers must be safe integers other than -0")
    return value


def _float(_token):
    _error("ambiguous_number", "signed review attribution JSON permits only safe integers")


def parse_strict_json(source):
    """Parse UTF-8 JSON without duplicate keys, floats, unsafe integers or surrogates."""
    if isinstance(source, bytes):
        try:
            source = source.decode("utf-8", "strict")
        except UnicodeDecodeError as exc:
            raise ContractError("invalid_utf8", "signed JSON bytes must be valid UTF-8") from exc
    if not isinstance(source, str):
        _error("invalid_json_input", "expected a JSON string or UTF-8 bytes")
    try:
        value = json.loads(
            source,
            object_pairs_hook=_pairs,
            parse_int=_integer,
            parse_float=_float,
            parse_constant=lambda _value: _error("invalid_json", "non-finite JSON number"),
        )
    except ContractError:
        raise
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ContractError("invalid_json", "signed JSON could not be parsed") from exc
    _validate_unicode(value)
    return value


def _validate_unicode(value):
    if isinstance(value, str):
        for char in value:
            if 0xD800 <= ord(char) <= 0xDFFF:
                _error("invalid_unicode", "strings must contain only Unicode scalar values")
        if unicodedata.normalize("NFC", value) != value:
            _error("non_canonical_unicode", "strings must use Unicode NFC normalization")
    elif isinstance(value, list):
        for item in value:
            _validate_unicode(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _validate_unicode(key)
            _validate_unicode(item)


def _record(value, label):
    if type(value) is not dict:
        _error("invalid_record", f"{label} must be a plain object")
    return value


def _exact_fields(value, expected, label):
    keys = set(value)
    if keys != expected:
        _error("invalid_fields", f"{label} must carry exactly its declared fields")


def _identifier(value, label):
    if not isinstance(value, str) or ID.fullmatch(value) is None:
        _error("invalid_id", f"{label} must be an identifier")


def _timestamp(value, label):
    if not isinstance(value, str) or TIMESTAMP.fullmatch(value) is None:
        _error("invalid_timestamp", f"{label} must be a canonical UTC timestamp")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise ContractError("invalid_timestamp", f"{label} must exist") from exc


def _canonical_base64url(value, length, label):
    if not isinstance(value, str) or BASE64URL.fullmatch(value) is None:
        _error("invalid_base64url", f"{label} must be canonical unpadded base64url")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))
    except (ValueError, binascii.Error) as exc:
        raise ContractError("invalid_base64url", f"{label} is malformed") from exc
    encoded = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if encoded != value or len(decoded) != length:
        _error("invalid_base64url", f"{label} has a non-canonical encoding or wrong length")
    return decoded


def _validate_actor(value):
    actor = _record(value, "actor")
    kind = actor.get("kind")
    if kind not in ACTOR_RULES:
        _error("invalid_actor", "actor must be one member of the central Actor union")
    permitted, required = ACTOR_RULES[kind]
    if not required.issubset(actor) or not set(actor).issubset(permitted):
        _error("invalid_actor", "actor fields do not match its kind")
    for field in required:
        current = actor[field]
        if field == "independent":
            if type(current) is not bool:
                _error("invalid_actor", "independent must be boolean")
        elif field == "policyVersion":
            if type(current) is not int or current < 1 or current > SAFE_INTEGER:
                _error("unsafe_integer", "policyVersion must be a positive safe integer")
        elif not isinstance(current, str) or not current.strip():
            _error("invalid_actor", f"{field} must be non-blank text")
    if "deviceId" in actor and (not isinstance(actor["deviceId"], str) or not actor["deviceId"].strip()):
        _error("invalid_actor", "deviceId must be non-blank text")
    identity_fields = {
        "user": ("userId", "deviceId"),
        "worker": ("workerId",),
        "policy": ("policyId",),
        "system": ("component",),
        "verifier": ("verifierId",),
    }[kind]
    for field in identity_fields:
        if field in actor:
            _identifier(actor[field], field)


def _validate_binding(value):
    binding = _record(value, "binding")
    _exact_fields(binding, BINDING_FIELDS, "binding")
    if binding["protocolVersion"] != 1 or type(binding["protocolVersion"]) is not int:
        _error("protocol_version_mismatch", "binding protocolVersion must be 1")
    if binding["organizationId"] is not None:
        _identifier(binding["organizationId"], "organizationId")
    for field in ("workspaceId", "runId", "sessionId"):
        _identifier(binding[field], field)


def _validate_subject(value):
    subject = _record(value, "subject")
    _exact_fields(subject, SUBJECT_FIELDS, "subject")
    if subject["provider"] != "github":
        _error("invalid_provider", "provider must be github")
    if not isinstance(subject["repositoryNodeId"], str) or NODE_ID.fullmatch(subject["repositoryNodeId"]) is None:
        _error("invalid_github_node_id", "repositoryNodeId is malformed")
    number = subject["pullRequestNumber"]
    if type(number) is not int or number < 1 or number > SAFE_INTEGER:
        _error("invalid_pull_request_number", "pullRequestNumber must be a positive safe integer")
    for field in ("headSha", "baseSha", "headTreeSha"):
        if not isinstance(subject[field], str) or GIT_SHA.fullmatch(subject[field]) is None:
            _error("invalid_git_sha", f"{field} must be exact lowercase 40-hex")


def validate_attribution(value, now):
    """Return a detached validated snapshot, or raise ContractError."""
    _validate_unicode(value)
    record = _record(value, "attribution")
    _exact_fields(record, ATTRIBUTION_FIELDS, "attribution")
    if record["schemaVersion"] != 1 or type(record["schemaVersion"]) is not int:
        _error("schema_version_mismatch", "schemaVersion must be 1")
    if record["purpose"] != PURPOSE:
        _error("invalid_purpose", f"purpose must be {PURPOSE}")
    if record["audience"] != AUDIENCE:
        _error("invalid_audience", f"audience must be {AUDIENCE}")
    _validate_actor(record["actor"])
    _validate_binding(record["binding"])
    _validate_subject(record["subject"])
    if record["verdict"] not in ("GO", "BLOCK"):
        _error("invalid_verdict", "verdict must be GO or BLOCK")
    if not isinstance(record["recordSetDigest"], str) or DIGEST.fullmatch(record["recordSetDigest"]) is None:
        _error("invalid_digest", "recordSetDigest must be lowercase SHA-256")
    _identifier(record["idempotencyKey"], "idempotencyKey")
    _identifier(record["issuerKeyId"], "issuerKeyId")
    issued = _timestamp(record["issuedAt"], "issuedAt")
    expires = _timestamp(record["expiresAt"], "expiresAt")
    current = _timestamp(now, "now")
    lifetime_ms = int((expires - issued).total_seconds() * 1000)
    if lifetime_ms <= 0:
        _error("invalid_time_order", "expiresAt must be strictly later than issuedAt")
    if lifetime_ms > MAX_LIFETIME_MS:
        _error("lifetime_exceeded", "attribution lifetime must not exceed ten minutes")
    if expires <= current:
        _error("expired", "attribution has expired")
    signature = _record(record["signature"], "signature")
    _exact_fields(signature, SIGNATURE_FIELDS, "signature")
    if signature["alg"] != "Ed25519":
        _error("invalid_signature_algorithm", "only Ed25519 is supported")
    _canonical_base64url(signature["value"], 64, "signature.value")
    # JSON contains only the types allowed above, so this gives a detached copy.
    return json.loads(json.dumps(record, ensure_ascii=False))


def parse_attribution_json(source, now):
    return validate_attribution(parse_strict_json(source), now)


def canonical_signing_bytes(attribution):
    """Return the exact bytes signed by VGC; signature.value is excluded."""
    covered = {
        "schemaVersion": attribution["schemaVersion"],
        "purpose": attribution["purpose"],
        "audience": attribution["audience"],
        "actor": attribution["actor"],
        "binding": attribution["binding"],
        "subject": attribution["subject"],
        "verdict": attribution["verdict"],
        "recordSetDigest": attribution["recordSetDigest"],
        "idempotencyKey": attribution["idempotencyKey"],
        "issuedAt": attribution["issuedAt"],
        "expiresAt": attribution["expiresAt"],
        "issuerKeyId": attribution["issuerKeyId"],
        "signature": {"alg": attribution["signature"]["alg"]},
    }
    return json.dumps(
        covered,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def attribution_digest(attribution):
    return hashlib.sha256(canonical_signing_bytes(attribution)).hexdigest()


def decode_public_key(value):
    return _canonical_base64url(value, 32, "public key")


def parse_review_reference(value):
    if not isinstance(value, str) or value.count("@sha256:") != 1:
        _error("invalid_review_reference", "expected grv_<id>@sha256:<digest>")
    review_id, publication_digest = value.split("@sha256:")
    if REVIEW_ID.fullmatch(review_id) is None or DIGEST.fullmatch(publication_digest) is None:
        _error("invalid_review_reference", "review id or publication digest is malformed")
    return {"reviewId": review_id, "publicationDigest": publication_digest}


def format_review_reference(review_id, publication_digest):
    value = f"{review_id}@sha256:{publication_digest}"
    parse_review_reference(value)
    return value
