import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CopyCheckError,
  parseArgs,
  parseCopySpec,
  runCheck,
  compareDeployment,
  inspectCanonical,
} from "../check-deployment-copies.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const CLI = path.join(REPO_ROOT, "script/stellar/check-deployment-copies.mjs");
const CANONICAL = path.join(
  REPO_ROOT,
  "deployments/stellar-testnet-phase1.json",
);
const CHAIN = "stellar-testnet";
const DEPLOYMENT_PATH = "deployments/stellar-testnet-phase1.json";

const canonicalRecord = () => JSON.parse(readFileSync(CANONICAL, "utf8"));

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "hyperion-copies-"));
}

function writeRecord(directory, record, name = "copy.json") {
  const file = path.join(directory, name);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/**
 * Capture a file's bytes and modification time through one descriptor, so both observations come
 * from the same file object. Checking the path and then opening it separately would leave a window
 * in which the file could be replaced between the two, which is a TOCTOU pattern CodeQL flags.
 */
function snapshot(file) {
  const descriptor = openSync(file, "r");
  try {
    const { mtimeMs } = fstatSync(descriptor);
    return { bytes: readFileSync(descriptor), mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitRecord(record, name = DEPLOYMENT_PATH) {
  const directory = scratch();
  git(["init", "--quiet"], directory);
  git(["config", "user.name", "Hyperion Test"], directory);
  git(["config", "user.email", "test@hyperion.invalid"], directory);
  const file = path.join(directory, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  git(["add", "."], directory);
  git(["commit", "--quiet", "-m", "deployment copy"], directory);
  return {
    directory,
    revision: git(["rev-parse", "HEAD"], directory).trim(),
  };
}

const VALUE_FLAGS = new Set(["--canonical", "--chain", "--out"]);

/** Bare arguments are copy specifications; flags and their values pass through unchanged. */
function expandArgs(argumentsList) {
  const expanded = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument.startsWith("--")) expanded.push(argument);
    else if (index > 0 && VALUE_FLAGS.has(argumentsList[index - 1]))
      expanded.push(argument);
    else expanded.push("--copy", argument);
  }
  return expanded;
}

function check(...argumentsList) {
  return runCheck(parseArgs(expandArgs(argumentsList)));
}

function gitCopy(label, repo, revision, file = DEPLOYMENT_PATH) {
  return `${label}=git:${repo}:${revision}:${file}`;
}

function fileCopy(label, file) {
  return `${label}=file:${file}`;
}

test("identical copies at an explicit commit agree and report the resolved revision", () => {
  const origin = commitRecord(canonicalRecord());
  const report = check(gitCopy("stellarhyperion-frontend", origin.directory, origin.revision));

  assert.equal(report.consistent, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.findings, []);
  assert.equal(report.readOnly, true);
  assert.equal(report.wroteConsumerCopies, false);
  assert.equal(report.copies[0].revision, origin.revision);
  assert.equal(report.copies[0].requestedRevision, `git:${origin.revision}`);
  assert.equal(report.copies[0].compared, true);
  assert.match(report.copies[0].sha256, /^[0-9a-f]{64}$/);
});

test("mismatches name the exact field path and the owning repository", () => {
  const frontend = canonicalRecord();
  frontend.networks[CHAIN].tokens.USDC.flowLimit = "9999999999999";
  frontend.networks[CHAIN].activation.acceptance = "pending";

  const backend = canonicalRecord();
  backend.networks[CHAIN].router =
    "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF";

  const frontendRepo = commitRecord(frontend);
  const backendRepo = commitRecord(backend);
  const report = check(
    gitCopy("stellarhyperion-frontend", frontendRepo.directory, frontendRepo.revision),
    gitCopy("stellarhyperion-backend", backendRepo.directory, backendRepo.revision),
  );

  assert.equal(report.exitCode, 1);
  const byField = new Map(
    report.findings.map((finding) => [
      `${finding.field}|${finding.owningRepositories.join(",")}`,
      finding,
    ]),
  );
  const flow = byField.get(
    `networks.${CHAIN}.tokens.USDC.flowLimit|stellarhyperion-frontend`,
  );
  assert.equal(flow.kind, "integer");
  assert.equal(flow.expected, "10000000000000");
  assert.equal(flow.found, "9999999999999");
  assert.equal(flow.severity, "critical");

  const acceptance = byField.get(
    `networks.${CHAIN}.activation.acceptance|stellarhyperion-frontend`,
  );
  assert.equal(acceptance.kind, "value");
  assert.equal(acceptance.found, "pending");

  const router = byField.get(
    `networks.${CHAIN}.router|stellarhyperion-backend`,
  );
  assert.equal(router.kind, "value");
  assert.equal(router.found, "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF");
  assert.equal(report.counts.critical, report.findings.length);
});

test("exact integers never pass through floating point", () => {
  const exact = canonicalRecord();
  exact.networks[CHAIN].tokens.USDC.flowLimit = "123456789012345678901234";
  const directory = scratch();
  const canonicalFile = writeRecord(directory, exact, "canonical.json");
  const same = writeRecord(directory, exact, "same.json");
  const agree = check(
    fileCopy("stellarhyperion-backend", same),
    "--allow-working-tree",
    "--canonical",
    canonicalFile,
  );
  assert.equal(agree.consistent, true);

  const drifted = JSON.parse(JSON.stringify(exact));
  drifted.networks[CHAIN].tokens.USDC.flowLimit = "123456789012345678901235";
  const driftedFile = writeRecord(directory, drifted, "drifted.json");
  const disagree = check(
    fileCopy("stellarhyperion-backend", driftedFile),
    "--allow-working-tree",
    "--canonical",
    canonicalFile,
  );
  assert.equal(disagree.exitCode, 1);
  assert.equal(disagree.findings[0].kind, "integer");
  assert.equal(disagree.findings[0].found, "123456789012345678901235");

  // JSON.parse of a 24-digit integer produces an imprecise Number; that must be a finding, not
  // a comparison against a rounded value.
  const unsafe = JSON.parse(
    `{"networks":{"${CHAIN}":{"tokens":{"USDC":{"flowLimit":123456789012345678901234}}}}}`,
  );
  const unsafeFindings = compareDeployment(
    `networks.${CHAIN}`,
    exact.networks[CHAIN],
    unsafe.networks[CHAIN],
    "stellarhyperion-frontend",
  );
  assert.ok(
    unsafeFindings.some((finding) => finding.kind === "unsafe-integer"),
  );
});

test("an archived copy is reported as archived, not as a field diff", () => {
  const archived = canonicalRecord();
  archived.networks[CHAIN].activation.status = "archived";
  archived.networks[CHAIN].successorRouter =
    "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
  const archivedRepo = commitRecord(archived);
  const report = check(
    gitCopy("stellarhyperion-frontend", archivedRepo.directory, archivedRepo.revision),
  );

  assert.equal(report.exitCode, 1);
  assert.equal(report.copies[0].compared, false);
  assert.equal(report.copies[0].lifecycle.archived, true);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, "archived-copy");
  assert.equal(report.findings[0].field, `networks.${CHAIN}.status`);
  assert.equal(report.findings[0].successor, archived.networks[CHAIN].successorRouter);
});

test("an archived canonical record is refused unless explicitly historical", () => {
  const directory = scratch();
  const archived = canonicalRecord();
  archived.status = "archived";
  archived.successorRouter =
    "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
  const file = writeRecord(directory, archived, "archived.json");
  const copy = writeRecord(directory, canonicalRecord(), "active.json");

  assert.throws(
    () => check(fileCopy("stellarhyperion-backend", copy), "--allow-working-tree", "--canonical", file),
    (error) => error instanceof CopyCheckError && /archived/.test(error.message),
  );

  const report = check(
    fileCopy("stellarhyperion-backend", copy),
    "--allow-working-tree",
    "--canonical",
    file,
    "--allow-archived",
  );
  assert.equal(report.canonical.lifecycle.archived, true);
  assert.equal(report.findings[0].kind, "active-copy");
  assert.equal(report.exitCode, 1);
});

test("EVM families and unvalidated rails stay gated", () => {
  const directory = scratch();
  const evm = canonicalRecord();
  evm.networks[CHAIN].family = "evm";
  const evmFile = writeRecord(directory, evm, "evm.json");
  const copy = writeRecord(directory, canonicalRecord(), "copy.json");
  assert.throws(
    () => check(fileCopy("frontend", copy), "--allow-working-tree", "--canonical", evmFile),
    /stays gated/,
  );

  const gated = canonicalRecord();
  gated.networks[CHAIN].adapters.allbridge =
    "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF";
  const gatedFile = writeRecord(directory, gated, "gated.json");
  const report = check(
    fileCopy("frontend", gatedFile),
    "--allow-working-tree",
    "--canonical",
    gatedFile,
  );
  const rail = report.findings.find((finding) => finding.kind === "gated-rail");
  assert.equal(rail.field, `networks.${CHAIN}.adapters.allbridge`);
  assert.deepEqual(rail.owningRepositories, ["stellarhyperion-contracts"]);
});

test("missing and unexpected fields are named, and extras are notices", () => {
  const copy = canonicalRecord();
  delete copy.networks[CHAIN].peerChain;
  copy.networks[CHAIN].frontendOnly = { note: "consumer metadata" };
  const directory = scratch();
  const file = writeRecord(directory, copy);
  const report = check(fileCopy("frontend", file), "--allow-working-tree");

  const missing = report.findings.find((finding) => finding.kind === "missing");
  assert.equal(missing.field, `networks.${CHAIN}.peerChain`);
  assert.equal(missing.severity, "critical");

  const extra = report.findings.find((finding) => finding.kind === "unexpected");
  assert.equal(extra.field, `networks.${CHAIN}.frontendOnly`);
  assert.equal(extra.severity, "notice");
  assert.equal(report.exitCode, 1);
});

test("the command never rewrites a consumer copy", () => {
  const directory = scratch();
  const file = writeRecord(directory, canonicalRecord());
  const before = snapshot(file);

  const report = check(fileCopy("frontend", file), "--allow-working-tree");
  assert.equal(report.consistent, true);
  const after = snapshot(file);
  assert.deepEqual(after.bytes, before.bytes);
  assert.equal(after.mtimeMs, before.mtimeMs);

  assert.throws(
    () => check(fileCopy("frontend", file), "--allow-working-tree", "--out", file),
    /never rewrites a consumer/,
  );
  assert.deepEqual(snapshot(file).bytes, before.bytes);
});

test("copy revisions must be full, exact and locally available", () => {
  const origin = commitRecord(canonicalRecord());
  for (const specification of [
    `frontend=git:${origin.directory}:${origin.revision.slice(0, 12)}:${DEPLOYMENT_PATH}`,
    `frontend=git:${origin.directory}:${"0".repeat(40)}:${DEPLOYMENT_PATH}`,
    `frontend=git:${origin.directory}:${origin.revision}:../deployment.json`,
    `frontend=git:${origin.directory}:${origin.revision}:missing.json`,
  ]) {
    assert.throws(
      () => check(specification),
      (error) => error instanceof CopyCheckError,
      specification,
    );
  }
  assert.throws(
    () => check(fileCopy("frontend", path.join(origin.directory, DEPLOYMENT_PATH))),
    /allow-working-tree/,
  );
});

test("a copy describing another network is refused, not compared", () => {
  const other = canonicalRecord();
  other.networks = { "stellar-mainnet": other.networks[CHAIN] };
  const directory = scratch();
  const file = writeRecord(directory, other);
  assert.throws(
    () => check(fileCopy("frontend", file), "--allow-working-tree"),
    /no network stellar-testnet/,
  );
});

test("canonical invariants are reported against the contracts repository", () => {
  const broken = canonicalRecord();
  broken.networks[CHAIN].tokens.USDC.routes.push("allbridge");
  broken.networks[CHAIN].feeBps = 101;
  broken.networks[CHAIN].router = "not-a-contract";
  const findings = inspectCanonical(
    `networks.${CHAIN}`,
    broken.networks[CHAIN],
  );
  for (const finding of findings)
    assert.deepEqual(finding.owningRepositories, ["stellarhyperion-contracts"]);
  assert.ok(findings.some((finding) => finding.kind === "unbacked-route"));
  assert.ok(findings.some((finding) => finding.kind === "invalid-canonical"));
  assert.ok(
    findings.some((finding) => finding.field === `networks.${CHAIN}.router`),
  );
});

test("copy specification parsing rejects ambiguous forms", () => {
  assert.deepEqual(parseCopySpec("frontend=file:/tmp/a.json"), {
    label: "frontend",
    source: "file",
    path: "/tmp/a.json",
  });
  assert.equal(
    parseCopySpec(`frontend=git:../repo:${"a".repeat(40)}:${DEPLOYMENT_PATH}`)
      .revision,
    "a".repeat(40),
  );
  for (const bad of ["frontend", "Front End=file:/tmp/a.json", "frontend=file:"])
    assert.throws(() => parseCopySpec(bad), CopyCheckError);
});

function cli(argumentsList) {
  return execFileSync(process.execPath, [CLI, ...expandArgs(argumentsList)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("the CLI prints JSON, exits 0 on agreement and 1 on drift", () => {
  const origin = commitRecord(canonicalRecord());
  const output = JSON.parse(
    cli([gitCopy("stellarhyperion-frontend", origin.directory, origin.revision)]),
  );
  assert.equal(output.consistent, true);

  const drift = canonicalRecord();
  drift.networks[CHAIN].treasury =
    "GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI";
  const driftedRepo = commitRecord(drift);
  let failure;
  try {
    cli([
      gitCopy(
        "stellarhyperion-backend",
        driftedRepo.directory,
        driftedRepo.revision,
      ),
    ]);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.status, 1);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.findings[0].field, `networks.${CHAIN}.treasury`);
  assert.ok(!/deployment-copies:/.test(failure.stderr));
});

test("the CLI refuses a run with no copies rather than reporting a vacuous pass", () => {
  let failure;
  try {
    cli(["--canonical", CANONICAL]);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /at least one --copy/);
});
