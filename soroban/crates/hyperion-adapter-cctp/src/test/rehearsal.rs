//! A local rehearsal that crosses the actual router and adapter entrypoints in both directions.

use hyperion_core::{
    cctp::{BurnMessage, CctpMessage, CctpOutboundNote},
    HyperionError, RouteKind,
};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{testutils::Address as _, Address, BytesN};

use super::setup::{net_of, World, ETHEREUM_DOMAIN, EVM_DECIMALS, HUNDRED};

const ARRIVING: i128 = 500_000_000;

fn evm_recipient(world: &World) -> BytesN<32> {
    let mut raw = [0u8; 32];
    raw[12..].copy_from_slice(&[0x5Au8; 20]);
    BytesN::from_array(&world.env, &raw)
}

#[test]
fn cctp_rehearsal_checks_burn_mint_movement_and_recipient_bound_claim_recovery() {
    let world = World::new();
    let user_before = world.token().balance(&world.user);
    let outbound = OutboundRequest {
        token: world.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: world.ethereum(),
            address: evm_recipient(&world),
            mapping_revision: 1,
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };

    world.router().bridge_out(&world.user, &outbound);

    let burn = world.messenger().last_burn();
    assert_eq!(burn.caller, world.adapter_id);
    assert_eq!(burn.destination_domain, ETHEREUM_DOMAIN);
    assert_eq!(burn.amount, net_of(HUNDRED));
    assert_eq!(burn.burned, net_of(HUNDRED));
    assert_eq!(burn.mint_recipient, evm_recipient(&world));
    assert_eq!(burn.burn_token, world.token_id);
    assert!(burn.had_hook);
    let outbound_note =
        CctpOutboundNote::decode(&world.env, &world.messenger().last_hook()).unwrap();
    assert_eq!(outbound_note.mapping_revision, 1);
    assert_eq!(outbound_note.recipient, evm_recipient(&world));
    assert_eq!(outbound_note.router_nonce, 1);
    assert_eq!(world.token().balance(&world.user), user_before - HUNDRED);
    assert_eq!(world.token().balance(&world.adapter_id), 0);
    assert_eq!(world.token().balance(&world.router_id), 0);
    assert_eq!(
        world.token().balance(&world.treasury),
        HUNDRED - net_of(HUNDRED)
    );

    let message = world.inbound_to_classic(ARRIVING, 81);
    let header = CctpMessage::parse(&world.env, &message).unwrap();
    let body = CctpMessage::body(&message).unwrap();
    let burn_message = BurnMessage::parse(&world.env, &body).unwrap();
    assert_eq!(header.source_domain, ETHEREUM_DOMAIN);
    assert_eq!(
        header.destination_domain,
        hyperion_core::cctp::STELLAR_DOMAIN
    );
    assert_eq!(header.sender, BytesN::from_array(&world.env, &[0xE1u8; 32]));
    assert_eq!(burn_message.amount, ARRIVING);
    assert_eq!(
        burn_message.mint_recipient,
        BytesN::from_array(&world.env, &world.adapter_key())
    );

    let claim_id = world
        .adapter()
        .receive(&world.relayer, &message, &world.attestation());
    assert_eq!(claim_id, 1);
    assert_eq!(world.token().balance(&world.adapter_id), 0);
    assert_eq!(world.token().balance(&world.router_id), ARRIVING);

    let claim = world.router().get_claim(&claim_id);
    assert_eq!(claim.recipient, world.classic);
    assert_eq!(claim.amount, ARRIVING);
    assert_eq!(claim.source_chain, world.ethereum());
    assert_eq!(claim.source_nonce, 81);
    assert!(!claim.settled);

    let settler = Address::generate(&world.env);
    assert_eq!(
        world.router().try_settle_claim(&settler, &claim_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert!(!world.router().get_claim(&claim_id).settled);
    assert_eq!(world.token().balance(&world.router_id), ARRIVING);
}
