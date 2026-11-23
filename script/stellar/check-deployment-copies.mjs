#!/usr/bin/env node
/**
 * Compare the canonical Stellar deployment record with the backend and frontend copies at
 * explicit revisions, and name every disagreement by field path and owning repository.
 *
 * Read only. Nothing here signs, submits, or writes a consumer copy: every input is opened
 * read-only (or read out of a local Git object with `git show`), and the only optional write is a
 * report file that is refused if it resolves to one of the copies being compared. Updating a copy
 * is a separate, reviewed operation in that repository.
 *
 * Why this exists: three repositories carry the same deployment data, and the expensive failures
 * are silent. A backend copy with a stale flow limit answers quotes from a different budget; a
 * frontend copy with a retired router sends a user's signature at a contract the organization no
 * longer monitors. `parseDeploymentSet` proves a single record is well formed, and verify.sh
 * proves the chain still matches it. Neither answers "do all three repositories agree, at the
 * commits they are actually deployed from".
 *
 * Inputs
 *   --canonical PATH                 canonical record (default deployments/stellar-testnet-phase1.json)
 *   --copy LABEL=git:REPO:COMMIT:PATH  a consumer copy at an exact, locally available commit
 *   --copy LABEL=file:PATH             a working-tree copy; needs --allow-working-tree
 *   --chain KEY                      network key, required only when the record has several
 *   --allow-archived                 compare an archived canonical record as historical evidence
 *   --allow-working-tree             permit file: copies (reported as not reproducible)
 *   --out PATH                       write the JSON report here instead of stdout
 *
 * Exit codes: 0 consistent, 1 mismatches or archive findings, 2 usage/input refusal.
 *
 * Integer amounts (flow limits, fees, decimals, window lengths, timelocks) are compared as exact
 * decimal integers, never through floating point. Stellar identifiers compare case-sensitively;
 * EVM addresses compare semantically. Archived records are reported as archived rather than as a
 * pile of field differences against the active manifest. EVM and other rail deployment copies stay
 * gated until that side has been independently validated.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_RECORD_BYTES } from "./record-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_CANONICAL = path.join(
  REPO_ROOT,
  "deployments/stellar-testnet-phase1.json",
);

/** The repository that owns the canonical record, and therefore a canonical-side inconsistency. */
export const CANONICAL_REPOSITORY = "stellarhyperion-contracts";

/** Routes the active Stellar Testnet deployment is allowed to carry. */
export const ACTIVE_RAILS = Object.freeze(["cctp", "axelar-its"]);

/**
 * Fields whose whole meaning is an exact integer. A copy that writes 30 as "30" still agrees; a
 * copy that rounds 10000000000000 to 1e13 does not, and must not be reported as agreement.
 */
export const INTEGER_FIELDS = Object.freeze(
  new Set([
    "schemaVersion",
    "decimals",
    "feeBps",
    "flowWindow",
    "timelockDelay",
    "flowLimit",
    "maxSingleTransfer",
    "ledger",
  ]),
);

const STELLAR_ADDRESS = /^[CG][A-Z2-7]{55}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const COMMIT = /^[a-f0-9]{40}$/;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

export class CopyCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "CopyCheckError";
  }
}

function refuse(message) {
  throw new CopyCheckError(message);
}

const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Bounded, symlink-refusing UTF-8 read. The same rule write-record.mjs applies to records. */
function readBounded(file) {
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse(`${file} is not a regular file`);
    if (stat.size > MAX_RECORD_BYTES)
      refuse(`${file} exceeds the ${MAX_RECORD_BYTES}-byte record limit`);
    const chunks = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(16384, MAX_RECORD_BYTES + 1 - length));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      length += count;
      if (length > MAX_RECORD_BYTES)
        refuse(`${file} exceeds the ${MAX_RECORD_BYTES}-byte record limit`);
      chunks.push(buffer.subarray(0, count));
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    refuse(`${source} is not valid JSON: ${error.message}`);
  }
}

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Find the deployment object inside a record. Real copies are the full record, but a consumer may
 * wrap it, so a bare deployment and a `deployment` wrapper are accepted too.
 */
