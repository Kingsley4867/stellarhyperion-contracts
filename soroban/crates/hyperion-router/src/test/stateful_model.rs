//! Generated operation sequences against the independent core specification and the actual host.
extern crate std;
use super::{
    doubles::{evm_destination, Delivery},
    setup::World,
};
use crate::types::{AdminAction, Destination, OutboundRequest};
use hyperion_core::{
    model::{MODEL_FUNDS, MODEL_LIMIT},
    timelock_boundary_cases_for, AddressKind, ChainClock, HyperionError, ModelError, ModelRouter,
    Operation, Rail, RouteKind,
};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, InvokeError,
};
use std::vec::Vec;

struct Driver {
    w: World,
    token: Address,
    recipients: [Address; 2],
    nominees: [Address; 5],
    model: ModelRouter,
    queue_base: u64,
}
fn route(rail: Rail) -> RouteKind {
    [
        RouteKind::Cctp,
        RouteKind::AxelarIts,
        RouteKind::AxelarGmp,
        RouteKind::Allbridge,
    ][rail as usize]
}
impl Driver {
    fn new() -> Self {
        let w = World::bare();
        w.enable_every_route();
        let token = w.with_failable_token();
        // A separate token keeps fixture funding and liabilities outside the reference universe.
        w.router()
            .lower_token_flow_limit(&w.admin, &token, &(MODEL_LIMIT as i128));
        w.failable(&token).mint(&w.user, &(MODEL_FUNDS as i128));
        w.failable(&token).mint(&w.rail_id, &(MODEL_FUNDS as i128));
        w.env.ledger().with_mut(|l| l.timestamp = 1701000000);
        let recipients = [w.recipient.clone(), Address::generate(&w.env)];
        let queue_base = w.router().queue_count();
        let nominees = core::array::from_fn(|_| Address::generate(&w.env));
        Self {
            w,
            token,
            recipients,
            nominees,
            model: ModelRouter::new(ChainClock::Soroban {
                ledger: 100000,
                timestamp: 1701000000,
            }),
            queue_base,
        }
    }
    fn actor(&self, actor: u8) -> Address {
        match actor {
            0 => self.w.admin.clone(),
            1 => self.w.guardian.clone(),
            2 => self.w.user.clone(),
            _ => self.nominees[usize::from(actor - 3)].clone(),
        }
    }
    fn real(&self, op: Operation) -> Result<u64, ()> {
        let r = self.w.router();
        match op {
            Operation::Dispatch { rail, amount } => r
                .try_bridge_out(
                    &self.w.user,
                    &OutboundRequest {
                        token: self.token.clone(),
                        amount: amount as i128,
                        route: route(rail),
                        destination: Destination {
                            chain: self.w.ethereum(),
                            address: evm_destination(&self.w.env, 1),
                            mapping_revision: 0,
                        },
                        destination_decimals: 6,
                        min_destination_amount: 0,
                    },
                )
                .map_err(|_| ())?
                .map_err(|_| ()),
            Operation::Inbound {
                amount,
                recipient,
                nonce,
            } => self
                .w
                .rail()
                .try_deliver(&Delivery {
                    route: RouteKind::Cctp,
                    token: self.token.clone(),
                    amount: amount as i128,
                    recipient: self.recipients[recipient].clone(),
                    recipient_kind: AddressKind::Account,
                    source_chain: self.w.ethereum(),
                    source_nonce: nonce as u64,
                })
                .map_err(|_| ())?
                .map_err(|_| ()),
            Operation::Block { recipient, blocked } => {
                self.w
                    .failable(&self.token)
                    .set_blocked(&self.recipients[recipient], &blocked);
                Ok(0)
            }
            Operation::Settle { id } => r
                .try_settle_claim(&self.w.user, &(id as u64))
                .map_err(|_| ())?
                .map(|_| 0)
                .map_err(|_| ()),
            Operation::Pause { actor } => r
                .try_pause(&self.actor(actor))
                .map_err(|_| ())?
                .map(|_| 0)
                .map_err(|_| ()),
            Operation::Unpause { actor } => r
                .try_unpause(&self.actor(actor))
                .map_err(|_| ())?
                .map(|_| 0)
                .map_err(|_| ()),
            Operation::QueueFee { actor, bps } => r
                .try_queue_action(&self.actor(actor), &AdminAction::SetFeeBps(bps as u32))
                .map_err(|_| ())?
                .map(|id| id - self.queue_base)
                .map_err(|_| ()),
            Operation::QueueAuthority {
                actor,
                target,
                guardian,
            } => r
                .try_queue_action(
                    &self.actor(actor),
                    &if guardian {
                        AdminAction::SetGuardian(self.actor(target))
                    } else {
                        AdminAction::SetAdmin(self.actor(target))
                    },
                )
                .map_err(|_| ())?
                .map(|id| id - self.queue_base)
                .map_err(|_| ()),
            Operation::Renounce { .. } => Err(()),
            Operation::Execute { actor, id } => r
                .try_execute_action(&self.actor(actor), &(self.queue_base + id as u64))
                .map_err(|_| ())?
                .map(|_| 0)
                .map_err(|_| ()),
            Operation::Cancel { actor, id } => r
                .try_cancel_action(&self.actor(actor), &(self.queue_base + id as u64))
                .map_err(|_| ())?
                .map(|_| 0)
                .map_err(|_| ()),
            Operation::Advance { seconds, ledgers } => {
                self.w.advance_time(seconds);
                self.w.advance_ledgers(ledgers as u32);
                Ok(0)
            }
        }
    }
    fn step(&mut self, word: u64) -> Result<u64, ()> {
        self.step_operation(Operation::decode(word))
    }
    fn step_operation(&mut self, op: Operation) -> Result<u64, ()> {
        let payload = match op {
            Operation::Execute { id, .. } | Operation::Cancel { id, .. } => {
                self.model.action_details(id)
            }
            _ => None,
        };
        let expected = self.model.apply(op).map_err(|_| ());
        assert_eq!(
            self.real(op),
            expected,
            "chain_time={} ledger={} operation={op:?} full_action_payload={payload:?}",
            self.w.env.ledger().timestamp(),
            self.w.env.ledger().sequence(),
        );
        let token = self.w.failable(&self.token);
        let addresses = [
            &self.w.user,
            &self.w.treasury,
            &self.w.rail_id,
            &self.w.router_id,
            &self.recipients[0],
            &self.recipients[1],
        ];
        for (index, address) in addresses.iter().enumerate() {
            assert_eq!(
                token.balance(address),
                self.model.balances[index] as i128,
                "balance {index} after {op:?}"
            );
        }
        assert!(self.model.conserved());
        let cfg = self.w.router().get_config();
        assert_eq!(cfg.paused, self.model.paused);
        assert_eq!(cfg.fee_bps as u64, self.model.fee_bps);
        assert_eq!(
            cfg.admin,
            self.actor(self.model.admin_actors.trailing_zeros() as u8)
        );
        assert_eq!(
            cfg.guardian,
            self.actor(self.model.guardian_actors.trailing_zeros() as u8)
        );
        assert_eq!(self.w.router().claim_count(), self.model.claim_count as u64);
        assert_eq!(
            self.w.router().queue_count() - self.queue_base,
            self.model.action_count as u64
        );
        for rail in [
            Rail::Cctp,
            Rail::AxelarIts,
            Rail::AxelarGmp,
            Rail::Allbridge,
        ] {
            assert_eq!(
                self.w.router().flow_available(&self.token, &route(rail)),
                self.model.available(rail) as i128
            );
        }
        let mut liabilities = [0u64; 2];
        for (index, expected) in self.model.claims[..self.model.claim_count]
            .iter()
            .enumerate()
        {
            let actual = self.w.router().get_claim(&(index as u64 + 1));
            assert_eq!(actual.recipient, self.recipients[expected.recipient]);
            assert_eq!(actual.amount, expected.amount as i128);
            assert_eq!(actual.settled, expected.settled);
            if !actual.settled {
                liabilities[expected.recipient] += actual.amount as u64;
            }
        }
        assert_eq!(liabilities, self.model.liabilities());
        expected
    }
}

