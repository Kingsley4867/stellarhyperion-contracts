"""Retain default secret rules while recognizing narrowly reviewed public fixtures."""

import base64
import binascii
from pathlib import Path
import re
import sys

PUBLIC_ACCOUNT_FIXTURES = (
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR",
)
FIXTURE_PATH = "script/stellar/test/reconcile-axelar.test.mjs"
PUBLIC_CONTRACT_FIXTURES = (
    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
)
SYNTHETIC_CONTRACT_FIXTURES = (
    "CGAS7PQXN7P55U25D2BWWX7AUKC7E3AOP7XGQLB7IYY3Z3QWVQO32GAS",
)
AUTH_SNAPSHOT_FIXTURE_PATHS = (
    "script/stellar/test/fixtures/auth-snapshots/changed-amount/snapshot.json",
    "script/stellar/test/fixtures/auth-snapshots/changed-gas-recipient/snapshot.json",
    "script/stellar/test/fixtures/auth-snapshots/changed-spender/snapshot.json",
    "script/stellar/test/fixtures/auth-snapshots/unexpected-sub-invocation/snapshot.json",
    "script/stellar/test/fixtures/auth-snapshots/changed-fee-recipient/snapshot.json",
    "script/stellar/test/fixtures/auth-snapshots/valid-paid-dispatch/snapshot.json",
    "script/stellar/test/inspect-axelar-auth.test.mjs",
)
INVALID_CHECKSUM_FIXTURE = "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNV"
INVALID_CHECKSUM_FIXTURE_PATHS = (
    "evm/test/unit/AxelarItsAdapter.t.sol",
    "evm/test/unit/CctpAdapter.t.sol",
)

# Exact SHA-256 digests independently recomputed from the pinned host source and
# verified by verify_vendor_provenance.py. These are public content identifiers,
# not a general exemption for hexadecimal values or provenance files.
VENDOR_PROVENANCE_PATH = "soroban/vendor/provenance.json"
PINNED_VENDOR_SOURCE_HASHES = (
    "f4ebe6be192c96de1f9668767239b5dd8f3a272ca3cecebfee1fc67268f4354a",
    "8307d3aeaf9c1a7c8199d2107714aff9c298ae299475ec4470ad28ead446e91b",
    "f3ae7c92ba3f2e9b80cfee73b1b6eba1b3edffbf2c7d92ee1ec649f618617690",
    "21256191032a43cd2584275eebae7e034db553ee6c90c16d6ba5e5e2392eb69a",
    "9a4f2d3589e16a163155ba0c1fd0eeee1263867084d904c3ed623ce499eebcde",
    "7cbdd4ebe2d9e1bcb6aff43af6ae682b3bf7d92e33b1695ec825ea7c418f9790",
    "6bdb8121687af7f413d0766d27f058ff77523a8e2666f5e99ab5261e46a84447",
)


def verify_public_account(value):
    """Version 48 denotes a public Ed25519 account; signing seeds use version 144."""
    if not isinstance(value, str) or not re.fullmatch(r"G[A-Z2-7]{55}", value):
        raise ValueError("Reviewed fixture must be a canonical Stellar public account")
    decoded = base64.b32decode(value)
    if (len(decoded) != 35 or decoded[0] != 48
            or decoded[-2:] != binascii.crc_hqx(decoded[:-2], 0).to_bytes(2, "little")):
        raise ValueError("Reviewed public account fixture has an invalid version or checksum")


def verify_public_contract(value):
    """Version 16 denotes a public contract; checksum validation stays mandatory."""
    if not isinstance(value, str) or not re.fullmatch(r"C[A-Z2-7]{55}", value):
        raise ValueError("Reviewed fixture must be a canonical Stellar public contract")
    decoded = base64.b32decode(value)
    if (len(decoded) != 35 or decoded[0] != 16
            or decoded[-2:] != binascii.crc_hqx(decoded[:-2], 0).to_bytes(2, "little")):
        raise ValueError("Reviewed public contract fixture has an invalid version or checksum")


def verify_synthetic_contract_fixture(value):
    """Admit only the historical dummy gas ID, which intentionally has no valid checksum."""
    if value != "CGAS7PQXN7P55U25D2BWWX7AUKC7E3AOP7XGQLB7IYY3Z3QWVQO32GAS":
        raise ValueError("Only the exact reviewed synthetic gas contract fixture is allowed")


def configuration():
    for value in PUBLIC_ACCOUNT_FIXTURES:
        verify_public_account(value)
    for value in PUBLIC_CONTRACT_FIXTURES:
        verify_public_contract(value)
    for value in SYNTHETIC_CONTRACT_FIXTURES:
        verify_synthetic_contract_fixture(value)
    # Extend this rule without replacing its regex, entropy threshold or default allowlists.
    # AND is essential: neither the path alone nor the public value in another file is exempt.
    values = "|".join(PUBLIC_ACCOUNT_FIXTURES)
    path = re.escape(FIXTURE_PATH)
    contract_values = "|".join(PUBLIC_CONTRACT_FIXTURES + SYNTHETIC_CONTRACT_FIXTURES)
    contract_paths = "|".join(re.escape(path) for path in AUTH_SNAPSHOT_FIXTURE_PATHS)
    invalid_checksum_paths = "|".join(re.escape(path) for path in INVALID_CHECKSUM_FIXTURE_PATHS)
    vendor_hashes = "|".join(PINNED_VENDOR_SOURCE_HASHES)
    vendor_path = re.escape(VENDOR_PROVENANCE_PATH)
    return f"""[extend]
useDefault = true

[[rules]]
id = "generic-api-key"
[[rules.allowlists]]
description = "Two checksum-verified public Stellar account fixtures, never signing seeds"
condition = "AND"
regexTarget = "secret"
regexes = ['''^({values})$''']
paths = ['''^{path}$''']

[[rules.allowlists]]
description = "Exact reviewed public token and synthetic gas contract IDs in paid-dispatch fixtures"
condition = "AND"
regexTarget = "secret"
regexes = ['''^({contract_values})$''']
paths = ['''^({contract_paths})$''']

[[rules.allowlists]]
description = "Seven exact independently verified public vendored-source SHA-256 digests"
condition = "AND"
regexTarget = "secret"
regexes = ['''^({vendor_hashes})$''']
paths = ['''^{vendor_path}$''']

[[rules.allowlists]]
description = "Exact malformed-checksum fixtures in adapter invalid-destination tests"
condition = "AND"
regexTarget = "secret"
regexes = ['''^({re.escape(INVALID_CHECKSUM_FIXTURE)})$''']
paths = ['''^({invalid_checksum_paths})$''']
"""


if __name__ == "__main__":
    Path(sys.argv[1]).write_text(configuration())
