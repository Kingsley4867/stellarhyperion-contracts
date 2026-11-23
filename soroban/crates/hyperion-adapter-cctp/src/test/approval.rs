//! Hostile approval accounting must unwind the token burn and any wallet debit on both paths.
use hyperion_core::{cctp::ApprovalFinding, HyperionError};
use soroban_sdk::{contract, contractimpl, contracttype, testutils::Events, Address, BytesN, Env};

use crate::{storage, types::TokenMapping};

use super::setup::{World, ETHEREUM_DOMAIN, EVM_DECIMALS, HUNDRED};

#[contracttype]
#[derive(Clone)]
enum TokenKey {
    Balance(Address),
    Allowance(Address, Address),
    Mode,
    Burned,
}

#[contract]
struct ApprovalToken;

#[contractimpl]
impl ApprovalToken {
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn set_mode(env: Env, mode: u32) {
        env.storage().instance().set(&TokenKey::Mode, &mode);
    }

    pub fn mint(env: Env, owner: Address, amount: i128) {
        env.storage()
            .instance()
            .set(&TokenKey::Balance(owner), &amount);
    }

    pub fn balance(env: Env, owner: Address) -> i128 {
        env.storage()
            .instance()
            .get(&TokenKey::Balance(owner))
            .unwrap_or(0)
    }

    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        let mode: u32 = env.storage().instance().get(&TokenKey::Mode).unwrap_or(0);
        if mode == 4 {
            panic!("allowance unavailable");
        }
        if mode == 5 {
            return -1;
        }
        env.storage()
            .instance()
            .get(&TokenKey::Allowance(owner, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, owner: Address, spender: Address, amount: i128, _expiration: u32) {
        owner.require_auth();
        let mode: u32 = env.storage().instance().get(&TokenKey::Mode).unwrap_or(0);
        if amount == 0 && mode == 2 {
            panic!("approval clear failed");
        }
        let inconsistent = (amount == 0 && mode == 1) || (amount > 0 && mode == 3);
        env.storage().instance().set(
            &TokenKey::Allowance(owner, spender),
            &(amount + i128::from(inconsistent)),
        );
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let balance = Self::balance(env.clone(), from.clone());
        assert!(amount > 0 && balance >= amount);
        let destination = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&TokenKey::Balance(from), &(balance - amount));
        env.storage()
            .instance()
            .set(&TokenKey::Balance(to), &(destination + amount));
    }

    pub fn burn_from(env: Env, spender: Address, owner: Address, amount: i128) {
        spender.require_auth();
        let balance = Self::balance(env.clone(), owner.clone());
        let allowance = Self::allowance(env.clone(), owner.clone(), spender.clone());
        assert!(amount > 0 && balance >= amount && allowance >= amount);
        env.storage()
            .instance()
            .set(&TokenKey::Balance(owner.clone()), &(balance - amount));
        env.storage()
            .instance()
            .set(&TokenKey::Allowance(owner, spender), &(allowance - amount));
        let burned = Self::burned(env.clone());
        env.storage()
            .instance()
            .set(&TokenKey::Burned, &(burned + amount));
    }

    pub fn burned(env: Env) -> i128 {
        env.storage().instance().get(&TokenKey::Burned).unwrap_or(0)
    }
}

#[test]
fn inconsistent_approval_or_failed_cleanup_rolls_back_both_dispatch_paths() {
    for paid in [false, true] {
        for mode in [1, 2, 3] {
            let w = World::new();
            let token_id = w.env.register(ApprovalToken, ());
            let token = ApprovalTokenClient::new(&w.env, &token_id);
            let owner = if paid { &w.user } else { &w.adapter_id };
            token.mint(owner, &HUNDRED);
            token.set_mode(&mode);
            let mut destination_bytes = [0u8; 32];
            destination_bytes[12..].fill(1);
            let destination = BytesN::from_array(&w.env, &destination_bytes);
            w.env.as_contract(&w.adapter_id, || {
                storage::set_asset(
                    &w.env,
                    ETHEREUM_DOMAIN,
                    &TokenMapping {
                        local: token_id.clone(),
                        remote: BytesN::from_array(&w.env, &[0x99; 32]),
                        revision: 1,
                        local_decimals: 7,
                        remote_decimals: EVM_DECIMALS,
                    },
                );
            });
            let events_before = w.env.events().all();
            let result = if paid {
                w.adapter().try_dispatch_from_revision(
                    &w.router_id,
                    &w.user,
                    &token_id,
                    &HUNDRED,
                    &w.ethereum(),
                    &destination,
                    &1,
                    &1,
                    &EVM_DECIMALS,
                    &1_000_000,
                )
            } else {
                w.adapter().try_dispatch_revision(
                    &w.router_id,
                    &token_id,
                    &HUNDRED,
                    &w.ethereum(),
                    &destination,
                    &1,
                    &EVM_DECIMALS,
                    &1,
                )
            };
            assert!(result.is_err());
            if mode != 2 {
                assert_eq!(result, Err(Ok(HyperionError::InvalidAmount)));
            }
            assert_eq!(token.balance(owner), HUNDRED);
            if paid {
                assert_eq!(token.balance(&w.adapter_id), 0);
            }
            assert_eq!(token.allowance(&w.adapter_id, &w.messenger_id), 0);
            assert_eq!(token.burned(), 0);
            assert_eq!(
                w.env.events().all(),
                events_before,
                "paid={paid}, mode={mode}"
            );
            assert_eq!(w.messenger().burn_count(), 0);
            assert!(w.messenger().try_last_burn().is_err());
            assert!(w.messenger().last_hook().is_empty());
            token.set_mode(&0);
            if paid {
                w.adapter().dispatch_from_revision(
                    &w.router_id,
                    &w.user,
                    &token_id,
                    &HUNDRED,
                    &w.ethereum(),
                    &destination,
                    &1,
                    &1,
                    &EVM_DECIMALS,
                    &1_000_000,
                );
            } else {
                w.adapter().dispatch_revision(
                    &w.router_id,
                    &token_id,
                    &HUNDRED,
                    &w.ethereum(),
                    &destination,
                    &1,
                    &EVM_DECIMALS,
                    &1,
                );
            }
            assert_eq!(token.balance(owner), 0);
            assert_eq!(token.burned(), HUNDRED);
            assert_eq!(token.allowance(&w.adapter_id, &w.messenger_id), 0);
            assert_eq!(w.messenger().burn_count(), 1);
        }
    }
}

#[test]
fn reverting_or_negative_allowance_reads_are_unavailable_without_reconciliation() {
    let w = World::new();
    let token_id = w.env.register(ApprovalToken, ());
    let token = ApprovalTokenClient::new(&w.env, &token_id);
    token.mint(&w.adapter_id, &HUNDRED);
    token.approve(&w.adapter_id, &w.messenger_id, &500, &200_000);
    for mode in [4, 5] {
        token.set_mode(&mode);
        let diagnostics = w.adapter().audit_allowance(&token_id);
        assert!(!diagnostics.is_clean);
        assert_eq!(diagnostics.allowance, 0);
        assert_eq!(diagnostics.finding, ApprovalFinding::Unavailable);
        assert_eq!(token.balance(&w.adapter_id), HUNDRED);
    }
    token.set_mode(&0);
    assert_eq!(token.allowance(&w.adapter_id, &w.messenger_id), 500);
}
