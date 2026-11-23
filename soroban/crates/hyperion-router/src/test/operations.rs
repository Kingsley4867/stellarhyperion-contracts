//! Real native activation and provider-boundary fault rehearsals. No public-network signing.
extern crate std;
use super::{
    doubles::{evm_destination, message_id, Delivery},
    setup::{World, EVM_DECIMALS, FLOW_LIMIT, HUNDRED},
    ProviderFaultFixture,
};
use crate::{AdminAction, Destination, OutboundRequest};
use hyperion_adapter_axelar::{AxelarAdapter, AxelarAdapterClient};
use hyperion_adapter_cctp::{CctpAdapter, CctpAdapterClient};
use hyperion_core::{
    axelar::{DestinationCapability, TokenManagerType},
    AddressKind, HyperionError, RouteKind,
};
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, Address, BytesN, Env, String, Symbol,
};

#[contract]
struct ActivationIts;
#[contractimpl]
impl ActivationIts {
    pub fn init(env: Env, token: Address, manager: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "token"), &token);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "manager"), &manager);
    }
    pub fn is_trusted_chain(env: Env, chain: String) -> bool {
        chain == String::from_str(&env, "ethereum-sepolia")
    }
    pub fn registered_token_address(env: Env, _token_id: BytesN<32>) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "token"))
            .unwrap()
    }
    pub fn deployed_token_manager(env: Env, _token_id: BytesN<32>) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "manager"))
            .unwrap()
    }
    pub fn token_manager_type(_env: Env, _token_id: BytesN<32>) -> TokenManagerType {
        TokenManagerType::LockUnlock
    }
}

