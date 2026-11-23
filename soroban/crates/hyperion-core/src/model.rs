//! Bounded specification used only by off-chain tests. No production arithmetic or storage helpers.
//! Amounts are token base units. A rail balance includes outbound adapters and the inbound receiver.

pub const MODEL_MAX_CLAIMS: usize = 128;
pub const MODEL_MAX_STEPS: usize = 128;
pub const MODEL_FUNDS: u64 = 10_000_000_000_000;
pub const MODEL_LIMIT: u64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rail {
    Cctp,
    AxelarIts,
    AxelarGmp,
    Allbridge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChainClock {
    Soroban { ledger: u64, timestamp: u64 },
    Evm { timestamp: u64 },
}

impl ChainClock {
    pub fn timestamp(self) -> u64 {
        match self {
            Self::Soroban { timestamp, .. } | Self::Evm { timestamp } => timestamp,
        }
    }
    pub fn flow_tick(self) -> u64 {
        match self {
            Self::Soroban { ledger, .. } => ledger,
            Self::Evm { timestamp } => timestamp,
        }
    }
    pub fn advance(&mut self, seconds: u64, ledgers: u64) {
        match self {
            Self::Soroban { ledger, timestamp } => {
                *ledger += ledgers;
                *timestamp += seconds;
            }
            Self::Evm { timestamp } => *timestamp += seconds,
        }
    }
}

/// Fixed actor identities: 0 initial admin, 1 initial guardian, 2 unrelated caller, 3..7 nominees.
/// EVM grants are additive until renounced; Soroban replaces its configured actor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    Dispatch {
        rail: Rail,
        amount: u64,
    },
    Inbound {
        amount: u64,
        recipient: usize,
        nonce: usize,
    },
    Block {
        recipient: usize,
        blocked: bool,
    },
    Settle {
        id: usize,
    },
    Pause {
        actor: u8,
    },
    Unpause {
        actor: u8,
    },
    QueueFee {
        actor: u8,
        bps: u64,
    },
    QueueAuthority {
        actor: u8,
        target: u8,
        guardian: bool,
    },
    Renounce {
        actor: u8,
        guardian: bool,
    },
    Execute {
        actor: u8,
        id: usize,
    },
    Cancel {
        actor: u8,
        id: usize,
    },
    Advance {
        seconds: u64,
        ledgers: u64,
    },
}

impl Operation {
    /// One portable, shrinkable word vocabulary shared by the native and Foundry drivers.
    pub fn decode(word: u64) -> Self {
        let arg = word >> 16;
        let small = word >> 8;
        let actor = (small % 3) as u8;
        match (word & 255) % 10 {
            0 => Self::Dispatch {
                rail: [
                    Rail::Cctp,
                    Rail::AxelarIts,
                    Rail::AxelarGmp,
                    Rail::Allbridge,
                ][(small % 4) as usize],
                amount: arg % 1_500_000_000,
            },
            1 => Self::Inbound {
                amount: arg % 1_500_000_000,
                recipient: (small % 2) as usize,
                nonce: ((word >> 10) % 16) as usize,
            },
            2 => Self::Block {
                recipient: (small % 2) as usize,
                blocked: arg & 1 != 0,
            },
            3 => Self::Settle {
                id: (small % 20 + 1) as usize,
            },
            4 => Self::Pause { actor },
            5 => Self::Unpause { actor },
            6 => Self::QueueFee {
                actor,
                bps: arg % 121,
            },
            7 => Self::Execute {
                actor,
                id: (arg % 20 + 1) as usize,
            },
            8 => Self::Cancel {
                actor,
                id: (arg % 20 + 1) as usize,
            },
            _ => Self::Advance {
                seconds: arg % 800_000,
                ledgers: small % 1_500,
            },
        }
    }
}

/// One deterministic administrative sequence for timelock boundary exploration.
///
/// This is fixture vocabulary, not contract state. It covers nomination, supersession,
/// cancellation, disable (pause), early/execution-race, maturity and expiration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TimelockBoundaryCase {
    pub name: &'static str,
    pub operation: Operation,
}

