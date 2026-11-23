//! cargo run -p hyperion-core --example authority_vectors -- ../testdata [--check]
use hyperion_core::model::{
    timelock_boundary_cases_for, ChainClock, ModelError, ModelRouter, Operation,
};
use std::{env, fmt::Write as _, fs, path::Path};

fn main() {
    let root = env::args().nth(1).expect("output testdata directory");
    for (chain, clock) in [
        (
            "evm",
            ChainClock::Evm {
                timestamp: 1_701_000_000,
            },
        ),
        (
            "soroban",
            ChainClock::Soroban {
                timestamp: 1_701_000_000,
                ledger: 100_000,
            },
        ),
    ] {
        let mut out = String::from("# seed,step,operation,actor,arg,error,result,time,ledger,admins,guardians,fee,paused,count,payload_kind,payload_value,payload_eta,payload_pending\n");
        for seed in 0..12 {
            let mut model = ModelRouter::new(clock);
            for (step, case) in timelock_boundary_cases_for(seed, clock)
                .into_iter()
                .enumerate()
            {
                let (kind, actor, arg) = match case.operation {
                    Operation::QueueFee { actor, bps } => (0, actor, bps),
                    Operation::QueueAuthority {
                        actor,
                        target,
                        guardian,
                    } => (if guardian { 2 } else { 1 }, actor, target as u64),
                    Operation::Pause { actor } => (3, actor, 0),
                    Operation::Unpause { actor } => (4, actor, 0),
                    Operation::Execute { actor, id } => (5, actor, id as u64),
                    Operation::Cancel { actor, id } => (6, actor, id as u64),
                    Operation::Advance { seconds, .. } => (7, 0, seconds),
                    Operation::Renounce { actor, guardian } => {
                        (if guardian { 9 } else { 8 }, actor, 0)
                    }
                    _ => unreachable!(),
                };
                let payload = if kind == 5 || kind == 6 {
                    model.action_details(arg as usize)
                } else {
                    None
                };
                let result = model.apply(case.operation);
                let error = match result {
                    Ok(_) => 0,
                    Err(ModelError::Unauthorized) => 1,
                    Err(ModelError::Early) => 2,
                    Err(ModelError::Expired) => 3,
                    Err(ModelError::Missing) => 4,
                    other => panic!("unexpected boundary result: {other:?}"),
                };
                let (pk, pv, pe, pp) = payload.unwrap_or((3, 0, 0, false));
                let ledger = match model.clock {
                    ChainClock::Soroban { ledger, .. } => ledger,
                    _ => 0,
                };
                writeln!(&mut out, "{seed},{step},{kind},{actor},{arg},{error},{},{},{ledger},{},{},{},{},{},{pk},{pv},{pe},{}",
                    result.unwrap_or(0), model.clock.timestamp(), model.admin_actors, model.guardian_actors,
                    model.fee_bps, u8::from(model.paused), model.action_count, u8::from(pp)).unwrap();
            }
        }
        let path = Path::new(&root).join(format!("router-authority-{chain}.csv"));
        if env::args().any(|a| a == "--check") {
            assert_eq!(
                fs::read_to_string(path).unwrap(),
                out,
                "stale authority corpus"
            );
        } else {
            fs::write(path, out).unwrap();
        }
    }
}