export function locateDeployment(document, chainKey, source = "record") {
  if (!plain(document)) refuse(`${source} must be a JSON object`);

  const networks = plain(document.networks)
    ? document.networks
    : plain(document.record?.networks)
      ? document.record.networks
      : undefined;
  if (networks) {
    const keys = Object.keys(networks);
    if (!keys.length) refuse(`${source} has an empty networks object`);
    let key = chainKey;
    if (key === undefined) {
      if (keys.length !== 1)
        refuse(
          `${source} names ${keys.length} networks (${keys.join(", ")}); pass --chain`,
        );
      key = keys[0];
    }
    if (!keys.includes(key))
      refuse(`${source} has no network ${key}; it names ${keys.join(", ")}`);
    if (!plain(networks[key]))
      refuse(`${source} network ${key} is not an object`);
    return {
      chainKey: key,
      deployment: networks[key],
      prefix: `networks.${key}`,
    };
  }

  if (plain(document.deployment)) {
    return {
      chainKey: chainKey ?? "deployment",
      deployment: document.deployment,
      prefix: "deployment",
    };
  }
  if (document.family !== undefined || document.router !== undefined) {
    return {
      chainKey: chainKey ?? "deployment",
      deployment: document,
      prefix: "",
    };
  }
  refuse(
    `${source} contains no deployment: expected networks.<chain>, a deployment wrapper, or a deployment object`,
  );
}

/**
 * Lifecycle of one record, covering the shapes the writers actually emit: `lifecycle.status`,
 * a top-level `status` (write-record.mjs), and the checked-in `activation.status`. A file read
 * out of an archive path is archival even when the metadata predates the status convention.
 */
export function lifecycleOf(deployment, source = "", root = {}) {
  const lifecycle = plain(deployment?.lifecycle)
    ? deployment.lifecycle
    : plain(root.lifecycle)
      ? root.lifecycle
      : {};
  const declared = String(
    lifecycle.status ??
      deployment?.status ??
      root.status ??
      deployment?.activation?.status ??
      "active",
  )
    .trim()
    .toLowerCase();
  const retired =
    ["archived", "deprecated", "retired"].includes(declared) ||
    deployment?.archived === true ||
    deployment?.deprecated === true ||
    root.archived === true ||
    root.deprecated === true ||
    /(^|[/\\])archive[/\\]/.test(source);
  return {
    status: retired && declared === "active" ? "archived" : declared,
    archived: retired,
    successor: String(
      lifecycle.successor ??
        lifecycle.successorRecord ??
        deployment?.successorRouter ??
        deployment?.successor ??
        root.successor ??
        root.successorRecord ??
        "",
    ),
    reason: String(lifecycle.reason ?? deployment?.reason ?? root.reason ?? ""),
  };
}

function integerOf(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { ok: false, unsafe: true };
    return { ok: true, value: BigInt(value) };
  }
  if (typeof value === "string" && /^-?\d+$/.test(value))
    return { ok: true, value: BigInt(value) };
  return { ok: false, unsafe: false };
}

const show = (value) =>
  typeof value === "string" ? value : JSON.stringify(value);

function leafField(field) {
  return field.split(".").pop().replace(/\[\d+\]$/, "");
}