#[test]
fn common_generated_corpus_matches_real_soroban() {
    let mut driver = Driver::new();
    for line in include_str!("../../../../../testdata/router-model-soroban.csv")
        .lines()
        .filter(|l| !l.starts_with('#'))
    {
        let row: Vec<u64> = line.split(',').map(|v| v.parse().unwrap()).collect();
        let result = driver.step(row[0]);
        assert_eq!(result.is_ok(), row[1] != 0);
        assert_eq!(result.unwrap_or(0), row[2]);
        assert_eq!(&driver.model.balances, &row[3..9]);
    }
}

fn admin_error(error: Result<HyperionError, InvokeError>) -> ModelError {
    match error {
        Ok(HyperionError::Unauthorized) => ModelError::Unauthorized,
        Ok(HyperionError::TimelockNotReady) => ModelError::Early,
        Ok(HyperionError::TimelockExpired) => ModelError::Expired,
        Ok(HyperionError::TimelockNotQueued) => ModelError::Missing,
        other => panic!("unexpected administration failure: {other:?}"),
    }
}

impl Driver {
    fn administration(&self, op: Operation) -> Result<u64, ModelError> {
        let router = self.w.router();
        match op {
            Operation::QueueFee { actor, bps } => router
                .try_queue_action(&self.actor(actor), &AdminAction::SetFeeBps(bps as u32))
                .map_err(admin_error)?
                .map(|id| id - self.queue_base)
                .map_err(|error| panic!("invalid queue return: {error:?}")),
            Operation::QueueAuthority {
                actor,
                target,
                guardian,
            } => router
                .try_queue_action(
                    &self.actor(actor),
                    &if guardian {
                        AdminAction::SetGuardian(self.actor(target))
                    } else {
                        AdminAction::SetAdmin(self.actor(target))
                    },
                )
                .map_err(admin_error)?
                .map(|id| id - self.queue_base)
                .map_err(|error| panic!("invalid queue return: {error:?}")),
            Operation::Execute { actor, id } => router
                .try_execute_action(&self.actor(actor), &(self.queue_base + id as u64))
                .map_err(admin_error)?
                .map(|_| 0)
                .map_err(|error| panic!("invalid execute return: {error:?}")),
            Operation::Cancel { actor, id } => router
                .try_cancel_action(&self.actor(actor), &(self.queue_base + id as u64))
                .map_err(admin_error)?
                .map(|_| 0)
                .map_err(|error| panic!("invalid cancel return: {error:?}")),
            Operation::Pause { actor } => router
                .try_pause(&self.actor(actor))
                .map_err(admin_error)?
                .map(|_| 0)
                .map_err(|error| panic!("invalid pause return: {error:?}")),
            Operation::Unpause { actor } => router
                .try_unpause(&self.actor(actor))
                .map_err(admin_error)?
                .map(|_| 0)
                .map_err(|error| panic!("invalid unpause return: {error:?}")),
            Operation::Advance { .. } => Ok(0),
            _ => panic!("unexpected administration operation"),
        }
    }
}

