/**
 * ABI, tuple and event compatibility for off-chain consumers.
 *
 * The deployed Stellar ITS/CCTP flow is the compatibility baseline. EVM and other rail surfaces
 * remain gated; this report is a development tool, not activation evidence.
 */

export interface AbiInput {
  readonly name?: string;
  readonly type: string;
  readonly indexed?: boolean;
  readonly components?: readonly AbiInput[];
}
export interface AbiEntry {
  readonly type: "function" | "event" | "error" | "constructor" | "fallback" | "receive";
  readonly name?: string;
  readonly inputs?: readonly AbiInput[];
  readonly outputs?: readonly AbiInput[];
  readonly stateMutability?: string;
}
export interface AbiCompatibilityDecision {
  readonly classification: "compatible" | "breaking";
  readonly rule:
    | "entry-added"
    | "entry-removed"
    | "input-added"
    | "input-removed"
    | "input-reordered"
    | "input-type-changed"
    | "output-added"
    | "output-removed"
    | "output-reordered"
    | "output-type-changed"
    | "state-mutability-changed"
    | "event-indexed-changed"
    | "tuple-field-added"
    | "tuple-field-removed"
    | "tuple-field-reordered"
    | "tuple-field-type-changed";
  readonly path: string;
  readonly previous: string | null;
  readonly proposed: string | null;
  readonly detail: string;
}
export interface AbiCompatibilityReport {
  readonly reportVersion: 1;
  readonly result: "identical" | "compatible" | "breaking";
  readonly breaking: number;
  readonly compatible: number;
  readonly decisions: readonly AbiCompatibilityDecision[];
}

const canonical = (value: unknown): string => JSON.stringify(value);
const array = (v: readonly unknown[] | undefined): readonly unknown[] => v ?? [];

export function abiType(input: AbiInput): string {
  if (input.type === "tuple" || input.type.startsWith("tuple")) {
    const suffix = input.type.slice("tuple".length);
    return `(${array(input.components)
      .map((component) => abiType(component as AbiInput))
      .join(",")})${suffix}`;
  }
  return input.type;
}

export function abiSignature(entry: AbiEntry): string {
  if (entry.type === "constructor") return "constructor()";
  if (entry.type === "receive" || entry.type === "fallback") return entry.type;
  const name = entry.name ?? entry.type;
  return `${name}(${array(entry.inputs)
    .map((input) => abiType(input as AbiInput))
    .join(",")})`;
}

function key(entry: AbiEntry): string {
  return entry.type === "event" || entry.type === "function" || entry.type === "error"
    ? `${entry.type}:${abiSignature(entry)}`
    : `${entry.type}:${abiSignature(entry)}`;
}

function listDecisions(
  previous: readonly AbiEntry[],
  proposed: readonly AbiEntry[],
): AbiCompatibilityDecision[] {
  const out: AbiCompatibilityDecision[] = [];
  const prev = new Map(previous.map((entry) => [key(entry), entry]));
  const next = new Map(proposed.map((entry) => [key(entry), entry]));

  for (const entry of previous) {
    const k = key(entry);
    if (!next.has(k)) {
      const withoutInputs = previous.find((x) => x.type === entry.type && x.name === entry.name);
      const sameName = proposed.find((x) => x.type === entry.type && x.name === entry.name);
      if (withoutInputs && sameName) {
        compareEntry(withoutInputs, sameName, out);
      } else {
        out.push({
          classification: "breaking",
          rule: "entry-removed",
          path: k,
          previous: canonical(entry),
          proposed: null,
          detail: "removing a payout-relevant ABI entry breaks existing consumers",
        });
      }
    }
  }
  for (const entry of proposed) {
    if (!prev.has(key(entry))) {
      const sameName = previous.find((x) => x.type === entry.type && x.name === entry.name);
      if (!sameName) {
        out.push({
          classification: "compatible",
          rule: "entry-added",
          path: key(entry),
          previous: null,
          proposed: canonical(entry),
          detail: "additive ABI entry: assess consumer migration and generated-artifact provenance",
        });
      }
    }
  }
  return out;
}

