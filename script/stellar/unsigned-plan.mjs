#!/usr/bin/env node
/** Offline public-input planning. This module has no CLI, RPC or signer dependency. */
import { createHash, hash as cryptoHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDeploymentProtocol, readBoundedText } from "./record-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_U64 = (1n << 64n) - 1n;
const MAX_I128 = (1n << 127n) - 1n;
const artifacts = {
  router: [
    "hyperion_router.wasm",
    "ROUTER_HASH",
    ["initialize", "queue_action", "execute_action"],
  ],
  "adapter-cctp": [
    "hyperion_adapter_cctp.wasm",
    "CCTP_HASH",
    ["initialize", "link_domain", "map_asset"],
  ],
  "adapter-axelar": [
    "hyperion_adapter_axelar.wasm",
    "AXELAR_HASH",
    ["initialize", "link_chain", "map_token"],
  ],
};

function text(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`${name} requires bounded public text`);
  return value;
}
function integer(value, name, max = MAX_U64, min = 0n) {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error(`${name} is not exact`);
  const raw = String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 39)
    throw new Error(`${name} is not a canonical integer`);
  const parsed = BigInt(raw);
  if (parsed < min || parsed > max)
    throw new Error(`${name} is outside its contract bounds`);
  return raw;
}
function hash(value, name) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/.test(value) ||
    /^0+$/.test(value)
  )
    throw new Error(`${name} requires a known lowercase code hash`);
  return value;
}
function hex(value, name, length) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(value) ||
    /^0x0+$/.test(value)
  )
    throw new Error(`${name} requires a nonzero ${length}-byte value`);
  return value.toLowerCase();
}

/** Standard HashIDPreimage::ContractId / FromAsset XDR, using the SDK's independent strkey codec. */
export function assetContractId(code, issuer, publicNetworkId, protocol) {
  if (!/^[A-Za-z0-9]{1,12}$/.test(code))
    throw new Error("asset code is invalid");
  const parsed = protocol.parseStellarAddress(issuer);
  if (parsed.kind !== protocol.AddressKind.Account)
    throw new Error("asset issuer must be an account");
  const uint = (n) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n);
    return bytes;
  };
  const assetCode = Buffer.alloc(code.length <= 4 ? 4 : 12);
  assetCode.write(code, "ascii");
  const preimage = Buffer.concat([
    uint(8),
    // The public Stellar network identifier uses SHA-256, as required by its XDR protocol.
    cryptoHash("sha256", publicNetworkId, "buffer"),
    uint(1),
    uint(code.length <= 4 ? 1 : 2),
    assetCode,
    uint(0),
    Buffer.from(parsed.key.slice(2), "hex"),
  ]);
  return protocol.encodeStellarAddress(
    protocol.AddressKind.Contract,
    `0x${createHash("sha256").update(preimage).digest("hex")}`,
  );
}