#[test]
fn generated_timelock_boundary_sequence_preserves_authority() {
    for seed in 0..12 {
        let mut driver = Driver::new();
        for case in timelock_boundary_cases_for(seed, driver.model.clock) {
            let before = driver.model.clone();
            let payload = match case.operation {
                Operation::Execute { id, .. } | Operation::Cancel { id, .. } => {
                    before.action_details(id)
                }
                _ => None,
            };
            let expected = driver.model.apply(case.operation);
            let actual = driver.administration(case.operation);
            assert_eq!(actual, expected, "seed={seed} phase={} chain_time={} ledger={} full_operation={:?} queued_payload={payload:?}",
                case.name, driver.w.env.ledger().timestamp(), driver.w.env.ledger().sequence(), case.operation);
            // The typed invocation above performed the real transition; do not invoke a second time.
            if let Operation::Advance { seconds, ledgers } = case.operation {
                driver.w.advance_time(seconds);
                driver.w.advance_ledgers(ledgers as u32);
            }
            if expected.is_err() {
                assert_eq!(driver.model, before);
            }
            let config = driver.w.router().get_config();
            assert_eq!(
                config.admin,
                driver.actor(driver.model.admin_actors.trailing_zeros() as u8)
            );
            assert_eq!(
                config.guardian,
                driver.actor(driver.model.guardian_actors.trailing_zeros() as u8)
            );
            assert_eq!(config.fee_bps as u64, driver.model.fee_bps);
            assert_eq!(config.paused, driver.model.paused);
            assert_eq!(
                driver.w.router().queue_count() - driver.queue_base,
                driver.model.action_count as u64
            );
            assert!(driver.model.conserved());
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, max_shrink_iters: 4096, .. ProptestConfig::default() })]
    #[test]
    fn generated_sequences_preserve_every_balance_and_recipient(words in proptest::collection::vec(any::<u64>(), 1..65)) {
        // Proptest shrinks both sequence length and words and prints/persists the reproducible seed.
        let mut driver = Driver::new();
        for word in words { let _ = driver.step(word); }
    }
}
