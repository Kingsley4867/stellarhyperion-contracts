//! Reproducible resource baselines for the four user-visible router paths.
//!
//! These are intentionally tests rather than a second benchmarking framework. Soroban's test
//! host already exposes the same CPU and memory counters used by the contract test suite, and
//! keeping the fixtures here means a baseline can be rerun against a pinned lockfile without
//! introducing a new dependency or hiding setup assumptions in a benchmark harness.

extern crate std;
use super::{
    doubles::{evm_destination, message_id, Delivery},
    setup::{World, EVM_DECIMALS, HUNDRED},
};
use crate::types::{Destination, Origin, OutboundRequest, Recipient};
use hyperion_core::{AddressKind, RouteKind};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    xdr::ToXdr,
    Address, Bytes, BytesN,
};

const SMALL_RECORDS: u32 = 1;
const LARGE_RECORDS: u32 = 32;

#[derive(Clone, Copy)]
struct Budget {
    cpu: u64,
    memory: u64,
}

fn budget(w: &World) -> Budget {
    Budget {
        cpu: w.env.cost_estimate().budget().cpu_instruction_cost(),
        memory: w.env.cost_estimate().budget().memory_bytes_cost(),
    }
}

fn report(name: &str, input_bytes: u32, records: u32, before: Budget, after: Budget) -> Budget {
    let cpu = after.cpu.saturating_sub(before.cpu);
    let memory = after.memory.saturating_sub(before.memory);
    std::println!(
        "HYPERION_BUDGET case={name} input_bytes={input_bytes} records={records} cpu={cpu} memory={memory}"
    );
    Budget { cpu, memory }
}

fn request(w: &World) -> OutboundRequest {
    OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: w.ethereum(),
            address: evm_destination(&w.env, 0x11),
            mapping_revision: 0,
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    }
}

fn deliver(w: &World, nonce: u64) {
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: nonce,
    });
}

fn parked_claims(w: &World, count: u32) -> (Address, Address) {
    let token = w.with_failable_token();
    w.failable(&token)
        .mint(&w.rail_id, &(HUNDRED * count as i128));
    w.failable(&token).set_blocked(&w.recipient, &true);
    for nonce in 0..count {
        w.rail().deliver(&Delivery {
            route: RouteKind::Cctp,
            token: token.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: nonce as u64,
        });
    }
    (token, Address::generate(&w.env))
}

#[test]
fn print_reproducible_quote_dispatch_inbound_and_settlement_budgets() {
    let w = World::new();
    std::println!("HYPERION_BUDGET_RUNNER host=soroban-env-host-29.0.1 protocol={} encoding=ScVal-argument-vector-XDR setup_excluded=true", w.env.ledger().get().protocol_version);
    let input = (w.token_id.clone(), HUNDRED, EVM_DECIMALS)
        .to_xdr(&w.env)
        .len();
    let before = budget(&w);
    w.router()
        .quote_routes(&w.token_id, &HUNDRED, &EVM_DECIMALS);
    report("quote", input, 0, before, budget(&w));

    let w = World::new();
    let request = request(&w);
    let input = (w.user.clone(), request.clone()).to_xdr(&w.env).len();
    let before = budget(&w);
    w.router().bridge_out(&w.user, &request);
    report("dispatch", input, 1, before, budget(&w));

    let w = World::new();
    w.fund_rail(HUNDRED);
    let input = (
        w.rail_id.clone(),
        RouteKind::Cctp,
        w.token_id.clone(),
        HUNDRED,
        Recipient {
            address: w.recipient.clone(),
            kind: AddressKind::Account,
            raw: Bytes::new(&w.env),
        },
        Origin {
            chain: w.ethereum(),
            nonce: 1,
            message_id: message_id(&w.env, 1),
            sender: BytesN::from_array(&w.env, &[7; 32]),
        },
    )
        .to_xdr(&w.env)
        .len();
    let before = budget(&w);
    deliver(&w, 1);
    report("inbound", input, 1, before, budget(&w));

    let w = World::new();
    let (token, settler) = parked_claims(&w, SMALL_RECORDS);
    w.failable(&token).set_blocked(&w.recipient, &false);
    let input = (settler.clone(), 1u64).to_xdr(&w.env).len();
    let before = budget(&w);
    w.router().settle_claim(&settler, &1);
    let small = report("settlement", input, SMALL_RECORDS, before, budget(&w));

    let w = World::new();
    let (token, settler) = parked_claims(&w, LARGE_RECORDS);
    w.failable(&token).set_blocked(&w.recipient, &false);
    let input = (settler.clone(), 1u64).to_xdr(&w.env).len();
    let before = budget(&w);
    w.router().settle_claim(&settler, &1);
    let large = report("settlement", input, LARGE_RECORDS, before, budget(&w));
    std::println!("HYPERION_BUDGET_COMPARISON case=settlement baseline_records=1 compared_records=32 cpu_delta={} memory_delta={}", i128::from(large.cpu) - i128::from(small.cpu), i128::from(large.memory) - i128::from(small.memory));
    assert!(small.cpu > 0 && small.memory > 0);
    // Numbered storage must not scan all unrelated claims to settle one indexed claim.
    assert!(
        large.cpu <= small.cpu * 2,
        "single-claim CPU scaled with unrelated registry size"
    );
    assert!(
        large.memory <= small.memory * 2,
        "single-claim memory scaled with unrelated registry size"
    );
}
