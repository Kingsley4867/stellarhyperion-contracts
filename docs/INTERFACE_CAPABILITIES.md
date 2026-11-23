# Contract interface capability snapshots

Every contract surface in this repository has a committed record of what it exports and which
routes it serves. The Rust, Foundry and TypeScript suites all read those records, so a surface that
changes without the record changing is a red branch rather than a release note nobody read.

The active deployment is still the Stellar Testnet router with outbound Axelar ITS and Circle CCTP.
Recording an EVM or Allbridge method here does not activate it; the `status` line is where that is
written down.

## Where the snapshots live

`testdata/capabilities/` holds one file per surface. Router and adapter surfaces are deliberately
separate: an adapter upgrade changes its own surface without touching the router, and reviewing the
two together is how an unintended router change hides inside an adapter diff.

| File                            | Surface                  | Status | Owner suite                 |
| ------------------------------- | ------------------------ | ------ | --------------------------- |
| `soroban-router.cap`            | `soroban/router`         | active | `hyperion-router`           |
| `soroban-cctp-adapter.cap`      | `soroban/cctp-adapter`   | active | `hyperion-adapter-cctp`     |
| `soroban-axelar-adapter.cap`    | `soroban/axelar-adapter` | active | `hyperion-adapter-axelar`   |
| `soroban-allbridge-adapter.cap` | `soroban/allbridge-adapter` | gated | `hyperion-adapter-allbridge` |
| `evm-router.cap`                | `evm/router`             | gated  | `packages/protocol`         |
| `evm-cctp-adapter.cap`          | `evm/cctp-adapter`       | gated  | `packages/protocol`         |
| `evm-axelar-adapter.cap`        | `evm/axelar-adapter`     | gated  | `packages/protocol`         |

`paid-method-history.txt` is the append-only memory behind the acknowledgement rule below.

## The format

Line oriented and comment friendly, so the same file is readable from Rust, Solidity and
TypeScript without a parser dependency, and an interface change is a one-line diff.

```text
surface  <chain>/<contract>        exactly one
contract <Type>                    exactly one
status   active|gated              exactly one
method   <name>                    one per exported method, sorted, unique
route    <protocol slug>           one per advertised route, unique, RouteKind order
paid-route <slug>                  routes with a local paid dispatch entry point
paid-method <name>                 entry points that attach a provider payment
removed-paid-method <name> acknowledged=<ref> reason="<why>"    a reviewed removal
```

Route slugs are the protocol values from `packages/protocol/src/routes.ts`
(`cctp`, `axelar-its`, `axelar-gmp`, `allbridge`), never free text.

## What each suite checks

**Rust (`soroban/test-support/capability.rs`, included by each crate's tests).** Validates the
grammar, then compares the record with the `pub fn` surface inside `#[contractimpl]`. On the router
it also calls `supports_paid_route` for every `RouteKind` and requires the answer to match the
`paid-route` lines, so the advertisement the app reads cannot drift from the record. On each
adapter it reads the route the deployed shape reports (`key_coverage`, `route`) and compares it
with the recorded route.

**Foundry (`evm/test/CapabilitySnapshot.t.sol`).** Reads the EVM snapshots, proves every advertised
route on the router has a registered adapter and an enabled lane, proves the paid entry points
named in the record still compile and exist, deploys each adapter and checks the route it reports,
and pins the EVM surfaces to `gated`.

**Protocol (`packages/protocol/test/capabilities.test.ts`).** Validates every file, compares the
Rust surfaces with the contract source, compares the EVM surfaces with the generated compiled ABIs
(method set and `payable` state), compares the router's `supports_paid_route` body with the
recorded paid routes, and enforces the acknowledgement, history and gating rules. Its failure cases
run against local fixture strings so the rules stay tested when the real snapshots are stable.

## Paid methods and compatibility acknowledgements

A paid method is one that moves money and also attaches a provider payment: `bridge_out_with_gas`,
`bridge_out_bounded`, `dispatch_from`, `bridgeOut`, `bridgeOutBounded`, `dispatch`. The app decides
whether it can offer a paid transfer by asking for these by name, so silently deleting one is how a
working screen turns into a revert.

If a paid method really is being removed:

1. Delete its `method` and `paid-method` lines from that surface's snapshot.
2. Add it to `paid-method-history.txt` if it is not already there. Never remove history entries.
3. Add a `removed-paid-method` line in the same change:

   ```text
   removed-paid-method bridge_out_v1 acknowledged=issue-157 reason="superseded by bridge_out_bounded; no live caller after the 2026-11 router upgrade"
   ```

   `acknowledged=` names the review reference (issue, PR or upgrade record) and `reason=` says why
   existing callers are safe. The suites reject a removal with either field missing.

The checks are symmetric: an acknowledgement naming a method that is still callable fails as
stale, and an entry in the history that is neither callable nor acknowledged fails as a silent
removal.

## Adding or changing a capability

1. Change the contract.
2. Run the surface's own suite; it will name the methods or routes that no longer match.
3. Update only that surface's `.cap` file. Keep methods sorted and routes in `RouteKind` order.
4. If the change is a paid method, follow the acknowledgement steps above.
5. Re-run the relevant suites and include the exact commands and results in the PR.

Adding a method is a reviewed interface change too: it fails the same comparison until it is
recorded, which is what keeps the snapshot from becoming a historical document.

## Migration and upgrade implications

- **Snapshots are interface records, not deployments.** Updating a file neither deploys nor
  activates anything. The router still goes through its timelock and adapters still require their
  admin; the EVM and Allbridge surfaces stay `gated` until independently validated.
- **Upgrades must be reviewed against the record first.** Before queueing a router upgrade, compare
  the new build's methods and paid routes with `soroban-router.cap`. If the diff removes a paid
  method, the upgrade record needs the compatibility acknowledgement above before it is queued.
- **Adapters upgrade on their own schedule.** Because adapter surfaces are separate files, an
  adapter upgrade that adds or removes a method cannot be mistaken for a router change, and an
  adapter's route is fixed at initialization rather than migrated in place.
- **The SDK follows the EVM ABIs.** `packages/protocol` regenerates its ABI modules from the
  Foundry build and compares them with the EVM snapshots, so a contract change that forgets the SDK
  fails locally instead of in a wallet.

## Running the checks

```bash
cd soroban && cargo test --workspace
cd evm && FOUNDRY_PROFILE=ci forge test
cd packages/protocol && npm run check
```

`script/anvil-e2e.sh` also checks a live local deployment against the EVM snapshots: every
advertised router route must have an adapter, and each deployed adapter must report its recorded
route.

## ABI, tuple and event compatibility policy

Payout-relevant ABI signatures and layouts have a strict compatibility gate. The baseline is the
compiled contract ABI and emitted event shapes, linked to the same Foundry artifacts used by
`packages/protocol/scripts/gen-artifacts.mjs`. A removal or reordering of amount, recipient,
nonce/replay or payout tuple fields is breaking and fails parity. Additive entries and tuple fields
are compatible only after a documented consumer migration assessment covering indexers, decoders,
and transaction/replay consumers.

The active deployment remains Stellar Testnet outbound ITS/CCTP. EVM and other rail surfaces remain
`gated` in the capability snapshots until independently validated. Never interpret an ABI change as
activation evidence. Event and tuple changes require a versioned schema or migration record; exact
integer values must remain exact, rail dispatch authenticated, replay state protected, and claims
bound to their recorded recipient.