function sameAddress(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    EVM_ADDRESS.test(left) &&
    EVM_ADDRESS.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function join(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

/**
 * Recursive comparison of one deployment object. Findings carry the exact dotted field path, the
 * owning repository, and the two values as they appeared, so a reviewer can point at a line.
 */
export function compareDeployment(prefix, canonical, copyValue, repository) {
  const findings = [];
  const emit = (field, kind, expected, found, detail) =>
    findings.push({
      field,
      owningRepositories: [repository],
      kind,
      severity: kind === "unexpected" ? "notice" : "critical",
      expected: expected === undefined ? null : expected,
      found: found === undefined ? null : found,
      ...(detail ? { detail } : {}),
    });

  const walk = (field, want, got) => {
    if (Array.isArray(want) || Array.isArray(got)) {
      if (!Array.isArray(want) || !Array.isArray(got)) {
        emit(field, "type", want, got);
        return;
      }
      // Route lists are sets on the wire: order carries no meaning, membership does.
      if (leafField(field) === "routes") {
        const wanted = want.map(String).slice().sort();
        const actual = got.map(String).slice().sort();
        if (wanted.join("\u0000") !== actual.join("\u0000"))
          emit(field, "route-set", want, got);
        return;
      }
      if (want.length !== got.length)
        emit(field, "length", want.length, got.length);
      for (let index = 0; index < Math.min(want.length, got.length); index += 1)
        walk(`${field}[${index}]`, want[index], got[index]);
      return;
    }

    const wantObject = plain(want);
    const gotObject = plain(got);
    if (wantObject || gotObject) {
      if (!wantObject || !gotObject) {
        emit(field, "type", want, got);
        return;
      }
      const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])];
      for (const key of keys) {
        const child = join(field, key);
        const inCanonical = Object.hasOwn(want, key);
        const inCopy = Object.hasOwn(got, key);
        if (!inCanonical) {
          // generatedAt moves whenever a record is regenerated and is not deployment data.
          if (child === "generatedAt") continue;
          emit(child, "unexpected", undefined, got[key]);
        } else if (!inCopy) emit(child, "missing", want[key], undefined);
        else walk(child, want[key], got[key]);
      }
      return;
    }

    const leaf = leafField(field);
    if (INTEGER_FIELDS.has(leaf)) {
      const wanted = integerOf(want);
      const actual = integerOf(got);
      if (!wanted.ok) {
        emit(field, "invalid-canonical-integer", want, got);
        return;
      }
      if (!actual.ok) {
        emit(
          field,
          actual.unsafe ? "unsafe-integer" : "integer",
          show(want),
          show(got),
          actual.unsafe
            ? "the copy carries this amount as a number outside the exact integer range"
            : "the copy does not carry an exact integer here",
        );
        return;
      }
      if (wanted.value !== actual.value)
        emit(field, "integer", show(want), show(got));
      return;
    }

    if (sameAddress(want, got)) return;
    if (want === got) return;
    emit(field, "value", want, got);
  };

  walk(prefix, canonical, copyValue);
  return findings;
}

/**
 * Canonical-side invariants. A canonical record that admits a gated rail, references an adapter it
 * does not deploy, or carries an unrepresentable amount is a contracts-repository problem, not a
 * consumer's, and is reported against that repository.
 */
export function inspectCanonical(prefix, deployment) {
  const findings = [];
  const add = (field, kind, expected, found, detail) =>
    findings.push({
      field,
      owningRepositories: [CANONICAL_REPOSITORY],
      kind,
      severity: "critical",
      expected: expected === undefined ? null : expected,
      found: found === undefined ? null : found,
      ...(detail ? { detail } : {}),
    });

  if (deployment.family !== "stellar")
    add(
      join(prefix, "family"),
      "gated-family",
      "stellar",
      deployment.family,
      "EVM and other rail deployment copies stay gated until independently validated",
    );

  for (const role of ["router", "admin", "guardian", "treasury"]) {
    const value = String(deployment[role] ?? "");
    if (!STELLAR_ADDRESS.test(value))
      add(
        join(prefix, role),
        "invalid-canonical",
        "a Stellar account or contract id",
        deployment[role] ?? null,
      );
  }

  const adapters = plain(deployment.adapters) ? deployment.adapters : {};
  for (const slug of Object.keys(adapters)) {
    if (!ACTIVE_RAILS.includes(slug))
      add(
        join(prefix, `adapters.${slug}`),
        "gated-rail",
        ACTIVE_RAILS.join(" or "),
        slug,
        "this rail is outside the active Stellar Testnet deployment and must stay gated",
      );
  }

  const tokens = plain(deployment.tokens) ? deployment.tokens : {};
  if (!Object.keys(tokens).length)
    add(join(prefix, "tokens"), "invalid-canonical", "at least one token", null);

  for (const [symbol, token] of Object.entries(tokens)) {
    if (!plain(token)) {
      add(join(prefix, `tokens.${symbol}`), "invalid-canonical", "object", token);
      continue;
    }
    for (const slug of token.routes ?? []) {
      if (!Object.hasOwn(adapters, slug))
        add(
          join(prefix, `tokens.${symbol}.routes`),
          "unbacked-route",
          ACTIVE_RAILS.join(" or "),
          slug,
          "the token advertises a route whose adapter is not in the record",
        );
    }
    for (const field of ["decimals", "flowLimit"]) {
      if (!integerOf(token[field]).ok)
        add(
          join(prefix, `tokens.${symbol}.${field}`),
          "invalid-canonical-integer",
          "an exact integer",
          token[field] ?? null,
        );
    }
  }

  const bounded = [
    ["feeBps", 0n, 100n],
    ["flowWindow", 1n, (1n << 32n) - 1n],
    ["timelockDelay", 1n, (1n << 32n) - 1n],
  ];
  for (const [field, minimum, maximum] of bounded) {
    const value = integerOf(deployment[field]);
    if (!value.ok)
      add(
        join(prefix, field),
        "invalid-canonical-integer",
        "an exact integer",
        deployment[field] ?? null,
      );
    else if (value.value < minimum || value.value > maximum)
      add(
        join(prefix, field),
        "invalid-canonical",
        `${minimum}..${maximum}`,
        String(value.value),
      );
  }

  if (!/^[0-9a-f]{64}$/i.test(String(deployment.wasmHashes?.router ?? "")))
    add(
      join(prefix, "wasmHashes.router"),
      "invalid-canonical",
      "a 64-character hex digest",
      deployment.wasmHashes?.router ?? null,
    );

  return findings;
}

