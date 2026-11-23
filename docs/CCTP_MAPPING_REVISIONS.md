# CCTP token mapping revisions

CCTP mappings now bind the local token, remote token, both decimal precisions, and a monotonically
increasing revision. Dispatch requests state the revision they were prepared against. The adapter
checks the revision and the requested remote decimals before calling the messenger; inbound
revision-bearing Hyperion hooks are checked before the transmitter can mint. Amounts remain exact
integer base units throughout. A mapping update never rescales an amount; revision-bound requests
and messages from an older revision are rejected rather than reinterpreted.

## Wire compatibility

Hyperion CCTP hook version 2 carries a nonzero `u32` mapping revision before the existing tagged
destination. Stellar-to-EVM CCTP notes carry the same revision before the recipient and router
nonce. Version-1 Hyperion notes do not identify their decimal mapping and are rejected; they must
not be reinterpreted under a newer mapping.

The CCTP provider's hook format and Circle attestation format are otherwise unchanged. The paid
forwarding path retains Circle's fixed 32-byte forwarding hook and validates the caller's expected
mapping revision before the burn. That provider-forwarded message does not carry a Hyperion mapping
revision, and the destination forwarder cannot reject it based on a later mapping change. This is an
intentional compatibility boundary, not a revision-bound message guarantee; the revision check
prevents stale requests from burning. Do not append revision data to Circle's forwarding payload
without independently validating a different provider/destination protocol.

## Mapping migration

For an existing Soroban deployment, legacy asset entries remain available to read-only
administrative queries, but are not enough to authorize a receive. An administrator must call
`map_asset` with the verified local and remote decimal values and revision `1` before accepting
revisioned messages. Once revision metadata exists, updates must use a larger revision. Canonical
USDC remains `7` local decimals and `6` remote decimals for the Stellar-to-EVM mapping.

The EVM development adapter is not proxy-upgradeable. Deploy and independently validate a new
adapter, configure its explicit remote token and decimal mapping, then move the router through its
normal reviewed upgrade process. The EVM test fixtures retain the canonical inverse defaults:
`6` local decimals and `7` remote decimals. These fixtures do not certify EVM deployment readiness.

Before changing a live mapping, operators must identify and settle or otherwise account for all
in-flight messages using its prior revision. Old Hyperion hook versions are intentionally rejected
instead of being assigned the new mapping. Keep EVM and other rail development gated until their
provider integrations and message-boundary behavior have been independently validated.

## Deployment configuration

The EVM phase-one deployment script now requires `STELLAR_CCTP_TOKEN`, the verified 32-byte
Stellar-side token identity. The deployment record contains that identity, mapping revision, and
decimal pair; `Execute.s.sol`, `Verify.s.sol`, and `Smoke.s.sol` compare or use those recorded
values rather than inferring them from a token symbol.