#[test]
fn activation_rehearsal_executes_real_queued_actions_links_and_verifies_repeatability() {
    let w = World::bare();
    let cctp_id = w.env.register(CctpAdapter, ());
    let axelar_id = w.env.register(AxelarAdapter, ());
    let its_id = w.env.register(ActivationIts, ());
    let manager = Address::generate(&w.env);
    ActivationItsClient::new(&w.env, &its_id).init(&w.token_id, &manager);
    let cctp = CctpAdapterClient::new(&w.env, &cctp_id);
    let axelar = AxelarAdapterClient::new(&w.env, &axelar_id);
    cctp.initialize(
        &w.admin,
        &w.router_id,
        &Address::generate(&w.env),
        &Address::generate(&w.env),
    );
    axelar.initialize(&w.admin, &w.router_id, &its_id, &RouteKind::AxelarIts);
    let actions = [
        AdminAction::RegisterToken(w.token_id.clone(), 7, FLOW_LIMIT),
        AdminAction::SetAdapter(RouteKind::Cctp, cctp_id.clone()),
        AdminAction::SetRailReceiver(RouteKind::Cctp, cctp_id.clone()),
        AdminAction::EnableRoute(RouteKind::Cctp),
        AdminAction::SetAdapter(RouteKind::AxelarIts, axelar_id.clone()),
        AdminAction::SetRailReceiver(RouteKind::AxelarIts, axelar_id.clone()),
        AdminAction::EnableRoute(RouteKind::AxelarIts),
    ];
    let ids: std::vec::Vec<_> = actions
        .iter()
        .map(|action| w.router().queue_action(&w.admin, action))
        .collect();
    assert_eq!(
        w.router().try_execute_action(&w.admin, &ids[0]),
        Err(Ok(HyperionError::TimelockNotReady))
    );
    assert!(!w.router().is_route_enabled(&RouteKind::Cctp));
    assert!(!w.router().is_route_enabled(&RouteKind::AxelarIts));
    let caller = BytesN::from_array(&w.env, &[0x11; 32]);
    let peer = BytesN::from_array(&w.env, &[0x22; 20]);
    let token_id = BytesN::from_array(&w.env, &[0x33; 32]);
    let axelar_chain = String::from_str(&w.env, "ethereum-sepolia");
    cctp.link_domain(&w.ethereum(), &0, &caller);
    cctp.map_asset(&0, &token_id, &w.token_id, &7, &6, &1);
    axelar.link_chain(&w.ethereum(), &axelar_chain, &peer);
    axelar.map_token(&w.token_id, &token_id);
    axelar.set_destination_capability(
        &w.ethereum(),
        &w.token_id,
        &DestinationCapability::DirectItsTransfer,
    );
    w.advance_time(crate::MIN_TIMELOCK_DELAY + 1);
    for id in &ids {
        w.router().execute_action(&w.admin, id);
    }
    assert_eq!(w.router().get_token(&w.token_id).decimals, 7);
    assert_eq!(w.router().get_token(&w.token_id).flow_limit, FLOW_LIMIT);
    for (route, adapter) in [
        (RouteKind::Cctp, &cctp_id),
        (RouteKind::AxelarIts, &axelar_id),
    ] {
        assert!(w.router().is_route_enabled(&route));
        assert_eq!(w.router().get_adapter(&route), *adapter);
        assert_eq!(w.router().get_rail_receiver(&route), *adapter);
    }
    assert_eq!(cctp.get_config().router, w.router_id);
    assert_eq!(cctp.get_link(&0).destination_caller, caller);
    assert_eq!(cctp.asset_for(&0, &token_id), w.token_id);
    assert_eq!(axelar.get_config().router, w.router_id);
    assert_eq!(axelar.get_link(&w.ethereum()).peer, peer);
    assert_eq!(axelar.token_id_for(&w.token_id), token_id);
    for id in &ids {
        assert_eq!(
            w.router().try_execute_action(&w.admin, id),
            Err(Ok(HyperionError::TimelockNotQueued))
        );
    }
    cctp.link_domain(&w.ethereum(), &0, &caller);
    axelar.link_chain(&w.ethereum(), &axelar_chain, &peer);
    axelar.map_token(&w.token_id, &token_id);
    assert_eq!(
        axelar.try_link_chain(
            &w.ethereum(),
            &axelar_chain,
            &BytesN::from_array(&w.env, &[0x44; 20])
        ),
        Err(Ok(HyperionError::AlreadyConfigured))
    );
    std::println!("ACTIVATION_REPORT {{\"fixture\":\"native-real-router-and-adapters\",\"earlyTimelockRejected\":true,\"maturedExecuted\":7,\"linksVerified\":true,\"repeatedPhaseTwoNoOp\":true}}");
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
fn economic_snapshot(w: &World) -> (i128, i128, i128, i128, u64, u32, i128) {
    (
        w.token().balance(&w.user),
        w.token().balance(&w.treasury),
        w.token().balance(&w.router_id),
        w.token().balance(&w.rail_id),
        w.router().last_out_nonce(),
        w.rail().dispatch_count(),
        w.router().flow_available(&w.token_id, &RouteKind::Cctp),
    )
}
#[test]
fn deterministic_provider_faults_roll_back_dispatch_and_inbound_then_retry_once() {
    let mut plan = ProviderFaultFixture::from_seed(156);
    let mut failures = [0, 0];
    for attempt in 0..16u64 {
        let w = World::new();
        let fault = plan.before_dispatch();
        w.rail().set_faults(&fault, &false);
        let before = economic_snapshot(&w);
        let result = w.router().try_bridge_out(&w.user, &request(&w));
        if fault {
            failures[0] += 1;
            assert!(result.is_err());
            assert_eq!(economic_snapshot(&w), before);
            w.rail().set_faults(&false, &false);
            w.router().bridge_out(&w.user, &request(&w));
        } else {
            assert!(result.is_ok());
        }
        assert_eq!(w.router().last_out_nonce(), 1);
        assert_eq!(w.rail().dispatch_count(), 1);
        let w = World::new();
        w.fund_rail(HUNDRED);
        let fault = plan.before_inbound();
        w.rail().set_faults(&false, &fault);
        let delivery = Delivery {
            route: RouteKind::Cctp,
            token: w.token_id.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: attempt + 1,
        };
        let before_rail = w.token().balance(&w.rail_id);
        let before_recipient = w.token().balance(&w.recipient);
        let result = w.rail().try_deliver(&delivery);
        if fault {
            failures[1] += 1;
            assert!(result.is_err());
            assert_eq!(w.token().balance(&w.rail_id), before_rail);
            assert_eq!(w.token().balance(&w.recipient), before_recipient);
            assert_eq!(w.router().claim_count(), 0);
            assert!(!w
                .router()
                .was_processed(&RouteKind::Cctp, &message_id(&w.env, attempt + 1)));
            w.rail().set_faults(&false, &false);
            w.rail().deliver(&delivery);
        } else {
            assert!(result.is_ok());
        }
        assert_eq!(w.token().balance(&w.recipient), before_recipient + HUNDRED);
        assert!(w
            .router()
            .was_processed(&RouteKind::Cctp, &message_id(&w.env, attempt + 1)));
        assert!(w.rail().try_deliver(&delivery).is_err());
        assert_eq!(w.token().balance(&w.recipient), before_recipient + HUNDRED);
    }
    assert!(failures[0] > 0 && failures[1] > 0);
    plan.reset();
    assert!(!plan.before_dispatch());
    assert!(plan.before_inbound());
    std::println!("PROVIDER_FAULT_REPORT seed=156 dispatch_mask=0xd1b1c0866b4b6016 inbound_mask=0x41613ddf7b22f3a1 rollback_then_single_delivery=true");
}