pub const fn timelock_boundary_cases() -> [TimelockBoundaryCase; 38] {
    timelock_boundary_cases_for(
        0,
        ChainClock::Soroban {
            ledger: 0,
            timestamp: 0,
        },
    )
}

/// Seeded full administrative payloads, keeping each chain's authority policy and time floor.
pub const fn timelock_boundary_cases_for(
    seed: u64,
    clock: ChainClock,
) -> [TimelockBoundaryCase; 38] {
    let evm = matches!(clock, ChainClock::Evm { .. });
    let delay = if evm { 172800 } else { 3600 };
    let admin = 3 + ((seed & 1) * 2) as u8;
    let guardian = admin + 1;
    let rejected_admin = admin ^ 2;
    let rejected_guardian = guardian ^ 2;
    let bps = 10 + seed % 70;
    [
        TimelockBoundaryCase {
            name: "admin nomination later cancelled",
            operation: Operation::QueueAuthority {
                actor: 0,
                target: rejected_admin,
                guardian: false,
            },
        },
        TimelockBoundaryCase {
            name: "replacement admin nomination",
            operation: Operation::QueueAuthority {
                actor: 0,
                target: admin,
                guardian: false,
            },
        },
        TimelockBoundaryCase {
            name: "superseded nomination cancellation",
            operation: Operation::Cancel { actor: 1, id: 1 },
        },
        TimelockBoundaryCase {
            name: "guardian nomination",
            operation: Operation::QueueAuthority {
                actor: 0,
                target: guardian,
                guardian: true,
            },
        },
        TimelockBoundaryCase {
            name: "guardian nomination later cancelled",
            operation: Operation::QueueAuthority {
                actor: 0,
                target: rejected_guardian,
                guardian: true,
            },
        },
        TimelockBoundaryCase {
            name: "cancel superseded guardian",
            operation: Operation::Cancel { actor: 1, id: 4 },
        },
        TimelockBoundaryCase {
            name: "pending nominee cannot queue",
            operation: Operation::QueueFee { actor: admin, bps },
        },
        TimelockBoundaryCase {
            name: "cancelled nominee cannot queue",
            operation: Operation::QueueFee {
                actor: rejected_admin,
                bps,
            },
        },
        TimelockBoundaryCase {
            name: "pending guardian cannot disable",
            operation: Operation::Pause { actor: guardian },
        },
        TimelockBoundaryCase {
            name: "early execution race",
            operation: Operation::Execute { actor: 0, id: 2 },
        },
        TimelockBoundaryCase {
            name: "one second before maturity",
            operation: Operation::Advance {
                seconds: delay - 1,
                ledgers: 0,
            },
        },
        TimelockBoundaryCase {
            name: "refuse at eta minus one",
            operation: Operation::Execute { actor: 0, id: 2 },
        },
        TimelockBoundaryCase {
            name: "exact maturity",
            operation: Operation::Advance {
                seconds: 1,
                ledgers: 0,
            },
        },
        TimelockBoundaryCase {
            name: "grant or replace guardian",
            operation: Operation::Execute { actor: 0, id: 3 },
        },
        TimelockBoundaryCase {
            name: "grant or replace admin",
            operation: Operation::Execute { actor: 0, id: 2 },
        },
        TimelockBoundaryCase {
            name: "retire old admin",
            operation: if evm {
                Operation::Renounce {
                    actor: 0,
                    guardian: false,
                }
            } else {
                Operation::QueueFee { actor: 0, bps }
            },
        },
        TimelockBoundaryCase {
            name: "old admin cannot queue",
            operation: Operation::QueueFee { actor: 0, bps },
        },
        TimelockBoundaryCase {
            name: "retire old guardian",
            operation: if evm {
                Operation::Renounce {
                    actor: 1,
                    guardian: true,
                }
            } else {
                Operation::Pause { actor: 1 }
            },
        },
        TimelockBoundaryCase {
            name: "old guardian cannot disable",
            operation: Operation::Pause { actor: 1 },
        },
        TimelockBoundaryCase {
            name: "new admin queues full fee payload",
            operation: Operation::QueueFee { actor: admin, bps },
        },
        TimelockBoundaryCase {
            name: "new guardian disables",
            operation: Operation::Pause { actor: guardian },
        },
        TimelockBoundaryCase {
            name: "old admin cannot unpause",
            operation: Operation::Unpause { actor: 0 },
        },
        TimelockBoundaryCase {
            name: "new admin unpauses",
            operation: Operation::Unpause { actor: admin },
        },
        TimelockBoundaryCase {
            name: "new queued action still early",
            operation: Operation::Execute {
                actor: admin,
                id: 5,
            },
        },
        TimelockBoundaryCase {
            name: "new action maturity",
            operation: Operation::Advance {
                seconds: delay,
                ledgers: 0,
            },
        },
        TimelockBoundaryCase {
            name: "execute at exact eta",
            operation: Operation::Execute {
                actor: admin,
                id: 5,
            },
        },
        TimelockBoundaryCase {
            name: "execution race loser",
            operation: Operation::Execute {
                actor: admin,
                id: 5,
            },
        },
        TimelockBoundaryCase {
            name: "queue last-second boundary",
            operation: Operation::QueueFee {
                actor: admin,
                bps: bps + 1,
            },
        },
        TimelockBoundaryCase {
            name: "inclusive expires at",
            operation: Operation::Advance {
                seconds: delay + 604800,
                ledgers: 0,
            },
        },
        TimelockBoundaryCase {
            name: "execute at exact expires at",
            operation: Operation::Execute {
                actor: admin,
                id: 6,
            },
        },
        TimelockBoundaryCase {
            name: "queue actual expiring action",
            operation: Operation::QueueFee {
                actor: admin,
                bps: bps + 2,
            },
        },
        TimelockBoundaryCase {
            name: "one second beyond expiry",
            operation: Operation::Advance {
                seconds: delay + 604801,
                ledgers: 0,
            },
        },
        TimelockBoundaryCase {
            name: "expired execution refused",
            operation: Operation::Execute {
                actor: admin,
                id: 7,
            },
        },
        TimelockBoundaryCase {
            name: "cancel expired action",
            operation: Operation::Cancel {
                actor: guardian,
                id: 7,
            },
        },
        TimelockBoundaryCase {
            name: "superseded nominee cannot execute",
            operation: Operation::Execute {
                actor: rejected_admin,
                id: 7,
            },
        },
        TimelockBoundaryCase {
            name: "queue cancellation race",
            operation: Operation::QueueFee {
                actor: admin,
                bps: bps + 3,
            },
        },
        TimelockBoundaryCase {
            name: "guardian cancellation wins",
            operation: Operation::Cancel {
                actor: guardian,
                id: 8,
            },
        },
        TimelockBoundaryCase {
            name: "cancelled execution refused",
            operation: Operation::Execute {
                actor: admin,
                id: 8,
            },
        },
    ]
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelError {
    Unauthorized,
    Paused,
    InvalidAmount,
    FlowLimit,
    Replay,
    Missing,
    Blocked,
    Early,
    Expired,
    FeeTooHigh,
    Capacity,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ModelClaim {
    pub amount: u64,
    pub recipient: usize,
    pub settled: bool,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Action {
    kind: u8,
    value: u64,
    eta: u64,
    pending: bool,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Window {
    epoch: u64,
    current: u64,
    previous: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRouter {
    pub clock: ChainClock,
    pub balances: [u64; 6], // user, treasury, rail, router, recipient0, recipient1
    pub paused: bool,
    pub fee_bps: u64,
    pub nonce: u64,
    pub claim_count: usize,
    pub action_count: usize,
    pub admin_actors: u16,
    pub guardian_actors: u16,
    pub claims: [ModelClaim; MODEL_MAX_CLAIMS],
    blocked: [bool; 2],
    seen: [bool; 16],
    actions: [Action; MODEL_MAX_STEPS],
    windows: [Window; 4],
    window_span: u64,
    delay: u64,
    quantum: u64,
}

impl ModelRouter {
    pub fn new(clock: ChainClock) -> Self {
        let evm = matches!(clock, ChainClock::Evm { .. });
        Self {
            clock,
            balances: [MODEL_FUNDS, 0, MODEL_FUNDS, 0, 0, 0],
            paused: false,
            fee_bps: 10,
            nonce: 0,
            claim_count: 0,
            action_count: 0,
            admin_actors: 1,
            guardian_actors: 2,
            claims: [ModelClaim::default(); MODEL_MAX_CLAIMS],
            blocked: [false; 2],
            seen: [false; 16],
            actions: [Action::default(); MODEL_MAX_STEPS],
            windows: [Window::default(); 4],
            window_span: if evm { 3600 } else { 720 },
            delay: if evm { 172800 } else { 3600 },
            quantum: if evm { 1 } else { 10 },
        }
    }

    fn rolled(&self, rail: usize) -> Window {
        let epoch = self.clock.flow_tick() / self.window_span;
        let old = self.windows[rail];
        if epoch == old.epoch {
            old
        } else {
            Window {
                epoch,
                current: 0,
                previous: if epoch == old.epoch + 1 {
                    old.current
                } else {
                    0
                },
            }
        }
    }
    pub fn available(&self, rail: Rail) -> u64 {
        let w = self.rolled(rail as usize);
        let used = w.current
            + w.previous * (self.window_span - self.clock.flow_tick() % self.window_span)
                / self.window_span;
        MODEL_LIMIT.saturating_sub(used)
    }
    pub fn liabilities(&self) -> [u64; 2] {
        let mut sums = [0; 2];
        for claim in &self.claims[..self.claim_count] {
            if !claim.settled {
                sums[claim.recipient] += claim.amount;
            }
        }
        sums
    }
    pub fn conserved(&self) -> bool {
        self.balances.iter().sum::<u64>() == 2 * MODEL_FUNDS
            && self.liabilities().iter().sum::<u64>() == self.balances[3]
    }
    /// Clone-and-commit specifies transaction rollback independently of each host's mechanics.
    pub fn apply(&mut self, op: Operation) -> Result<u64, ModelError> {
        let mut next = self.clone();
        let result = next.step(op)?;
        *self = next;
        Ok(result)
    }
    /// Full retained model payload for failure traces: kind (fee/admin/guardian), value, eta, pending.
    pub fn action_details(&self, id: usize) -> Option<(u8, u64, u64, bool)> {
        if id == 0 || id > self.action_count {
            return None;
        }
        let action = self.actions[id - 1];
        Some((action.kind, action.value, action.eta, action.pending))
    }
    pub fn is_admin(&self, actor: u8) -> bool {
        actor < 8 && self.admin_actors & (1 << actor) != 0
    }
    pub fn is_guardian(&self, actor: u8) -> bool {
        actor < 8 && self.guardian_actors & (1 << actor) != 0
    }
    fn queue(&mut self, actor: u8, kind: u8, value: u64) -> Result<u64, ModelError> {
        if !self.is_admin(actor) {
            return Err(ModelError::Unauthorized);
        }
        if kind == 0 && value > 100 {
            return Err(ModelError::FeeTooHigh);
        }
        if kind != 0 && value >= 8 {
            return Err(ModelError::InvalidAmount);
        }
        if self.action_count == MODEL_MAX_STEPS {
            return Err(ModelError::Capacity);
        }
        self.actions[self.action_count] = Action {
            kind,
            value,
            eta: self.clock.timestamp() + self.delay,
            pending: true,
        };
        self.action_count += 1;
        Ok(self.action_count as u64)
    }
    fn step(&mut self, op: Operation) -> Result<u64, ModelError> {
        use ModelError as E;
        match op {
            Operation::Dispatch { rail, amount } => {
                if self.paused {
                    return Err(E::Paused);
                }
                let fee = amount * self.fee_bps / 10000;
                let net = (amount - fee) / self.quantum * self.quantum;
                if net == 0 || net + fee > self.balances[0] {
                    return Err(E::InvalidAmount);
                }
                if net > self.available(rail) {
                    return Err(E::FlowLimit);
                }
                let mut w = self.rolled(rail as usize);
                w.current += net;
                self.windows[rail as usize] = w;
                self.balances[0] -= net + fee;
                self.balances[1] += fee;
                self.balances[2] += net;
                self.nonce += 1;
                return Ok(self.nonce);
            }
            Operation::Inbound {
                amount,
                recipient,
                nonce,
            } => {
                if recipient >= 2 || nonce >= 16 || amount == 0 || amount > self.balances[2] {
                    return Err(E::InvalidAmount);
                }
                if self.seen[nonce] {
                    return Err(E::Replay);
                }
                self.seen[nonce] = true;
                self.balances[2] -= amount;
                if self.blocked[recipient] {
                    if self.claim_count == MODEL_MAX_CLAIMS {
                        return Err(E::Capacity);
                    }
                    self.claims[self.claim_count] = ModelClaim {
                        amount,
                        recipient,
                        settled: false,
                    };
                    self.claim_count += 1;
                    self.balances[3] += amount;
                    return Ok(self.claim_count as u64);
                }
                self.balances[4 + recipient] += amount;
            }
            Operation::Block { recipient, blocked } => {
                if recipient >= 2 {
                    return Err(E::InvalidAmount);
                }
                self.blocked[recipient] = blocked;
            }
            Operation::Settle { id } => {
                if id == 0 || id > self.claim_count {
                    return Err(E::Missing);
                }
                let c = &mut self.claims[id - 1];
                if c.settled {
                    return Err(E::Missing);
                }
                if self.blocked[c.recipient] {
                    return Err(E::Blocked);
                }
                c.settled = true;
                self.balances[3] -= c.amount;
                self.balances[4 + c.recipient] += c.amount;
            }
            Operation::Pause { actor } | Operation::Unpause { actor } => {
                let pause = matches!(op, Operation::Pause { .. });
                if !self.is_admin(actor) && (!pause || !self.is_guardian(actor)) {
                    return Err(E::Unauthorized);
                }
                if matches!(self.clock, ChainClock::Evm { .. }) && self.paused == pause {
                    return Err(E::Paused);
                }
                self.paused = pause;
            }
            Operation::QueueFee { actor, bps } => return self.queue(actor, 0, bps),
            Operation::QueueAuthority {
                actor,
                target,
                guardian,
            } => {
                return self.queue(actor, if guardian { 2 } else { 1 }, target as u64);
            }
            Operation::Renounce { actor, guardian } => {
                if !matches!(self.clock, ChainClock::Evm { .. }) || actor >= 8 {
                    return Err(E::Unauthorized);
                }
                if guardian {
                    self.guardian_actors &= !(1 << actor);
                } else {
                    self.admin_actors &= !(1 << actor);
                }
            }
            Operation::Execute { actor, id } | Operation::Cancel { actor, id } => {
                let execute = matches!(op, Operation::Execute { .. });
                if !self.is_admin(actor) && (execute || !self.is_guardian(actor)) {
                    return Err(E::Unauthorized);
                }
                if id == 0 || id > self.action_count || !self.actions[id - 1].pending {
                    return Err(E::Missing);
                }
                let action = &mut self.actions[id - 1];
                if execute {
                    if self.clock.timestamp() < action.eta {
                        return Err(E::Early);
                    }
                    if self.clock.timestamp() > action.eta + 604800 {
                        return Err(E::Expired);
                    }
                    if action.kind == 0 {
                        self.fee_bps = action.value;
                    } else {
                        let actors = if action.kind == 1 {
                            &mut self.admin_actors
                        } else {
                            &mut self.guardian_actors
                        };
                        if matches!(self.clock, ChainClock::Evm { .. }) {
                            *actors |= 1 << action.value;
                        } else {
                            *actors = 1 << action.value;
                        }
                    }
                }
                action.pending = false;
            }
            Operation::Advance { seconds, ledgers } => self.clock.advance(seconds, ledgers),
        }
        Ok(0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TraceStep {
    pub operation: Operation,
    pub outcome: Result<u64, ModelError>,
}
#[derive(Clone, Debug)]
pub struct Trace {
    pub steps: [Option<TraceStep>; MODEL_MAX_STEPS],
    pub len: usize,
}
impl Default for Trace {
    fn default() -> Self {
        Self {
            steps: [None; MODEL_MAX_STEPS],
            len: 0,
        }
    }
}
impl Trace {
    pub fn push(&mut self, step: TraceStep) -> Result<(), ModelError> {
        if self.len == MODEL_MAX_STEPS {
            return Err(ModelError::Capacity);
        }
        self.steps[self.len] = Some(step);
        self.len += 1;
        Ok(())
    }
    /// Deletion shrinker: caller must rebuild both worlds and identify the same discrepancy.
    /// Repeats until no individual deletion preserves the failure (a 1-minimal trace).
    pub fn minimize<F: FnMut(&[Operation]) -> bool>(&self, mut fails: F) -> Self {
        let mut ops = [Operation::Advance {
            seconds: 0,
            ledgers: 0,
        }; MODEL_MAX_STEPS];
        for (i, entry) in self.steps[..self.len].iter().enumerate() {
            ops[i] = entry.unwrap().operation;
        }
        let mut len = self.len;
        if !fails(&ops[..len]) {
            return self.clone();
        }
        let mut i = 0;
        while i < len {
            let mut candidate = ops;
            candidate.copy_within(i + 1..len, i);
            if fails(&candidate[..len - 1]) {
                ops = candidate;
                len -= 1;
                i = 0;
            } else {
                i += 1;
            }
        }
        let mut result = Self::default();
        for op in &ops[..len] {
            result
                .push(TraceStep {
                    operation: *op,
                    outcome: Ok(0),
                })
                .unwrap();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authority_boundaries_include_real_handover_and_inclusive_expiry() {
        for clock in [
            ChainClock::Evm { timestamp: 100 },
            ChainClock::Soroban {
                timestamp: 100,
                ledger: 1,
            },
        ] {
            for seed in 0..12 {
                let mut model = ModelRouter::new(clock);
                for case in timelock_boundary_cases_for(seed, clock) {
                    let result = model.apply(case.operation);
                    match case.name {
                        "refuse at eta minus one" => assert_eq!(result, Err(ModelError::Early)),
                        "execute at exact eta" | "execute at exact expires at" => {
                            assert_eq!(result, Ok(0))
                        }
                        "expired execution refused" => assert_eq!(result, Err(ModelError::Expired)),
                        "old admin cannot queue"
                        | "old guardian cannot disable"
                        | "superseded nominee cannot execute" => {
                            assert_eq!(result, Err(ModelError::Unauthorized))
                        }
                        "execution race loser" => assert_eq!(result, Err(ModelError::Missing)),
                        _ => (),
                    }
                }
                assert!(!model.is_admin(0));
                assert!(!model.is_guardian(1));
                assert_eq!(model.action_count, 8);
                assert_eq!(model.fee_bps, 11 + seed % 70);
                assert!(model.conserved());
            }
        }
    }
    #[test]
    fn clocks_do_not_exchange_ledgers_for_seconds() {
        let mut clock = ChainClock::Soroban {
            ledger: 1,
            timestamp: 2,
        };
        clock.advance(3600, 0);
        assert_eq!(clock.flow_tick(), 1);
        assert_eq!(clock.timestamp(), 3602);
        let mut evm = ChainClock::Evm { timestamp: 2 };
        evm.advance(0, 720);
        assert_eq!(evm.flow_tick(), 2);
    }
    #[test]
    fn deletion_shrinker_reproduces_a_frozen_recipient_fault() {
        let operations = [
            Operation::Advance {
                seconds: 1,
                ledgers: 1,
            },
            Operation::Block {
                recipient: 0,
                blocked: true,
            },
            Operation::Pause { actor: 0 },
            Operation::Inbound {
                amount: 100,
                recipient: 0,
                nonce: 0,
            },
        ];
        let mut trace = Trace::default();
        for op in operations {
            trace
                .push(TraceStep {
                    operation: op,
                    outcome: Ok(0),
                })
                .unwrap();
        }
        // Simulate a faulty implementation that drops parked liabilities.
        let minimal = trace.minimize(|ops| {
            let mut model = ModelRouter::new(ChainClock::Evm { timestamp: 100 });
            for op in ops {
                let _ = model.apply(*op);
            }
            model.balances[3] > 0
        });
        assert_eq!(minimal.len, 2);
        assert_eq!(minimal.steps[0].unwrap().operation, operations[1]);
        assert_eq!(minimal.steps[1].unwrap().operation, operations[3]);
    }
}