function compareEntry(
  previous: AbiEntry,
  proposed: AbiEntry,
  out: AbiCompatibilityDecision[],
): void {
  const base = `${proposed.type}:${proposed.name ?? proposed.type}`;
  const pi = array(previous.inputs) as readonly AbiInput[];
  const ni = array(proposed.inputs) as readonly AbiInput[];
  if (pi.length !== ni.length) {
    const rule = pi.length > ni.length ? "input-removed" : "input-added";
    out.push({
      classification: rule === "input-removed" ? "breaking" : "compatible",
      rule,
      path: `${base}/inputs`,
      previous: canonical(pi),
      proposed: canonical(ni),
      detail:
        rule === "input-removed"
          ? "removed payout-relevant input"
          : "additive input requires consumer migration assessment",
    });
  } else {
    compareFields(pi, ni, `${base}/inputs`, out);
  }
  const po = array(previous.outputs) as readonly AbiInput[];
  const no = array(proposed.outputs) as readonly AbiInput[];
  if (po.length !== no.length) {
    const rule = po.length > no.length ? "output-removed" : "output-added";
    out.push({
      classification: rule === "output-removed" ? "breaking" : "compatible",
      rule,
      path: `${base}/outputs`,
      previous: canonical(po),
      proposed: canonical(no),
      detail:
        rule === "output-removed"
          ? "removed payout-relevant output"
          : "additive output requires consumer migration assessment",
    });
  } else {
    compareFields(po, no, `${base}/outputs`, out);
  }
  if (previous.stateMutability !== proposed.stateMutability) {
    out.push({
      classification: "breaking",
      rule: "state-mutability-changed",
      path: `${base}/stateMutability`,
      previous: previous.stateMutability ?? null,
      proposed: proposed.stateMutability ?? null,
      detail: "state mutability changed",
    });
  }
}

function compareFields(
  previous: readonly AbiInput[],
  proposed: readonly AbiInput[],
  path: string,
  out: AbiCompatibilityDecision[],
): void {
  for (let i = 0; i < previous.length; i++) {
    const p = previous[i];
    const n = proposed[i];
    if (!p || !n) throw new Error("ABI field length mismatch");
    if (p.name !== n.name) {
      const exact = proposed.findIndex((x) => x.name === p.name);
      if (exact >= 0)
        out.push({
          classification: "breaking",
          rule: "input-reordered",
          path: `${path}/${String(i)}/name`,
          previous: p.name ?? null,
          proposed: n.name ?? null,
          detail: "tuple or parameter order changed",
        });
    }
    if (p.indexed !== n.indexed) {
      out.push({
        classification: "breaking",
        rule: "event-indexed-changed",
        path: `${path}/${String(i)}/indexed`,
        previous: canonical(p.indexed),
        proposed: canonical(n.indexed),
        detail: "event topic/indexed layout changed",
      });
    }
    if (abiType(p) !== abiType(n)) {
      const tuple = p.type.startsWith("tuple") || n.type.startsWith("tuple");
      out.push({
        classification: "breaking",
        rule: tuple ? "tuple-field-type-changed" : "input-type-changed",
        path: `${path}/${String(i)}/type`,
        previous: abiType(p),
        proposed: abiType(n),
        detail: "field type or tuple layout changed",
      });
    }
    if (p.type.startsWith("tuple") && n.type.startsWith("tuple")) {
      compareTupleFields(p, n, `${path}/${String(i)}/components`, out);
    }
  }
}

function compareTupleFields(
  previous: AbiInput,
  proposed: AbiInput,
  path: string,
  out: AbiCompatibilityDecision[],
): void {
  const p = array(previous.components) as readonly AbiInput[];
  const n = array(proposed.components) as readonly AbiInput[];
  if (p.length !== n.length) {
    const removed = p.length > n.length;
    out.push({
      classification: removed ? "breaking" : "compatible",
      rule: removed ? "tuple-field-removed" : "tuple-field-added",
      path,
      previous: canonical(p),
      proposed: canonical(n),
      detail: removed
        ? "payout-relevant tuple field removed"
        : "tuple field appended; migration assessment required",
    });
  } else {
    compareFields(p, n, path, out);
  }
}

export function compareAbiSets(
  previous: readonly AbiEntry[],
  proposed: readonly AbiEntry[],
): AbiCompatibilityReport {
  const decisions = listDecisions(previous, proposed);
  const breaking = decisions.filter((decision) => decision.classification === "breaking").length;
  const compatible = decisions.length - breaking;
  return {
    reportVersion: 1,
    result: decisions.length === 0 ? "identical" : breaking > 0 ? "breaking" : "compatible",
    breaking,
    compatible,
    decisions,
  };
}

export function assertAbiCompatible(
  previous: readonly AbiEntry[],
  proposed: readonly AbiEntry[],
): AbiCompatibilityReport {
  const report = compareAbiSets(previous, proposed);
  if (report.result === "breaking")
    throw new Error(`ABI compatibility gate failed: ${JSON.stringify(report.decisions)}`);
  return report;
}
