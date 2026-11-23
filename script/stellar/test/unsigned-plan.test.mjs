import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assetContractId, buildUnsignedPlan } from "../unsigned-plan.mjs";
import { loadDeploymentProtocol } from "../record-evidence.mjs";

const source = JSON.parse(
  readFileSync("deployments/stellar-testnet-phase1.json", "utf8"),
);
const original = source.networks["stellar-testnet"];
const definitions = [
  [
    "router",
    "hyperion_router.wasm",
    "ROUTER_HASH",
    ["initialize", "queue_action", "execute_action"],
  ],
  [
    "adapter-cctp",
    "hyperion_adapter_cctp.wasm",
    "CCTP_HASH",
    ["initialize", "link_domain", "map_asset"],
  ],
  [
    "adapter-axelar",
    "hyperion_adapter_axelar.wasm",
    "AXELAR_HASH",
    ["initialize", "link_chain", "map_token"],
  ],
];
function leb(value) {
  const result = [];
  do {
    let next = value & 127;
    value >>>= 7;
    if (value) next |= 128;
    result.push(next);
  } while (value);
  return result;
}
function str(value) {
  const bytes = [...Buffer.from(value)];
  return [...leb(bytes.length), ...bytes];
}
function section(id, value) {
  return [id, ...leb(value.length), ...value];
}
function wasm(names) {
  const u32 = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return [...bytes];
  };
  const xdrString = (value) => [
    ...u32(value.length),
    ...Buffer.from(value),
    ...Array((4 - (value.length % 4)) % 4).fill(0),
  ];
  const spec = names.flatMap((name) => [
    ...u32(0),
    ...u32(0),
    ...xdrString(name),
    ...u32(0),
    ...u32(0),
  ]);
  return Buffer.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 96, 0, 0]),
    ...section(3, [...leb(names.length), ...names.map(() => 0)]),
    ...section(7, [
      ...leb(names.length),
      ...names.flatMap((name, index) => [...str(name), 0, ...leb(index)]),
    ]),
    ...section(10, [...leb(names.length), ...names.flatMap(() => [2, 0, 11])]),
    ...section(0, [...str("contractspecv0"), ...spec]),
  ]);
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hyperion-unsigned-plan-"));
  const env = {
    STELLAR_NETWORK: "testnet",
    HYPERION_DEPLOYER: original.deployer,
    HYPERION_ADMIN: original.admin,
    HYPERION_GUARDIAN: original.guardian,
    HYPERION_TREASURY: original.treasury,
    HYPERION_ASSET: `USDC:${original.tokens.USDC.issuer}`,
    HYPERION_SAC: original.tokens.USDC.sacId,
    HYPERION_PEER_CHAIN: "sepolia",
    HYPERION_WASM_DIR: directory,
    CCTP_PEER_DOMAIN: "0",
    CCTP_DESTINATION_CALLER: `0x${"11".repeat(32)}`,
    CCTP_PEER_BURN_TOKEN: `0x${"22".repeat(32)}`,
    AXELAR_PEER_CHAIN: "ethereum-sepolia",
    AXELAR_PEER_ADDRESS: `0x${"33".repeat(20)}`,
    AXELAR_TOKEN_ID: `0x${"44".repeat(32)}`,
  };
  const record = structuredClone(source);
  record.networks["stellar-testnet"].providers = {
    cctpTokenMessenger: original.adapters.cctp,
    cctpMessageTransmitter: original.adapters["axelar-its"],
    axelarIts: original.router,
  };
  record.networks["stellar-testnet"].providerCodeHashes = Object.fromEntries(
    Object.values(record.networks["stellar-testnet"].providers).map((id) => [
      id,
      "a".repeat(64),
    ]),
  );
  for (const [key, name, variable, exports] of definitions) {
    const bytes = wasm(exports);
    writeFileSync(join(directory, name), bytes);
    env[variable] = createHash("sha256").update(bytes).digest("hex");
    record.networks["stellar-testnet"].wasmHashes[key] = env[variable];
  }
  const details = [
    {
      id: "1",
      queued_at: "100",
      eta: "3700",
      expires_at: "608500",
      action: { RegisterToken: [env.HYPERION_SAC, 7, "10000000000000"] },
    },
  ];
  record.networks["stellar-testnet"].timelockDelay = 3600;
  record.networks["stellar-testnet"].queuedActionIds = [1];
  record.networks["stellar-testnet"].queuedActionDetails = details;
  return {
    directory,
    env,
    record,
    details,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("asset identity agrees with published Stellar issuance and changes with network", async () => {
  const protocol = await loadDeploymentProtocol();
  assert.equal(
    assetContractId(
      original.tokens.USDC.code,
      original.tokens.USDC.issuer,
      original.networkPassphrase,
      protocol,
    ),
    original.tokens.USDC.sacId,
  );
  assert.notEqual(
    assetContractId(
      original.tokens.USDC.code,
      original.tokens.USDC.issuer,
      protocol.chain("stellar").networkPassphrase,
      protocol,
    ),
    original.tokens.USDC.sacId,
  );
});
test("complete deploy plan links providers before router enable and hands admin over last", async () => {
  const f = fixture();
  try {
    const env = {
      ...f.env,
      HYPERION_ADMIN: original.tokens.USDC.issuer,
      HYPERION_FLOW_WINDOW_LEDGERS: "100",
      CCTP_TOKEN_MESSENGER: original.adapters.cctp,
      CCTP_MESSAGE_TRANSMITTER: original.adapters["axelar-its"],
      AXELAR_ITS: original.router,
    };
    const codeIdentities = Object.fromEntries(
      [
        env.CCTP_TOKEN_MESSENGER,
        env.CCTP_MESSAGE_TRANSMITTER,
        env.AXELAR_ITS,
      ].map((id) => [id, "a".repeat(64)]),
    );
    const plan = await buildUnsignedPlan("deploy", env, { codeIdentities });
    assert.equal(plan.submitted, false);
    assert.equal(plan.signed, false);
    assert(plan.operations.every((entry) => entry.signed === false));
    const initialization = plan.operations.find(
      (entry) => entry.method === "initialize" && entry.target === "@router",
    );
    assert.equal(initialization.args.flow_window_ledgers, "100");
    assert.equal(Object.hasOwn(initialization.args, "flow_window"), false);
    const lastLink = plan.operations
      .filter((entry) => entry.phase === "link")
      .at(-1).sequence;
    const firstEnable = plan.operations.find(
      (entry) => entry.args.action?.EnableRoute !== undefined,
    ).sequence;
    assert(lastLink < firstEnable);
    assert(
      plan.operations
        .filter((entry) => entry.phase === "execute")
        .every((entry) => entry.requiresTimelockMaturity),
    );
    assert.equal(
      plan.operations.find((entry) => entry.method === "link_domain").args
        .domain,
      "0",
    );
    assert.equal(
      plan.operations.find((entry) => entry.method === "map_token").args
        .token_id,
      env.AXELAR_TOKEN_ID,
    );
    const executions = plan.operations.filter(
      (entry) => entry.phase === "execute",
    );
    assert.deepEqual(executions.at(-1).args.action, {
      SetAdmin: env.HYPERION_ADMIN,
    });
    assert.equal(
      executions.filter((entry) => entry.args.action.SetAdmin).length,
      1,
    );
  } finally {
    f.close();
  }
});
test("missing artifacts, unapproved or wrong code, wrong interface and bad public configuration block plans", async () => {
  const f = fixture();
  try {
    for (const change of [
      { ROUTER_HASH: undefined },
      { ROUTER_HASH: "a".repeat(64) },
      { CCTP_HASH: "0".repeat(64) },
      { STELLAR_NETWORK: "unknown" },
      { HYPERION_DEPLOYER: "G".repeat(56) },
      { HYPERION_ADMIN: original.router },
      { HYPERION_FEE_BPS: "101" },
      { HYPERION_TIMELOCK_DELAY: "3599" },
      { HYPERION_FLOW_WINDOW_LEDGERS: "0" },
      { HYPERION_TOKEN_FLOW_LIMIT: (1n << 127n).toString() },
      { HYPERION_SAC: original.router },
      { HYPERION_PEER_CHAIN: "unknown" },
      { CCTP_TOKEN_MESSENGER: original.router },
      {
        CCTP_TOKEN_MESSENGER: original.router,
        CCTP_MESSAGE_TRANSMITTER: original.adapters.cctp,
      },
    ])
      await assert.rejects(
        buildUnsignedPlan("deploy", { ...f.env, ...change }),
      );
    const path = join(f.directory, "hyperion_router.wasm");
    writeFileSync(path, "not wasm");
    await assert.rejects(buildUnsignedPlan("deploy", f.env), /artifact/);
    const bytes = wasm(["unrelated"]);
    writeFileSync(path, bytes);
    await assert.rejects(
      buildUnsignedPlan("deploy", {
        ...f.env,
        ROUTER_HASH: createHash("sha256").update(bytes).digest("hex"),
      }),
      /interface/,
    );
    rmSync(path);
    await assert.rejects(buildUnsignedPlan("deploy", f.env));
  } finally {
    f.close();
  }
});
test("record plans validate selected network, lifecycle, identities and concrete link arguments", async () => {
  const f = fixture();
  try {
    for (const mode of ["link", "execute", "verify"]) {
      const plan = await buildUnsignedPlan(mode, f.env, { record: f.record });
      assert(plan.operations.length > 0);
      if (mode === "verify") {
        const configuration = plan.operations.find(
          (entry) =>
            entry.method === "get_config" && entry.target === original.router,
        ).args.expected;
        assert.equal(configuration.flow_window_ledgers, original.flowWindow);
        assert.equal(Object.hasOwn(configuration, "flow_window"), false);
      }
      for (const mutate of [
        (d) =>
          (d.networks["stellar-testnet"].networkPassphrase = "wrong network"),
        (d) => (d.networks["stellar-testnet"].status = "archived"),
        (d) =>
          (d.networks["stellar-testnet"].wasmHashes.router = "a".repeat(64)),
        (d) => (d.networks.stellar = d.networks["stellar-testnet"]),
        (d) => delete d.networks["stellar-testnet"].providerCodeHashes,
      ]) {
        const record = structuredClone(f.record);
        mutate(record);
        await assert.rejects(buildUnsignedPlan(mode, f.env, { record }));
      }
    }
    for (const change of [
      { CCTP_PEER_DOMAIN: "4294967296" },
      { CCTP_DESTINATION_CALLER: "0x1234" },
      { AXELAR_PEER_ADDRESS: `0x${"11".repeat(32)}` },
      { AXELAR_TOKEN_ID: `0x${"0".repeat(64)}` },
    ])
      await assert.rejects(
        buildUnsignedPlan(
          "link",
          { ...f.env, ...change },
          { record: f.record },
        ),
      );
  } finally {
    f.close();
  }
});
test("execute plans require full canonical payloads, exact IDs and valid timelock boundaries", async () => {
  const f = fixture();
  try {
    const plan = await buildUnsignedPlan("execute", f.env, {
      record: f.record,
    });
    const execution = plan.operations.find(
      (entry) => entry.phase === "execute",
    );
    assert.deepEqual(execution.args.action, f.details[0].action);
    assert.equal(execution.eta, "3700");
    assert(
      plan.operations
        .filter((entry) => entry.phase === "preflight")
        .every((entry) => entry.sequence < execution.sequence),
    );
    assert(
      plan.operations.some((entry) => entry.method === "get_action_payload"),
    );
    for (const change of [
      { id: "18446744073709551616" },
      { eta: "3699" },
      { expires_at: "608501" },
      { action: { Unknown: true } },
      { action: { RegisterToken: [f.env.HYPERION_SAC, 7, "1e18"] } },
      { action: { SetAdmin: "G".repeat(56) } },
      { executed: true },
      { cancelled: true },
    ])
      await assert.rejects(
        buildUnsignedPlan("execute", f.env, {
          record: f.record,
          queuedActions: [{ ...f.details[0], ...change }],
        }),
      );
    const record = structuredClone(f.record);
    delete record.networks["stellar-testnet"].queuedActionDetails;
    await assert.rejects(
      buildUnsignedPlan("execute", f.env, { record }),
      /full queued/,
    );
    const handover = {
      ...f.details[0],
      id: "2",
      action: { SetAdmin: original.tokens.USDC.issuer },
    };
    const ordered = structuredClone(f.record);
    ordered.networks["stellar-testnet"].queuedActionIds = [1, 2];
    assert.equal(
      (
        await buildUnsignedPlan("execute", f.env, {
          record: ordered,
          queuedActions: [f.details[0], handover],
        })
      ).operations.at(-1).args.action.SetAdmin,
      handover.action.SetAdmin,
    );
    ordered.networks["stellar-testnet"].queuedActionIds = [2, 1];
    await assert.rejects(
      buildUnsignedPlan("execute", f.env, {
        record: ordered,
        queuedActions: [handover, f.details[0]],
      }),
      /handover.*last/,
    );
  } finally {
    f.close();
  }
});
test("record writer dry-run validates artifacts without git, RPC, CLI or filesystem writes", async () => {
  const f = fixture();
  try {
    const marker = join(f.directory, "git-access");
    writeFileSync(
      join(f.directory, "git"),
      `#!/bin/sh\nprintf access > '${marker}'\nexit 99\n`,
      { mode: 0o700 },
    );
    const out = join(f.directory, "record-plan.json");
    const identityPath = join(f.directory, "identities.json");
    writeFileSync(
      identityPath,
      JSON.stringify(f.record.networks["stellar-testnet"].providerCodeHashes),
    );
    const env = {
      PATH: `${f.directory}:${process.env.PATH}`,
      ...f.env,
      HYPERION_DRY_RUN: "1",
      HYPERION_ROUTER: original.router,
      HYPERION_CCTP: original.adapters.cctp,
      HYPERION_AXELAR: original.adapters["axelar-its"],
      CCTP_TOKEN_MESSENGER: original.adapters.cctp,
      CCTP_MESSAGE_TRANSMITTER: original.adapters["axelar-its"],
      AXELAR_ITS: original.router,
      HYPERION_CODE_IDENTITIES: identityPath,
      HYPERION_SOURCE_COMMIT: "f".repeat(40),
      HYPERION_ROUTER_LEDGER: "100",
      HYPERION_FEE_BPS: "30",
      HYPERION_FLOW_WINDOW_LEDGERS: "720",
      HYPERION_TIMELOCK_DELAY: "3600",
      HYPERION_TOKEN_FLOW_LIMIT: "10000000000000",
      STELLAR_RPC_URL: "http://127.0.0.1:1",
    };
    const run = (extra = {}) =>
      spawnSync(process.execPath, ["script/stellar/write-record.mjs", out], {
        env: { ...env, ...extra },
        encoding: "utf8",
      });
    const child = run();
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).intent, "record");
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(out), false);
    for (const extra of [
      { HYPERION_SOURCE_COMMIT: "unknown" },
      { HYPERION_ROUTER_LEDGER: "" },
      { ROUTER_HASH: "a".repeat(64) },
    ]) {
      assert.notEqual(run(extra).status, 0);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(out), false);
    }
  } finally {
    f.close();
  }
});
test("all shell dry-run entries emit plans without invoking any Stellar CLI or touching signer material", async () => {
  const f = fixture();
  try {
    const recordPath = join(f.directory, "record.json");
    writeFileSync(recordPath, JSON.stringify(f.record));
    const marker = join(f.directory, "signer-access");
    const executable = join(f.directory, "stellar");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf access > '${marker}'\nexit 99\n`,
      { mode: 0o700 },
    );
    for (const mode of ["deploy", "link", "execute", "verify"]) {
      const child = spawnSync("bash", [resolve(`script/stellar/${mode}.sh`)], {
        env: {
          PATH: `${f.directory}:${process.env.PATH}`,
          HOME: f.directory,
          ...f.env,
          HYPERION_DRY_RUN: "1",
          HYPERION_RECORD: recordPath,
        },
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout).submitted, false);
      assert.equal(existsSync(marker), false);
    }
  } finally {
    f.close();
  }
});