function gitText(repoDirectory, args) {
  return execFileSync("git", ["-C", repoDirectory, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: MAX_RECORD_BYTES * 4,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolve one explicit copy revision and read its bytes without touching a working tree. */
export function readGitCopy(spec) {
  if (!COMMIT.test(spec.revision))
    refuse(
      `${spec.label}: a copy revision must be a full 40-character commit SHA, got "${spec.revision}"`,
    );
  if (
    !spec.path ||
    spec.path.startsWith("/") ||
    spec.path.split("/").includes("..") ||
    !REPO_PATH.test(spec.path)
  )
    refuse(`${spec.label}: copy path must be a plain path inside the repository`);
  let directory;
  try {
    directory = realpathSync(spec.repoDirectory);
  } catch {
    refuse(`${spec.label}: no repository directory at ${spec.repoDirectory}`);
  }
  if (!statSync(directory).isDirectory())
    refuse(`${spec.label}: ${directory} is not a directory`);

  let resolved;
  try {
    resolved = gitText(directory, [
      "rev-parse",
      "--verify",
      `${spec.revision}^{commit}`,
    ]).trim();
  } catch {
    refuse(
      `${spec.label}: commit ${spec.revision} is not available in ${directory}; fetch it first`,
    );
  }
  if (resolved !== spec.revision)
    refuse(`${spec.label}: revision resolved to ${resolved}, not the requested commit`);

  let text;
  try {
    text = gitText(directory, ["show", `${resolved}:${spec.path}`]);
  } catch {
    refuse(`${spec.label}: ${spec.path} does not exist at ${spec.revision}`);
  }
  return { text, revision: resolved, path: spec.path, source: "git" };
}

export function parseCopySpec(spec) {
  const git =
    /^([a-z0-9][a-z0-9._-]{0,63})=git:(.+):([a-f0-9]{40}):([^:]+)$/.exec(spec);
  if (git)
    return {
      label: git[1],
      source: "git",
      repoDirectory: git[2],
      revision: git[3],
      path: git[4],
    };
  const file = /^([a-z0-9][a-z0-9._-]{0,63})=file:(.+)$/.exec(spec);
  if (file)
    return { label: file[1], source: "file", path: path.resolve(file[2]) };
  refuse(
    `copy "${spec}" must read LABEL=git:REPO:COMMIT:PATH or LABEL=file:PATH`,
  );
}

export function parseArgs(argv) {
  const options = {
    canonical: DEFAULT_CANONICAL,
    copies: [],
    chain: undefined,
    allowArchived: false,
    allowWorkingTree: false,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = (name) => {
      const next = argv[(index += 1)];
      if (next === undefined) refuse(`${name} requires a value`);
      return next;
    };
    if (argument === "--canonical") options.canonical = value(argument);
    else if (argument.startsWith("--canonical="))
      options.canonical = argument.slice("--canonical=".length);
    else if (argument === "--copy") options.copies.push(value(argument));
    else if (argument.startsWith("--copy="))
      options.copies.push(argument.slice("--copy=".length));
    else if (argument === "--chain") options.chain = value(argument);
    else if (argument.startsWith("--chain="))
      options.chain = argument.slice("--chain=".length);
    else if (argument === "--out") options.out = value(argument);
    else if (argument.startsWith("--out="))
      options.out = argument.slice("--out=".length);
    else if (argument === "--allow-archived") options.allowArchived = true;
    else if (argument === "--allow-working-tree") options.allowWorkingTree = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else refuse(`unknown argument ${argument}`);
  }
  if (!options.copies.length && !options.help)
    refuse(
      "at least one --copy LABEL=git:REPO:COMMIT:PATH is required; comparing nothing is not a pass",
    );
  if (options.chain !== undefined && !LABEL.test(options.chain))
    refuse(`--chain must be a network key such as stellar-testnet`);
  const seen = new Set();
  for (const label of options.copies.map((spec) => parseCopySpec(spec).label)) {
    if (seen.has(label)) refuse(`duplicate copy label ${label}`);
    seen.add(label);
  }
  return options;
}

function normalizeCopy(copy) {
  return {
    label: copy.label,
    source: copy.source,
    requestedRevision:
      copy.source === "git" ? `git:${copy.revision}` : "working-tree",
    revision: copy.revision ?? null,
    path: copy.path,
    text: copy.text,
  };
}

/**
 * Pure-ish entry point: loads the record and the copies, and returns the report plus its exit code.
 * Kept separate from main so tests can exercise the whole comparison without spawning a process.
 */
export function runCheck(options, dependencies = {}) {
  const gitReader = dependencies.readGitCopy ?? readGitCopy;
  const fileReader = dependencies.readBounded ?? readBounded;

  const canonicalText = fileReader(path.resolve(options.canonical));
  const canonicalDocument = parseJson(canonicalText, options.canonical);
  const canonicalLocated = locateDeployment(
    canonicalDocument,
    options.chain,
    options.canonical,
  );
  const canonicalLifecycle = lifecycleOf(
    canonicalLocated.deployment,
    options.canonical,
    canonicalDocument,
  );

  if (canonicalLocated.deployment.family !== "stellar")
    refuse(
      `canonical family is ${String(canonicalLocated.deployment.family)}; EVM and other rail deployment copy comparison stays gated until independently validated`,
    );
  if (canonicalLifecycle.archived && !options.allowArchived)
    refuse(
      `the canonical record is ${canonicalLifecycle.status}, not the active manifest; pass --allow-archived only for a historical comparison`,
    );

  const copies = [];
  for (const raw of options.copies) {
    const spec = parseCopySpec(raw);
    if (spec.source === "file" && !options.allowWorkingTree)
      refuse(
        `${spec.label}: file: copies are working-tree data, not an explicit revision; pass --allow-working-tree for a local rehearsal`,
      );
    const loaded =
      spec.source === "git"
        ? gitReader(spec)
        : { text: fileReader(spec.path), revision: null, path: spec.path, source: "file" };
    copies.push(normalizeCopy({ ...spec, ...loaded }));
  }

  const findings = [];
  findings.push(
    ...inspectCanonical(canonicalLocated.prefix, canonicalLocated.deployment),
  );

  const summaryCopies = [];
  for (const copy of copies) {
    const copyDocument = parseJson(copy.text, `${copy.label} copy`);
    const located = locateDeployment(
      copyDocument,
      canonicalLocated.chainKey,
      `${copy.label} copy`,
    );
    if (located.chainKey !== canonicalLocated.chainKey)
      refuse(
        `${copy.label} describes ${located.chainKey}, but the canonical record is ${canonicalLocated.chainKey}`,
      );
    const lifecycle = lifecycleOf(located.deployment, copy.path, copyDocument);
    summaryCopies.push({
      repository: copy.label,
      source: copy.source,
      requestedRevision: copy.requestedRevision,
      revision: copy.revision,
      path: copy.path,
      chainKey: located.chainKey,
      sha256: digest(copy.text),
      lifecycle,
      compared: false,
    });
    const summary = summaryCopies[summaryCopies.length - 1];

    if (lifecycle.archived !== canonicalLifecycle.archived) {
      findings.push({
        field: join(located.prefix, "status"),
        owningRepositories: [copy.label],
        kind: lifecycle.archived ? "archived-copy" : "active-copy",
        severity: "critical",
        expected: canonicalLifecycle.status,
        found: lifecycle.status,
        successor: lifecycle.successor || null,
        detail: lifecycle.archived
          ? "this copy is archived and must not serve the active manifest; use its successor record"
          : "the canonical record is archived but this copy still presents itself as active",
      });
      continue;
    }

    summary.compared = true;
    findings.push(
      ...compareDeployment(
        located.prefix,
        canonicalLocated.deployment,
        located.deployment,
        copy.label,
      ),
    );
  }

  findings.sort((left, right) =>
    `${left.field}\u0000${left.owningRepositories.join(",")}\u0000${left.kind}`.localeCompare(
      `${right.field}\u0000${right.owningRepositories.join(",")}\u0000${right.kind}`,
    ),
  );

  // A report may be written, but never over a consumer copy this run just read.
  if (options.out) {
    const target = path.resolve(options.out);
    const copyPaths = new Set(
      options.copies
        .map((raw) => parseCopySpec(raw))
        .filter((spec) => spec.source === "file")
        .map((spec) => path.resolve(spec.path)),
    );
    if (copyPaths.has(target))
      refuse(
        `--out ${options.out} is one of the compared copies; this command never rewrites a consumer`,
      );
  }

  const report = {
    schemaVersion: 1,
    tool: "check-deployment-copies",
    readOnly: true,
    signed: false,
    submitted: false,
    wroteConsumerCopies: false,
    canonical: {
      repository: CANONICAL_REPOSITORY,
      path: path.resolve(options.canonical),
      chainKey: canonicalLocated.chainKey,
      router: canonicalLocated.deployment.router ?? null,
      sha256: digest(canonicalText),
      lifecycle: canonicalLifecycle,
    },
    copies: summaryCopies,
    findings,
    counts: {
      critical: findings.filter((finding) => finding.severity === "critical")
        .length,
      notices: findings.filter((finding) => finding.severity === "notice").length,
      copiesCompared: summaryCopies.filter((copy) => copy.compared).length,
    },
    consistent: findings.every((finding) => finding.severity === "notice"),
  };
  report.exitCode = report.consistent ? 0 : 1;
  return report;
}

const USAGE = `Usage: script/stellar/check-deployment-copies.sh \\
  --copy stellarhyperion-backend=git:../stellarhyperion-backend:COMMIT:PATH \\
  --copy stellarhyperion-frontend=git:../stellarhyperion-frontend:COMMIT:PATH \\
  [--canonical deployments/stellar-testnet-phase1.json] [--chain stellar-testnet] \\
  [--allow-archived] [--allow-working-tree] [--out report.json]

Read-only: compares the canonical deployment record with consumer copies at explicit revisions.
Prints JSON and exits 0 when they agree, 1 when any field disagrees, 2 on a usage or input refusal.
`;

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const report = runCheck(options);

  if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.consistent) {
    const pinned = report.copies.filter((copy) => copy.source === "git").length;
    process.stderr.write(
      `deployment copies agree (${report.counts.copiesCompared} compared; ${pinned} at explicit commits, ${report.copies.length - pinned} working-tree)\n`,
    );
  }
  else
    process.stderr.write(
      `${report.counts.critical} mismatch(es) across ${report.copies.length} copy(ies); nothing was written\n`,
    );
  return report.exitCode;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof CopyCheckError) {
      process.stderr.write(`check-deployment-copies: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