export async function buildUnsignedPlan(mode, env = process.env, options = {}) {
  if (!["deploy", "link", "execute", "verify", "record"].includes(mode))
    throw new Error("unknown plan mode");
  const protocol = await loadDeploymentProtocol();
  const network = env.STELLAR_NETWORK ?? "testnet";
  const chainKey =
    network === "testnet"
      ? "stellar-testnet"
      : network === "mainnet" || network === "public"
        ? "stellar"
        : null;
  if (chainKey === null) throw new Error("unknown Stellar network");
  const passphrase = protocol.chain(chainKey).networkPassphrase;
  const address = (value, name, kind = "C") => {
    if (
      typeof value !== "string" ||
      !value.startsWith(kind) ||
      !protocol.isStellarAddress(value)
    )
      throw new Error(
        `${name} requires a canonical public ${kind === "G" ? "account" : "contract"} address`,
      );
    return value;
  };
  let record;
  let deployment;
  if (mode !== "deploy") {
    const path =
      env.HYPERION_RECORD ??
      resolve(ROOT, `deployments/stellar-${network}-phase1.json`);
    record = options.record ?? JSON.parse(readBoundedText(path));
    const parsed = protocol.parseDeploymentSet(record);
    if (Object.keys(parsed.networks).length !== 1 || !parsed.networks[chainKey])
      throw new Error("record must name exactly the selected Stellar network");
    deployment = parsed.networks[chainKey];
    if (
      deployment.family !== "stellar" ||
      (mode !== "record" && deployment.status !== "active") ||
      deployment.networkPassphrase !== passphrase ||
      record.successor ||
      record.archived ||
      record.deprecated
    )
      throw new Error(
        "record is not an active deployment on the selected network",
      );
  }

  const wasmDirectory =
    options.wasmDirectory ??
    env.HYPERION_WASM_DIR ??
    resolve(ROOT, "soroban/target/wasm32v1-none/release");
  const checkedArtifacts = {};
  for (const [key, [filename, variable, requiredExports]] of Object.entries(
    artifacts,
  )) {
    if (
      deployment &&
      key !== "router" &&
      !deployment.adapters[key === "adapter-cctp" ? 0 : 1]
    )
      continue;
    const expected = hash(
      deployment?.wasmHashes[key] ?? env[variable],
      `${key} identity`,
    );
    const bytes = readFileSync(resolve(wasmDirectory, filename));
    if (
      bytes.length > 65536 ||
      bytes.length < 8 ||
      !WebAssembly.validate(bytes)
    )
      throw new Error(`${key} artifact is not a deployable WASM`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected)
      throw new Error(
        `${key} artifact differs from its reviewed code identity`,
      );
    const module = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );
    if (
      !requiredExports.every((name) => exports.includes(name)) ||
      !WebAssembly.Module.customSections(module, "contractspecv0").some(
        (section) => section.byteLength > 0,
      )
    )
      throw new Error(`${key} artifact lacks its contract interface`);
    checkedArtifacts[key] = {
      artifact: filename,
      sha256: actual,
      bytes: bytes.length,
    };
  }

  const codeIdentities =
    options.codeIdentities ??
    (env.HYPERION_CODE_IDENTITIES
      ? JSON.parse(readBoundedText(env.HYPERION_CODE_IDENTITIES))
      : (record?.networks[chainKey]?.providerCodeHashes ?? {}));
  if (
    !codeIdentities ||
    typeof codeIdentities !== "object" ||
    Array.isArray(codeIdentities) ||
    Object.keys(codeIdentities).length > 128
  )
    throw new Error(
      "provider identities require a bounded public contract-to-hash map",
    );
  for (const [id, identity] of Object.entries(codeIdentities)) {
    address(id, "provider identity map key");
    hash(identity, "provider identity map value");
  }
  const checkedProviders = {};
  const provider = (value, name) => {
    const id = address(value, name);
    checkedProviders[id] = hash(
      codeIdentities[id],
      `${name} provider identity`,
    );
    return id;
  };
  const operations = [];
  const operation = (phase, target, method, args = {}, extra = {}) => {
    operations.push({
      sequence: operations.length + 1,
      phase,
      target,
      method,
      args,
      signed: false,
      ...extra,
    });
  };
  let router;
  let caller;
  let token;
  let peer;
  let cctp;
  let axelar;
  if (mode === "deploy") {
    caller = address(env.HYPERION_DEPLOYER, "HYPERION_DEPLOYER", "G");
    const admin = address(env.HYPERION_ADMIN ?? caller, "HYPERION_ADMIN", "G");
    const guardian = address(
      env.HYPERION_GUARDIAN ?? caller,
      "HYPERION_GUARDIAN",
      "G",
    );
    const treasury = address(
      env.HYPERION_TREASURY ?? caller,
      "HYPERION_TREASURY",
      "G",
    );
    const feeBps = integer(env.HYPERION_FEE_BPS ?? "30", "fee bps", 100n);
    const flowWindow = integer(
      env.HYPERION_FLOW_WINDOW_LEDGERS ?? "720",
      "flow window",
      0xffffffffn,
      1n,
    );
    const timelockDelay = integer(
      env.HYPERION_TIMELOCK_DELAY ?? "3600",
      "timelock delay",
      2592000n,
      3600n,
    );
    const amount = integer(
      env.HYPERION_TOKEN_FLOW_LIMIT ?? "10000000000000",
      "token flow limit",
      MAX_I128,
    );
    const asset = text(
      env.HYPERION_ASSET ??
        "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "HYPERION_ASSET",
    ).split(":");
    if (asset.length !== 2) throw new Error("asset must name CODE:ISSUER");
    token = assetContractId(asset[0], asset[1], passphrase, protocol);
    if (env.HYPERION_SAC && address(env.HYPERION_SAC, "HYPERION_SAC") !== token)
      throw new Error("asset contract does not match its issuance/network");
    peer = text(env.HYPERION_PEER_CHAIN, "HYPERION_PEER_CHAIN");
    if (!protocol.isChainKey(peer) || protocol.chain(peer).family !== "evm")
      throw new Error("peer must name a known EVM chain");
    for (const [key, artifact] of Object.entries(checkedArtifacts)) {
      operation(
        "upload",
        key,
        "contract upload",
        { wasm: artifact.artifact },
        { capture: `${key}.hash` },
      );
    }
    router = env.HYPERION_ROUTER
      ? address(env.HYPERION_ROUTER, "HYPERION_ROUTER")
      : "@router";
    operation(
      "deploy",
      router,
      "contract deploy",
      { wasmHash: checkedArtifacts.router.sha256 },
      { capture: "router.address" },
    );
    operation("initialize", router, "initialize", {
      admin: caller,
      guardian,
      treasury,
      fee_bps: feeBps,
      flow_window_ledgers: flowWindow,
      timelock_delay: timelockDelay,
    });
    if (
      Boolean(env.CCTP_TOKEN_MESSENGER) !==
      Boolean(env.CCTP_MESSAGE_TRANSMITTER)
    )
      throw new Error("CCTP requires both provider contracts");
    if (env.CCTP_TOKEN_MESSENGER) {
      cctp = env.HYPERION_CCTP_ADAPTER
        ? address(env.HYPERION_CCTP_ADAPTER, "HYPERION_CCTP_ADAPTER")
        : "@adapter-cctp";
      operation(
        "deploy",
        cctp,
        "contract deploy",
        { wasmHash: checkedArtifacts["adapter-cctp"].sha256 },
        { capture: "adapter-cctp.address" },
      );
      operation("initialize", cctp, "initialize", {
        admin: caller,
        router,
        token_messenger: provider(
          env.CCTP_TOKEN_MESSENGER,
          "CCTP_TOKEN_MESSENGER",
        ),
        message_transmitter: provider(
          env.CCTP_MESSAGE_TRANSMITTER,
          "CCTP_MESSAGE_TRANSMITTER",
        ),
      });
    }
    if (env.AXELAR_ITS) {
      axelar = env.HYPERION_AXELAR_ADAPTER
        ? address(env.HYPERION_AXELAR_ADAPTER, "HYPERION_AXELAR_ADAPTER")
        : "@adapter-axelar";
      operation(
        "deploy",
        axelar,
        "contract deploy",
        { wasmHash: checkedArtifacts["adapter-axelar"].sha256 },
        { capture: "adapter-axelar.address" },
      );
      operation("initialize", axelar, "initialize", {
        admin: caller,
        router,
        its: provider(env.AXELAR_ITS, "AXELAR_ITS"),
        route: 1,
      });
    }
    const queue = (action) =>
      operation(
        "queue",
        router,
        "queue_action",
        { caller, action },
        {
          requiresTimelockMaturity: true,
          delaySeconds: timelockDelay,
          capture: "action.id",
        },
      );
    // Provider links must be reviewed before any router enable action can execute.
    addLinks();
    queue({ RegisterToken: [token, 7, amount] });
    for (const [route, adapter] of [
      [0, cctp],
      [1, axelar],
    ])
      if (adapter) {
        queue({ SetAdapter: [route, adapter] });
        queue({ SetRailReceiver: [route, adapter] });
        queue({ EnableRoute: route });
      }
    if (admin !== caller) queue({ SetAdmin: admin });
    for (const queued of operations.filter((entry) => entry.phase === "queue"))
      operation(
        "execute",
        router,
        "execute_action",
        {
          caller,
          actionId: `@action.id[${queued.sequence}]`,
          action: queued.args.action,
        },
        { requiresTimelockMaturity: true, delaySeconds: timelockDelay },
      );
  } else {
    router = deployment.router;
    caller = address(
      record.networks[chainKey].deployer ?? env.HYPERION_DEPLOYER,
      "public deployer",
      "G",
    );
    const tokens = Object.values(deployment.tokens);
    if (tokens.length !== 1)
      throw new Error("plan requires one unambiguous deployment token");
    token = tokens[0].sacId;
    if (
      assetContractId(
        tokens[0].code,
        tokens[0].issuer,
        passphrase,
        protocol,
      ) !== token
    )
      throw new Error(
        "record asset contract differs from its issuance/network",
      );
    peer = text(
      env.HYPERION_PEER_CHAIN ?? record.networks[chainKey].peerChain,
      "peer chain",
    );
    if (!protocol.isChainKey(peer) || protocol.chain(peer).family !== "evm")
      throw new Error("unknown EVM peer chain");
    cctp = deployment.adapters[0];
    axelar = deployment.adapters[1];
    const recordedProviders = record.networks[chainKey].providers ?? {};
    if (cctp) {
      provider(
        env.CCTP_TOKEN_MESSENGER ?? recordedProviders.cctpTokenMessenger,
        "CCTP_TOKEN_MESSENGER",
      );
      provider(
        env.CCTP_MESSAGE_TRANSMITTER ??
          recordedProviders.cctpMessageTransmitter,
        "CCTP_MESSAGE_TRANSMITTER",
      );
    }
    if (axelar)
      provider(env.AXELAR_ITS ?? recordedProviders.axelarIts, "AXELAR_ITS");
    if (mode === "link") addLinks();
    if (mode === "execute") {
      operation("preflight", router, "get_config", { expectedAdmin: caller });
      addReadinessChecks("preflight");
      const pending =
        options.queuedActions ??
        (env.HYPERION_QUEUED_ACTIONS
          ? JSON.parse(readBoundedText(env.HYPERION_QUEUED_ACTIONS))
          : record.networks[chainKey].queuedActionDetails);
      const ids = record.networks[chainKey].queuedActionIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 128 ||
        !Array.isArray(pending) ||
        ids.length !== pending.length
      )
        throw new Error(
          "execution needs bounded full queued action payloads and exact IDs",
        );
      const seen = new Set();
      for (let index = 0; index < ids.length; index++) {
        const id = integer(ids[index], "action ID", MAX_U64, 1n);
        if (seen.has(id)) throw new Error("duplicate queued action ID");
        seen.add(id);
        const entry = pending[index];
        if (
          !entry ||
          typeof entry !== "object" ||
          entry.executed === true ||
          entry.cancelled === true
        )
          throw new Error("execution requires a pending queued action");
        if (integer(entry.id, "queued payload ID", MAX_U64, 1n) !== id)
          throw new Error("queued payload ID mismatch");
        const queuedAt = integer(entry.queued_at, "queued_at");
        const eta = integer(entry.eta, "eta");
        const expiresAt = integer(entry.expires_at, "expires_at");
        if (
          BigInt(eta) < BigInt(queuedAt) + BigInt(deployment.timelockDelay) ||
          BigInt(expiresAt) !== BigInt(eta) + 604800n
        )
          throw new Error("queued action has inconsistent timelock boundaries");
        const action = validateActivationAction(entry.action);
        if ("SetAdmin" in action && index !== ids.length - 1)
          throw new Error("admin handover must execute last");
        operation("preflight", router, "get_action_payload", {
          id,
          expected: { queued_at: queuedAt, eta, expires_at: expiresAt, action },
        });
        operation(
          "execute",
          router,
          "execute_action",
          { caller, id, action },
          {
            eta,
            expiresAt,
            requiresTimelockMaturity: true,
            requiresProviderLinkVerification: true,
          },
        );
      }
    }
    if (mode === "record") {
      operation("write-record", router, "write_record", { record });
    }
    if (mode === "verify") {
      operation("verify", router, "get_config", {
        expected: {
          admin: deployment.admin,
          guardian: deployment.guardian,
          treasury: deployment.treasury,
          fee_bps: deployment.feeBps,
          flow_window_ledgers: deployment.flowWindow,
          timelock_delay: deployment.timelockDelay,
        },
      });
      operation("verify", router, "get_token", {
        token,
        expected: tokens[0],
      });
      for (const [route, adapter] of [
        [0, cctp],
        [1, axelar],
      ])
        if (adapter) {
          operation("verify", router, "get_adapter", {
            route,
            expected: adapter,
          });
        }
      addReadinessChecks("verify");
    }
  }
  return {
    mode: "dry-run",
    intent: mode,
    signed: false,
    submitted: false,
    network,
    chain: chainKey,
    networkPassphrase: passphrase,
    artifacts: checkedArtifacts,
    providerCodeHashes: checkedProviders,
    operations,
  };

  function addLinks() {
    if (cctp) {
      const domain = integer(
        env.CCTP_PEER_DOMAIN,
        "CCTP_PEER_DOMAIN",
        0xffffffffn,
      );
      operation("link", cctp, "link_domain", {
        chain: peer,
        domain,
        destination_caller: hex(
          env.CCTP_DESTINATION_CALLER,
          "CCTP_DESTINATION_CALLER",
          32,
        ),
      });
      operation("link", cctp, "map_asset", {
        domain,
        burn_token: hex(env.CCTP_PEER_BURN_TOKEN, "CCTP_PEER_BURN_TOKEN", 32),
        local: token,
      });
    }
    if (axelar) {
      const axelarChain = text(env.AXELAR_PEER_CHAIN, "AXELAR_PEER_CHAIN");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(axelarChain))
        throw new Error("AXELAR_PEER_CHAIN is invalid");
      operation("link", axelar, "link_chain", {
        chain: peer,
        axelar_chain: axelarChain,
        peer: hex(env.AXELAR_PEER_ADDRESS, "AXELAR_PEER_ADDRESS", 20),
      });
      operation("link", axelar, "map_token", {
        token,
        token_id: hex(env.AXELAR_TOKEN_ID, "AXELAR_TOKEN_ID", 32),
      });
    }
  }

  function addReadinessChecks(phase) {
    if (cctp) {
      const domain = integer(
        env.CCTP_PEER_DOMAIN,
        "CCTP_PEER_DOMAIN",
        0xffffffffn,
      );
      operation(phase, cctp, "get_config", { expectedRouter: router });
      operation(phase, cctp, "domain_for", { chain: peer, expected: domain });
      operation(phase, cctp, "get_link", {
        domain,
        expectedDestinationCaller: hex(
          env.CCTP_DESTINATION_CALLER,
          "CCTP_DESTINATION_CALLER",
          32,
        ),
      });
      operation(phase, cctp, "is_domain_disabled", { domain, expected: false });
      operation(phase, cctp, "asset_for", {
        domain,
        burn_token: hex(env.CCTP_PEER_BURN_TOKEN, "CCTP_PEER_BURN_TOKEN", 32),
        expected: token,
      });
    }
    if (axelar) {
      operation(phase, axelar, "get_config", { expectedRouter: router });
      operation(phase, axelar, "get_link", {
        chain: peer,
        expectedItsChain: text(env.AXELAR_PEER_CHAIN, "AXELAR_PEER_CHAIN"),
        expectedPeer: hex(env.AXELAR_PEER_ADDRESS, "AXELAR_PEER_ADDRESS", 20),
      });
      operation(phase, axelar, "token_id_for", {
        token,
        expected: hex(env.AXELAR_TOKEN_ID, "AXELAR_TOKEN_ID", 32),
      });
    }
  }
  function validateActivationAction(action) {
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      Object.keys(action).length !== 1
    )
      throw new Error("queued action needs one full canonical payload");
    const [kind, args] = Object.entries(action)[0];
    if (kind === "SetAdmin" || kind === "SetGuardian" || kind === "SetTreasury")
      address(args, kind, "G");
    else if (kind === "RegisterToken") {
      if (!Array.isArray(args) || args.length !== 3)
        throw new Error("invalid token registration payload");
      address(args[0], "token");
      integer(args[1], "decimals", 38n);
      integer(args[2], "flow limit", MAX_I128);
    } else if (kind === "SetAdapter" || kind === "SetRailReceiver") {
      if (!Array.isArray(args) || args.length !== 2)
        throw new Error("invalid adapter payload");
      integer(args[0], "route", 3n);
      address(args[1], "adapter");
    } else if (kind === "EnableRoute") integer(args, "route", 3n);
    else throw new Error("unknown activation action payload");
    return action;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.stdout.write(
      JSON.stringify(await buildUnsignedPlan(process.argv[2]), null, 2) + "\n",
    );
  } catch (error) {
    process.stderr.write(`Unsigned plan refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
