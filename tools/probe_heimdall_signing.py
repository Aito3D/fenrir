"""Golden probe (campaign 17): the Heimdall request signer, byte-checkable.

`sign()` and `parse_credential()` decide whether every payment call is
accepted at all, so they are pinned two ways here:

1. Against the WORKED EXAMPLE in ../heimdall/docs/API.md ("A worked,
   byte-checkable example") — credential, timestamp, nonce, body and the
   resulting `sha256=a1bb7a33...` are copied from that document, which says
   the hex is the real output of Heimdall's own `signParts`. This is the one
   check that is not a re-derivation of Bambuddy's own recipe: if the six
   canonical lines, the join order, the body hashing or the hex case ever
   drift, this constant stops matching. backend/tests/unit/test_heimdall_client.py
   recomputes the HMAC with the same recipe it is testing, so it cannot see
   that class of drift; this can.
2. Across an edge matrix — absent Idempotency-Key (a PRESENT, empty sixth
   line), empty body, lower-case method, query string in the path, unicode
   and byte-preserving bodies, and the credential shapes that must be
   rejected.

Pure functions only: no network, no database, no clock, no randomness.
"""

import hashlib
import json
import sys

sys.path.insert(0, ".")

from backend.app.services.heimdall import (  # noqa: E402
    HeimdallNotConfigured,
    parse_credential,
    sign,
)

# --- the documented vector, copied verbatim from ../heimdall/docs/API.md ----
DOC_CREDENTIAL = "hmd_live.84f32b71ac095ed2.2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o"
DOC_KEY_ID = "84f32b71ac095ed2"
DOC_SECRET = "2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o"
DOC_BODY = b'{"method":"link","amount":12500,"currency":"XPF","reference":"DEV-000123"}'
DOC_BODY_HASH = "99eb0c2b3f879ac29817de0807b2fde2f25a76cb2c35c1505c4800af2f3c6696"
DOC_TIMESTAMP = 1757707200
DOC_NONCE = "n0nce_1757707200abcXYZ"
DOC_IDEMPOTENCY = "order-42"
DOC_SIGNATURE = "sha256=a1bb7a336acc3afee8dabca6aa3ee6b0366a88972a91bc1137a1879beb30fc5c"
# The empty-body hash the contract names explicitly ("e3b0c442...b855").
EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

out: dict = {}

# 1. parse_credential against the documented credential.
out["01-parse-documented-credential"] = list(parse_credential(DOC_CREDENTIAL))

# 2. The body hash the document states, from the same bytes.
out["02-documented-body-hash"] = {
    "computed": hashlib.sha256(DOC_BODY).hexdigest(),
    "documented": DOC_BODY_HASH,
    "match": hashlib.sha256(DOC_BODY).hexdigest() == DOC_BODY_HASH,
}

# 3. THE signature check: our signer vs Heimdall's own published output.
doc_sig = sign("POST", "/api/v1/payments", DOC_BODY, DOC_SECRET, DOC_TIMESTAMP, DOC_NONCE, DOC_IDEMPOTENCY)
out["03-documented-signature"] = {
    "computed": doc_sig,
    "documented": DOC_SIGNATURE,
    "match": doc_sig == DOC_SIGNATURE,
}

# 4. The empty-body hash the contract names, and that a body-less request
#    signs it rather than hashing the string "None" or "{}".
out["04-empty-body-hash"] = {
    "computed": hashlib.sha256(b"").hexdigest(),
    "documented": EMPTY_BODY_HASH,
    "match": hashlib.sha256(b"").hexdigest() == EMPTY_BODY_HASH,
}

