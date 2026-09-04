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
MAX_SIGNED_JSON_BYTES = 1_000_000
MAX_SIGNED_JSON_DEPTH = 32
MAX_SIGNED_JSON_NODES = 200_000
MAX_SIGNED_JSON_MEMBERS = 10_000
MAX_SIGNED_JSON_STRING_BYTES = 262_144

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
REVIEW_ID = re.compile(r"^grv_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
NODE_ID = re.compile(r"^[\x21-\x7e]{1,255}$")
TIMESTAMP = re.compile(r"^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
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
        if len(source) > MAX_SIGNED_JSON_BYTES:
            _error("too_large", "signed JSON exceeds the input byte limit")
        try:
            source = source.decode("utf-8", "strict")
        except UnicodeDecodeError as exc:
            raise ContractError("invalid_utf8", "signed JSON bytes must be valid UTF-8") from exc
    if not isinstance(source, str):
        _error("invalid_json_input", "expected a JSON string or UTF-8 bytes")
    try:
        encoded = source.encode("utf-8", "strict")
        if len(encoded) > MAX_SIGNED_JSON_BYTES:
            _error("too_large", "signed JSON exceeds the input byte limit")
        value = json.loads(
            source,
            object_pairs_hook=_pairs,
            parse_int=_integer,
            parse_float=_float,
            parse_constant=lambda _value: _error("invalid_json", "non-finite JSON number"),
        )
    except ContractError:
        raise
    except RecursionError as exc:
        raise ContractError("too_deep", "signed JSON exceeds the nesting limit") from exc
    except UnicodeEncodeError as exc:
        raise ContractError("invalid_unicode", "strings must contain only Unicode scalar values") from exc
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ContractError("invalid_json", "signed JSON could not be parsed") from exc
    try:
        return _bounded_snapshot(value)
    except RecursionError as exc:
        raise ContractError("too_deep", "signed JSON exceeds the nesting limit") from exc


def _validated_string(value):
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError as exc:
        raise ContractError("invalid_unicode", "strings must contain only Unicode scalar values") from exc
    if len(encoded) > MAX_SIGNED_JSON_STRING_BYTES:
        _error("too_large", "a signed JSON string exceeds the byte limit")
    if unicodedata.normalize("NFC", value) != value:
        _error("non_canonical_unicode", "strings must use Unicode NFC normalization")
    return value


def _bounded_snapshot(value):
    """Copy one JSON value while enforcing shared depth, width, node and string bounds."""
    nodes = [0]
    active = set()

    def walk(current, depth):
        if depth > MAX_SIGNED_JSON_DEPTH:
            _error("too_deep", "signed JSON exceeds the nesting limit")
        nodes[0] += 1
        if nodes[0] > MAX_SIGNED_JSON_NODES:
            _error("too_many_nodes", "signed JSON exceeds the value-count limit")

        if current is None or type(current) is bool:
            return current
        if type(current) is int:
            if abs(current) > SAFE_INTEGER:
                _error("unsafe_integer", "JSON integers must be safe integers")
            return current
        if type(current) is float:
            _error("ambiguous_number", "signed review attribution JSON permits only safe integers")
        if type(current) is str:
            return _validated_string(current)

        if type(current) not in (dict, list):
            _error("unsupported_value", "signed JSON contains a non-JSON value")
        if len(current) > MAX_SIGNED_JSON_MEMBERS:
            _error("too_many_keys", "a signed JSON container exceeds the member limit")
        identity = id(current)
        if identity in active:
            _error("not_serializable", "a data record must be inert and free of cycles")
        active.add(identity)
        try:
            if type(current) is list:
                return [walk(item, depth + 1) for item in current]
            result = {}
            for key, item in current.items():
                if type(key) is not str:
                    _error("invalid_record", "JSON object member names must be strings")
                result[_validated_string(key)] = walk(item, depth + 1)
            return result
        finally:
            active.remove(identity)

    return walk(value, 0)


def _record(value, label):
    if type(value) is not dict:
        _error("invalid_record", f"{label} must be a plain object")
    return value


def _exact_fields(value, expected, label):
    keys = set(value)
    if keys != expected:
        _error("invalid_fields", f"{label} must carry exactly its declared fields")


def _identifier(value, label):
    if type(value) is not str or ID.fullmatch(value) is None:
        _error("invalid_id", f"{label} must be an identifier")


def _timestamp(value, label):
    if type(value) is not str or TIMESTAMP.fullmatch(value) is None:
        _error("invalid_timestamp", f"{label} must be a canonical UTC timestamp")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise ContractError("invalid_timestamp", f"{label} must exist") from exc


def _timestamp_pair(record):
    issued = _timestamp(record["issuedAt"], "issuedAt")
    expires = _timestamp(record["expiresAt"], "expiresAt")
    lifetime_ms = int((expires - issued).total_seconds() * 1000)
    if lifetime_ms <= 0:
        _error("invalid_time_order", "expiresAt must be strictly later than issuedAt")
    if lifetime_ms > MAX_LIFETIME_MS:
        _error("lifetime_exceeded", "attribution lifetime must not exceed ten minutes")
    return issued, expires


def _canonical_base64url(value, length, label):
    if type(value) is not str or BASE64URL.fullmatch(value) is None:
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
    if type(kind) is not str or kind not in ACTOR_RULES:
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
        elif type(current) is not str or not current.strip():
            _error("invalid_actor", f"{field} must be non-blank text")
    if "deviceId" in actor and (type(actor["deviceId"]) is not str or not actor["deviceId"].strip()):
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
    if type(subject["repositoryNodeId"]) is not str or NODE_ID.fullmatch(subject["repositoryNodeId"]) is None:
        _error("invalid_github_node_id", "repositoryNodeId is malformed")
    number = subject["pullRequestNumber"]
    if type(number) is not int or number < 1 or number > SAFE_INTEGER:
        _error("invalid_pull_request_number", "pullRequestNumber must be a positive safe integer")
    for field in ("headSha", "baseSha", "headTreeSha"):
        if type(subject[field]) is not str or GIT_SHA.fullmatch(subject[field]) is None:
            _error("invalid_git_sha", f"{field} must be exact lowercase 40-hex")


def _preflight_fields(value):
    """Reject foreign fields before walking any value they could point at."""
    record = _record(value, "attribution")
    _exact_fields(record, ATTRIBUTION_FIELDS, "attribution")
    binding = _record(record["binding"], "binding")
    _exact_fields(binding, BINDING_FIELDS, "binding")
    subject = _record(record["subject"], "subject")
    _exact_fields(subject, SUBJECT_FIELDS, "subject")
    signature = _record(record["signature"], "signature")
    _exact_fields(signature, SIGNATURE_FIELDS, "signature")
    actor = _record(record["actor"], "actor")
    kind = actor.get("kind")
    if type(kind) is not str or kind not in ACTOR_RULES:
        _error("invalid_actor", "actor must be one member of the central Actor union")
    permitted, required = ACTOR_RULES[kind]
    if not required.issubset(actor) or not set(actor).issubset(permitted):
        _error("invalid_actor", "actor fields do not match its kind")
    return record


def validate_attribution(value, now):
    """Return a detached validated snapshot, or raise ContractError."""
    try:
        record = _bounded_snapshot(_preflight_fields(value))
        return _validate_attribution_snapshot(record, now)
    except RecursionError as exc:
        raise ContractError("too_deep", "signed JSON exceeds the nesting limit") from exc


def _validate_attribution_snapshot(record, now):
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
    if type(record["recordSetDigest"]) is not str or DIGEST.fullmatch(record["recordSetDigest"]) is None:
        _error("invalid_digest", "recordSetDigest must be lowercase SHA-256")
    _identifier(record["idempotencyKey"], "idempotencyKey")
    _identifier(record["issuerKeyId"], "issuerKeyId")
    _issued, expires = _timestamp_pair(record)
    current = _timestamp(now, "now")
    if expires <= current:
        _error("expired", "attribution has expired")
    signature = _record(record["signature"], "signature")
    _exact_fields(signature, SIGNATURE_FIELDS, "signature")
    if signature["alg"] != "Ed25519":
        _error("invalid_signature_algorithm", "only Ed25519 is supported")
    _canonical_base64url(signature["value"], 64, "signature.value")
    return record


def parse_attribution_json(source, now):
    return validate_attribution(parse_strict_json(source), now)


def canonical_signing_bytes(attribution):
    """Return the exact bytes signed by VGC; signature.value is excluded."""
    try:
        attribution = _bounded_snapshot(_preflight_fields(attribution))
        _timestamp_pair(attribution)
    except RecursionError as exc:
        raise ContractError("too_deep", "signed JSON exceeds the nesting limit") from exc
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
    if type(value) is not str or len(value) > 200 or value.count("@sha256:") != 1:
        _error("invalid_review_reference", "expected grv_<id>@sha256:<digest>")
    review_id, publication_digest = value.split("@sha256:")
    if REVIEW_ID.fullmatch(review_id) is None or DIGEST.fullmatch(publication_digest) is None:
        _error("invalid_review_reference", "review id or publication digest is malformed")
    return {"reviewId": review_id, "publicationDigest": publication_digest}


def format_review_reference(review_id, publication_digest):
    if type(review_id) is not str or type(publication_digest) is not str:
        _error("invalid_review_reference", "review id and publication digest must be strings")
    value = f"{review_id}@sha256:{publication_digest}"
    parse_review_reference(value)
    return value
