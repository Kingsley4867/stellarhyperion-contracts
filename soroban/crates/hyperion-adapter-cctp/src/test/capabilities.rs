//! Capability regression snapshot for the CCTP adapter surface.
//!
//! The snapshot is separate from the router's: an adapter upgrade changes its own exported
//! surface without touching the router, and the two must be reviewed independently.

use super::{capability, setup::World};
use hyperion_core::RouteKind;

const SNAPSHOT: &str =
    include_str!("../../../../../testdata/capabilities/soroban-cctp-adapter.cap");
const HISTORY: &str = include_str!("../../../../../testdata/capabilities/paid-method-history.txt");

#[test]
fn exported_methods_match_the_capability_snapshot() {
    capability::assert_well_formed(SNAPSHOT, "soroban/cctp-adapter", "CctpAdapter", HISTORY);
    let actual = capability::contract_methods(include_str!("../lib.rs"), "CctpAdapter");
    capability::assert_methods(SNAPSHOT, &actual);
}

#[test]
fn advertises_only_the_route_it_serves() {
    capability::assert_routes(SNAPSHOT, &["cctp"]);

    let world = World::new();
    assert_eq!(
        world.adapter().key_coverage().route,
        RouteKind::Cctp,
        "the adapter's advertised route disagrees with the snapshot"
    );
}

#[test]
fn the_paid_entry_point_is_declared_and_callable() {
    let methods = capability::values(SNAPSHOT, "method");
    let paid = capability::values(SNAPSHOT, "paid-method");
    assert_eq!(paid, ["dispatch_from_revision"]);
    assert!(methods.contains(&"dispatch_from_revision"));
}