# 5. Edge matrix. Each row pins one property of the recipe. The signatures
#    are golden values: any change to the canonical string changes them.
CASES = [
    ("method-lowercased", "post", "/api/v1/ping", b"", ""),
    ("method-already-upper", "POST", "/api/v1/ping", b"", ""),
    ("get-no-body-no-idem", "GET", "/api/v1/ping", b"", ""),
    # A present-but-empty sixth line, not an omitted one: these two MUST
    # differ from a five-line signer and MUST equal each other.
    ("idem-absent-empty-string", "POST", "/api/v1/payments", DOC_BODY, ""),
    ("idem-present", "POST", "/api/v1/payments", DOC_BODY, "aito:1:1"),
    # Path is signed exactly as sent, query string included.
    ("path-with-query", "GET", "/api/v1/payments?limit=10", b"", ""),
    ("path-trailing-slash", "GET", "/api/v1/payments/", b"", ""),
    # Bodies must be hashed as bytes, never re-serialised.
    ("body-unicode", "PATCH", "/api/v1/payments/x", "{\"reference\":\"Café-Ü\"}".encode("utf-8"), ""),
    ("body-whitespace-differs", "PATCH", "/api/v1/payments/x", b'{"amount": 1}', ""),
    ("body-key-order-differs", "PATCH", "/api/v1/payments/x", b'{"b":1,"a":2}', ""),
    # Secrets containing base64url characters must key the HMAC unchanged.
    ("secret-base64url", "POST", "/api/v1/payments", DOC_BODY, "order-42"),
]
rows = []
for name, method, path, body, idem in CASES:
    secret = DOC_SECRET
    rows.append(
        {
            "case": name,
            "method": method,
            "path": path,
            "body_len": len(body),
            "body_sha256": hashlib.sha256(body).hexdigest(),
            "idempotency_key": idem,
            "signature": sign(method, path, body, secret, DOC_TIMESTAMP, DOC_NONCE, idem),
        }
    )
out["05-edge-matrix"] = rows

# 6. The default sixth line: sign() called WITHOUT the idempotency argument
#    must equal sign() called with "" — the client relies on that default for
#    every unkeyed call (ping, get, cancel, patch).
default_call = sign("GET", "/api/v1/ping", b"", DOC_SECRET, DOC_TIMESTAMP, DOC_NONCE)
explicit_empty = sign("GET", "/api/v1/ping", b"", DOC_SECRET, DOC_TIMESTAMP, DOC_NONCE, "")
out["06-default-idempotency-line"] = {
    "default": default_call,
    "explicit_empty": explicit_empty,
    "match": default_call == explicit_empty,
}

# 7. A five-line signer (the retired form) must NOT collide with ours — the
#    contract's upgrade note says the five-line form is rejected, so the two
#    signatures differing is the property worth pinning.
import hmac as _hmac  # noqa: E402

five_line = "sha256=" + _hmac.new(
    DOC_SECRET.encode(),
    "\n".join(["POST", "/api/v1/payments", str(DOC_TIMESTAMP), DOC_NONCE, DOC_BODY_HASH]).encode(),
    hashlib.sha256,
).hexdigest()
out["07-five-line-form-differs"] = {
    "five_line": five_line,
    "six_line": doc_sig,
    "differ": five_line != doc_sig,
}

# 8. Credential shapes. Anything not `hmd_*.<key_id>.<secret>` must raise
#    HeimdallNotConfigured — a token typed into Settings reaches here.
BAD = [
    "",
    "hmd_live",
    "hmd_live.onlytwo",
    "hmd_live..secret",
    "hmd_live.keyid.",
    ".keyid.secret",
    "bearer_live.keyid.secret",
    "hmd_live.keyid.secret.extra",
    "HMD_LIVE.keyid.secret",
    "hmd_test.keyid.secret",
    "  hmd_live.keyid.secret  ",
]
bad_rows = []
for token in BAD:
    try:
        bad_rows.append({"token": token, "outcome": "parsed", "parts": list(parse_credential(token))})
    except HeimdallNotConfigured as e:
        bad_rows.append({"token": token, "outcome": "HeimdallNotConfigured", "message": str(e)})
    except Exception as e:  # anything else is a leak worth seeing in the golden
        bad_rows.append({"token": token, "outcome": type(e).__name__, "message": str(e)})
out["08-credential-shapes"] = bad_rows

# 9. A secret is never returned in an error message (a token lands in logs
#    otherwise). Pin that the rejection text carries no secret material.
try:
    parse_credential("hmd_live.keyid.s3cret.extra")
except HeimdallNotConfigured as e:
    out["09-error-text-has-no-secret"] = {"message": str(e), "leaks_secret": "s3cret" in str(e)}

print(json.dumps(out, sort_keys=True, indent=1))
