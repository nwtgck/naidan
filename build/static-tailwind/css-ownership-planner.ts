import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Node,
  type Rule,
} from 'postcss';
import { assertStaticTailwindCssHasNoRelativeUrls } from './css-postprocessor';
import {
  compileTailwindCss,
  createTailwindCandidateValidator,
} from './tailwind-candidate-validator';

export type CandidateGroup = {
  id: string;
  filename: string;
  line: number;
  column: number;
  sourceKind: string;
  sourceAttributes?: string[];
  candidates: string[];
};

export type CssOwnershipAnalysis = {
  candidateGroups: CandidateGroup[];
  candidateOwners: Map<string, Set<string>>;
};

export type CssOwnershipCompression = {
  originalLazyGroupCount: number;
  retainedLazyGroupCount: number;
  promotedCandidateCount?: number;
  promotedAtomCount?: number;
  retainedOwnerKeys: string[];
};

export type CssByteMetrics = {
  raw: number;
  gzip: number;
};

export type CssOwnershipMetrics = {
  baseline: CssByteMetrics;
  uniqueDelta: CssByteMetrics;
  ordering: {
    runtimeFragmentCount: number;
    runtimeMetadataRaw: number;
    runtimeMetadataGzip: number;
  };
  placement: {
    globalAtomCount: number;
    sourceOwnedAtomCount: number;
    initialSupportAtomCount: number;
  };
  emitted: {
    groupCount: number;
    raw: number;
    gzip: number;
    duplicateAtomCount: number;
    duplicateRaw: number;
    duplicateRatio: number;
    structuralOverheadRaw: number;
  };
};

export type CssRuntimeFragment = {
  order: number;
  css: string;
};

export type CssOwnershipPlan = {
  outputMode: 'single' | 'split';
  candidates: string[];
  candidateOwners: Map<string, Set<string>>;
  ownerCandidateGroups: Map<string, string[]>;
  baselineCss: string;
  entryCss: string;
  globalCss: string;
  globalDelta: string;
  cssGroups: Map<string, string>;
  runtimeFragmentsByOwner: Map<string, CssRuntimeFragment[]>;
  conflicts: unknown[];
  compression: {
    maxSplitCssGroups: number | undefined;
    candidates: CssOwnershipCompression;
    atoms: CssOwnershipCompression;
  };
  metrics: CssOwnershipMetrics;
  tailwindVersion: string;
};

type CssWrapper =
  | { type: 'atrule'; name: string; params: string }
  | { type: 'rule'; selector: string };

type CssAtom = {
  fingerprint: string;
  css: string;
  nodeCss: string;
  wrappers: CssWrapper[];
  wrapperKey: string;
};

type CanonicalCssAtom = CssAtom & {
  canonicalOrder: number;
};

type CssAtomRun = {
  wrapperKey: string;
  wrappers: CssWrapper[];
  nodes: string[];
};

type LazyGroup = {
  key: string;
  bytes: number;
  itemCount: number;
};


export function createCssOwnerKey({ owners }: { owners: string[] }): string {
  const normalized = owners.includes('initial') ? ['initial'] : [...new Set(owners)].sort();
  return normalized.length === 1 ? normalized[0] : JSON.stringify(normalized);
}

export function parseCssOwnerKey({ key }: { key: string }): string[] {
  if (key === '') return [];
  if (!key.startsWith('[')) return [key];
  let owners: unknown;
  try {
    owners = JSON.parse(key);
  } catch (error) {
    throw new Error(`[tw-class] Invalid serialized CSS owner key: ${key}`, { cause: error });
  }
  if (!Array.isArray(owners) || owners.length < 2 || owners.some((owner) => typeof owner !== 'string' || owner === '')) {
    throw new Error(`[tw-class] Invalid serialized CSS owner key: ${key}`);
  }
  return owners;
}

function nodeHeader({ node }: { node: ChildNode }): string {
  switch (node.type) {
  case 'rule':
    return `rule:${node.selector}`;
  case 'atrule':
    return `atrule:${node.name}:${node.params}`;
  case 'decl':
    return `decl:${node.prop}:${node.value}:${node.important}`;
  case 'comment':
    return `comment:${node.text}`;
  default: {
    const exhaustive: never = node;
    const unexpectedNode = exhaustive as Node;
    return `${unexpectedNode.type}:${unexpectedNode.toString()}`;
  }
  }
}

function subtractContainer({ target, baseline }: { target: Container; baseline: Container }): void {
  const baselineNodes = baseline.nodes ?? [];
  const used = new Set<number>();
  for (const node of [...(target.nodes ?? [])]) {
    const header = nodeHeader({ node });
    let matchIndex = -1;
    for (let index = 0; index < baselineNodes.length; index += 1) {
      if (used.has(index)) continue;
      if (nodeHeader({ node: baselineNodes[index] }) === header) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex === -1) continue;
    used.add(matchIndex);
    const baselineNode = baselineNodes[matchIndex];
    if ('nodes' in node && Array.isArray(node.nodes) && 'nodes' in baselineNode && Array.isArray(baselineNode.nodes)) {
      subtractContainer({ target: node, baseline: baselineNode });
      if ((node.nodes ?? []).length === 0) node.remove();
      continue;
    }
    if (node.toString() === baselineNode.toString()) node.remove();
  }
}

function subtractCss({ css, baselineCss }: { css: string; baselineCss: string }): string {
  const target = postcss.parse(css);
  const baseline = postcss.parse(baselineCss);
  subtractContainer({ target, baseline });
  return target.toString();
}

function wrapAtom({ wrappers, nodeCss }: { wrappers: CssWrapper[]; nodeCss: string }): string {
  let result = nodeCss;
  for (const wrapper of [...wrappers].reverse()) {
    switch (wrapper.type) {
    case 'atrule':
      result = `@${wrapper.name} ${wrapper.params} {\n${result}\n}`;
      break;
    case 'rule':
      result = `${wrapper.selector} {\n${result}\n}`;
      break;
    default: {
      const _ex: never = wrapper;
      throw new Error(`Unhandled CSS wrapper: ${String(_ex)}`);
    }
    }
  }
  return result;
}

function flattenCssAtoms({ css }: { css: string }): CssAtom[] {
  const root = postcss.parse(css);
  const atoms: CssAtom[] = [];
  function append({ wrappers, node }: { wrappers: CssWrapper[]; node: ChildNode }): void {
    let nodeCss: string;
    switch (node.type) {
    case 'atrule':
      nodeCss = !Array.isArray(node.nodes)
        ? `@${node.name}${node.params === '' ? '' : ` ${node.params}`};`
        : node.toString();
      break;
    case 'decl':
      nodeCss = `${node.toString()};`;
      break;
    case 'comment':
    case 'rule':
      nodeCss = node.toString();
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled CSS node: ${String(_ex)}`);
    }
    }
    const cssText = wrapAtom({ wrappers, nodeCss });
    atoms.push({
      fingerprint: cssText,
      css: cssText,
      nodeCss,
      wrappers: wrappers.map((wrapper) => ({ ...wrapper })),
      wrapperKey: JSON.stringify(wrappers),
    });
  }
  for (const node of root.nodes ?? []) {
    if (node.type === 'atrule' && node.name === 'layer' && Array.isArray(node.nodes)) {
      const layerWrapper: CssWrapper[] = [{ type: 'atrule', name: 'layer', params: node.params }];
      for (const child of node.nodes) {
        if (node.params === 'theme' && child.type === 'rule' && Array.isArray(child.nodes)) {
          for (const declaration of child.nodes) {
            append({ wrappers: [...layerWrapper, { type: 'rule', selector: child.selector }], node: declaration });
          }
        } else append({ wrappers: layerWrapper, node: child });
      }
      continue;
    }
    append({ wrappers: [], node });
  }
  return atoms;
}

function serializeCssAtoms({ atoms }: { atoms: CssAtom[] }): string {
  const output: string[] = [];
  let current: CssAtomRun | undefined;
  function flush(): void {
    if (current === undefined) return;
    output.push(wrapAtom({ wrappers: current.wrappers, nodeCss: current.nodes.join('\n') }));
    current = undefined;
  }
  for (const atom of atoms) {
    if (current === undefined || current.wrapperKey !== atom.wrapperKey) {
      flush();
      current = { wrapperKey: atom.wrapperKey, wrappers: atom.wrappers, nodes: [atom.nodeCss] };
    } else current.nodes.push(atom.nodeCss);
  }
  flush();
  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}

function isAtRuleNode(node: Node): node is AtRule {
  return node.type === 'atrule';
}

function isRuleNode(node: Node): node is Rule {
  return node.type === 'rule';
}

function cssOwnershipKeys({ css }: { css: string | null | undefined }): Set<string> {
  if (css === null || css === undefined || css.trim() === '') return new Set();
  const keys = new Set<string>();
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    const selectorPath: string[] = [];
    let current: Node | undefined = rule;
    while (current !== undefined && current.type !== 'root') {
      if (isAtRuleNode(current) && current.name === 'keyframes') return;
      if (isRuleNode(current)) selectorPath.unshift(current.selector);
      current = current.parent;
    }
    keys.add(`selector-path:${selectorPath.join('\0')}`);
  });
  root.walkAtRules('keyframes', (atRule) => {
    keys.add(`keyframes:${atRule.params}`);
  });
  return keys;
}

function createOwnershipHints({ candidates, candidateCss, candidateOwners }: { candidates: string[]; candidateCss: Map<string, string | null>; candidateOwners: Map<string, Set<string>> }): Map<string, Set<string>> {
  const hints = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const owners = candidateOwners.get(candidate);
    if (owners === undefined) continue;
    for (const key of cssOwnershipKeys({ css: candidateCss.get(candidate) })) {
      const values = hints.get(key) ?? new Set<string>();
      owners.forEach((owner) => values.add(owner));
      hints.set(key, values);
    }
  }
  return hints;
}

function atomOwners({ atom, ownershipHints }: { atom: CanonicalCssAtom; ownershipHints: Map<string, Set<string>> }): { owners: Set<string>; sourceOwned: boolean } {
  const owners = new Set<string>();
  for (const key of cssOwnershipKeys({ css: atom.nodeCss })) {
    ownershipHints.get(key)?.forEach((owner) => owners.add(owner));
  }
  return owners.size === 0
    ? { owners: new Set(['initial']), sourceOwned: false }
    : { owners, sourceOwned: true };
}

function annotateCanonicalAtoms({ atoms }: { atoms: CssAtom[] }): CanonicalCssAtom[] {
  return atoms.map((atom, canonicalOrder) => ({
    ...atom,
    canonicalOrder,
  }));
}

function fingerprintCounts({ atoms }: { atoms: CssAtom[] }): Map<string, number> {
  const counts = new Map<string, number>();
  for (const atom of atoms) counts.set(atom.fingerprint, (counts.get(atom.fingerprint) ?? 0) + 1);
  return counts;
}

function consumeFingerprint({ counts, fingerprint }: { counts: Map<string, number>; fingerprint: string }): boolean {
  const count = counts.get(fingerprint) ?? 0;
  if (count === 0) return false;
  if (count === 1) counts.delete(fingerprint);
  else counts.set(fingerprint, count - 1);
  return true;
}

function createOrderedFragments({ atoms }: { atoms: CanonicalCssAtom[] }): CssRuntimeFragment[] {
  const ordered = [...atoms].sort((left, right) => left.canonicalOrder - right.canonicalOrder);
  const runs: { order: number; atoms: CanonicalCssAtom[] }[] = [];
  for (const atom of ordered) {
    const previous = runs.at(-1);
    const previousOrder = previous?.atoms.at(-1)?.canonicalOrder;
    if (previous === undefined || previousOrder === undefined || previousOrder + 1 !== atom.canonicalOrder) {
      runs.push({ order: atom.canonicalOrder, atoms: [atom] });
    } else previous.atoms.push(atom);
  }
  return runs.map(({ order, atoms: runAtoms }) => ({
    order,
    css: serializeCssAtoms({ atoms: runAtoms }),
  }));
}

function assertOrderedFragmentsReconstructGlobalCss({ globalAtoms, fragmentsByOwner }: { globalAtoms: CanonicalCssAtom[]; fragmentsByOwner: Map<string, CssRuntimeFragment[]> }): void {
  const fragments = [...fragmentsByOwner.values()]
    .flat()
    .sort((left, right) => left.order - right.order);
  const reconstructedAtoms = flattenCssAtoms({ css: fragments.map(({ css }) => css).join('\n') });
  const expectedFingerprints = globalAtoms.map(({ fingerprint }) => fingerprint);
  const actualFingerprints = reconstructedAtoms.map(({ fingerprint }) => fingerprint);
  if (JSON.stringify(actualFingerprints) !== JSON.stringify(expectedFingerprints)) {
    const mismatchIndex = expectedFingerprints.findIndex((fingerprint, index) => fingerprint !== actualFingerprints[index]);
    throw new Error(
      '[tw-class] Ordered runtime CSS fragments do not reconstruct the canonical global CSS atom sequence. '
      + `Mismatch at ${mismatchIndex}; expected=${JSON.stringify(expectedFingerprints[mismatchIndex])}; `
      + `actual=${JSON.stringify(actualFingerprints[mismatchIndex])}; `
      + `expectedCount=${expectedFingerprints.length}; actualCount=${actualFingerprints.length}.`,
    );
  }
}

function bytes({ css }: { css: string }): CssByteMetrics {
  return { raw: Buffer.byteLength(css), gzip: gzipSync(css).length };
}

function assertAnalysisIntegrity({ analysis }: { analysis: CssOwnershipAnalysis }): void {
  const occurrenceCandidates = new Set(
    analysis.candidateGroups.flatMap((group) => group.candidates),
  );
  const ownerCandidates = new Set(analysis.candidateOwners.keys());
  const missingOwners = [...occurrenceCandidates]
    .filter((candidate) => !ownerCandidates.has(candidate))
    .sort();
  const missingOccurrences = [...ownerCandidates]
    .filter((candidate) => !occurrenceCandidates.has(candidate))
    .sort();
  const invalidOwnerEntries = [...analysis.candidateOwners]
    .filter(([, owners]) => (
      !(owners instanceof Set)
      || owners.size === 0
      || [...owners].some((owner) => typeof owner !== 'string' || owner.length === 0)
    ))
    .map(([candidate]) => candidate)
    .sort();
  if (missingOwners.length === 0 && missingOccurrences.length === 0 && invalidOwnerEntries.length === 0) return;
  const details = [
    missingOwners.length === 0
      ? undefined
      : `candidates missing owner entries: ${missingOwners.join(', ')}`,
    missingOccurrences.length === 0
      ? undefined
      : `owner entries missing source occurrences: ${missingOccurrences.join(', ')}`,
    invalidOwnerEntries.length === 0
      ? undefined
      : `candidates with invalid or empty owner sets: ${invalidOwnerEntries.join(', ')}`,
  ].filter(Boolean);
  throw new Error(`[tw-class] Invalid source ownership analysis: ${details.join('; ')}`);
}

function groupCandidatesByOwner({ candidateOwners }: { candidateOwners: Map<string, Set<string>> }): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [candidate, owners] of candidateOwners) {
    const key = createCssOwnerKey({ owners: [...owners] });
    const candidates = result.get(key) ?? [];
    candidates.push(candidate);
    result.set(key, candidates);
  }
  for (const candidates of result.values()) candidates.sort();
  return result;
}

function lazyGroupPriority({ left, right }: { left: LazyGroup; right: LazyGroup }): number {
  if (left.bytes !== right.bytes) return right.bytes - left.bytes;
  if (left.itemCount !== right.itemCount) return right.itemCount - left.itemCount;
  const leftSingleOwner = parseCssOwnerKey({ key: left.key }).length === 1;
  const rightSingleOwner = parseCssOwnerKey({ key: right.key }).length === 1;
  if (leftSingleOwner !== rightSingleOwner) return leftSingleOwner ? -1 : 1;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function compressAtomGroups({ atomGroups, maxSplitCssGroups }: { atomGroups: Map<string, CanonicalCssAtom[]>; maxSplitCssGroups: number }): CssOwnershipCompression {
  const lazyGroups = [...atomGroups]
    .filter(([key]) => key !== 'initial')
    .map(([key, atoms]) => ({
      key,
      atoms,
      itemCount: atoms.length,
      bytes: atoms.reduce((sum, atom) => sum + Buffer.byteLength(atom.css), 0),
    }))
    .sort((left, right) => lazyGroupPriority({ left, right }));
  const retained = new Set(lazyGroups.slice(0, maxSplitCssGroups).map(({ key }) => key));
  const initialAtoms = atomGroups.get('initial') ?? [];
  let promotedAtomCount = 0;
  for (const { key, atoms } of lazyGroups) {
    if (retained.has(key)) continue;
    initialAtoms.push(...atoms);
    atomGroups.delete(key);
    promotedAtomCount += atoms.length;
  }
  if (initialAtoms.length > 0) atomGroups.set('initial', initialAtoms);
  return {
    originalLazyGroupCount: lazyGroups.length,
    retainedLazyGroupCount: retained.size,
    promotedAtomCount,
    retainedOwnerKeys: [...retained].sort(),
  };
}

export async function createCssOwnershipPlan({
  projectRoot,
  cssEntryPath,
  expectedTailwindVersion,
  analysis,
  outputMode,
  maxSplitCssGroups,
}: {
  projectRoot: string;
  cssEntryPath: string;
  expectedTailwindVersion: string | undefined;
  analysis: CssOwnershipAnalysis;
  outputMode: 'single' | 'split';
  maxSplitCssGroups: number | undefined;
}): Promise<CssOwnershipPlan> {
  if (outputMode !== 'single' && outputMode !== 'split') {
    throw new Error(`[tw-class] Unknown CSS output mode: ${String(outputMode)}`);
  }
  if (maxSplitCssGroups !== undefined && (!Number.isInteger(maxSplitCssGroups) || maxSplitCssGroups < 0)) {
    throw new Error(`[tw-class] maxSplitCssGroups must be a non-negative integer or undefined: ${String(maxSplitCssGroups)}`);
  }
  assertAnalysisIntegrity({ analysis });
  const candidates = [...analysis.candidateOwners.keys()].sort();
  const validator = await createTailwindCandidateValidator({ projectRoot, cssEntryPath, expectedTailwindVersion });
  const classification = validator.classify({ candidates });
  if (classification.invalidCandidates.length > 0) {
    const invalid = new Set(classification.invalidCandidates);
    const occurrences = analysis.candidateGroups.flatMap((group) => group.candidates
      .filter((candidate) => invalid.has(candidate))
      .map((candidate) => ({
        candidate,
        filename: group.filename,
        line: group.line ?? 1,
        column: group.column ?? 1,
        sourceKind: group.sourceAttributes?.join(', ') ?? group.sourceKind,
      })));
    const details = occurrences.map(({ candidate, filename, line, column, sourceKind }) => (
      `Unknown Tailwind candidate "${candidate}" at ${filename}:${line}:${column} (${sourceKind}).`
    ));
    throw new Error(`[tw-class] ${details.join('\n[tw-class] ')}`);
  }
  switch (outputMode) {
  case 'single': {
    const sourceOwnerGroups = groupCandidatesByOwner({ candidateOwners: analysis.candidateOwners });
    const originalLazyOwnerKeys = [...sourceOwnerGroups.keys()]
      .filter((key) => key !== 'initial')
      .sort();
    const candidateOwners = new Map(candidates.map((candidate) => [candidate, new Set(['initial'])]));
    const ownerCandidateGroups = candidates.length === 0
      ? new Map()
      : new Map([['initial', candidates]]);
    const baseline = await compileTailwindCss({ cssEntryPath, candidates: [], expectedTailwindVersion });
    const baselineCss = baseline.css;
    const globalCompilation = await compileTailwindCss({ cssEntryPath, candidates, expectedTailwindVersion });
    const globalCss = globalCompilation.css;
    const globalDelta = subtractCss({ css: globalCss, baselineCss });
    const cssGroups = globalDelta.trim() === ''
      ? new Map()
      : new Map([['initial', globalDelta]]);
    const uniqueDelta = bytes({ css: globalDelta });
    const globalAtomCount = flattenCssAtoms({ css: globalDelta }).length;
    const promotedCandidateCount = candidates.filter((candidate) => (
      analysis.candidateOwners.get(candidate)?.has('initial') !== true
    )).length;
    return {
      outputMode,
      candidates,
      candidateOwners,
      ownerCandidateGroups,
      baselineCss,
      entryCss: globalCss,
      globalCss,
      globalDelta,
      cssGroups,
      runtimeFragmentsByOwner: new Map(),
      conflicts: [],
      compression: {
        maxSplitCssGroups: undefined,
        candidates: {
          originalLazyGroupCount: originalLazyOwnerKeys.length,
          retainedLazyGroupCount: 0,
          promotedCandidateCount,
          retainedOwnerKeys: [],
        },
        atoms: {
          originalLazyGroupCount: 0,
          retainedLazyGroupCount: 0,
          promotedAtomCount: 0,
          retainedOwnerKeys: [],
        },
      },
      metrics: {
        baseline: bytes({ css: baselineCss }),
        uniqueDelta,
        ordering: {
          runtimeFragmentCount: 0,
          runtimeMetadataRaw: 0,
          runtimeMetadataGzip: 0,
        },
        placement: {
          globalAtomCount,
          sourceOwnedAtomCount: 0,
          initialSupportAtomCount: globalAtomCount,
        },
        emitted: {
          groupCount: cssGroups.size,
          raw: uniqueDelta.raw,
          gzip: uniqueDelta.gzip,
          duplicateAtomCount: 0,
          duplicateRaw: 0,
          duplicateRatio: 0,
          structuralOverheadRaw: 0,
        },
      },
      tailwindVersion: validator.tailwindVersion,
    };
  }
  case 'split':
    break;
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled CSS output mode: ${_ex}`);
  }
  }
  const candidateCss = new Map(candidates.map((candidate, index) => [candidate, classification.generatedCss[index]]));
  const candidateOwners = new Map([...analysis.candidateOwners].map(([candidate, owners]) => [candidate, new Set(owners)]));
  const conflicts: unknown[] = [];
  const candidateOwnerKeysBeforeCompression = [...groupCandidatesByOwner({ candidateOwners }).keys()]
    .filter((key) => key !== 'initial')
    .sort();
  const candidateCompression = {
    originalLazyGroupCount: candidateOwnerKeysBeforeCompression.length,
    retainedLazyGroupCount: candidateOwnerKeysBeforeCompression.length,
    promotedCandidateCount: 0,
    retainedOwnerKeys: candidateOwnerKeysBeforeCompression,
  };
  const baseline = await compileTailwindCss({ cssEntryPath, candidates: [], expectedTailwindVersion });
  const ownerCandidateGroups = groupCandidatesByOwner({ candidateOwners });
  const globalCompilation = await compileTailwindCss({ cssEntryPath, candidates, expectedTailwindVersion });
  const globalCss = globalCompilation.css;
  assertStaticTailwindCssHasNoRelativeUrls({ css: globalCss });
  const globalDelta = subtractCss({ css: globalCss, baselineCss: baseline.css });
  const globalAtoms = annotateCanonicalAtoms({ atoms: flattenCssAtoms({ css: globalCss }) });
  const baselineFingerprints = fingerprintCounts({ atoms: flattenCssAtoms({ css: baseline.css }) });
  const ownershipHints = createOwnershipHints({ candidates, candidateCss, candidateOwners });
  const atomGroups = new Map<string, CanonicalCssAtom[]>();
  let sourceOwnedAtomCount = 0;
  let initialSupportAtomCount = 0;
  for (const atom of globalAtoms) {
    const isBaselineAtom = consumeFingerprint({
      counts: baselineFingerprints,
      fingerprint: atom.fingerprint,
    });
    const placement = isBaselineAtom
      ? { owners: new Set(['initial']), sourceOwned: false }
      : atomOwners({ atom, ownershipHints });
    if (placement.sourceOwned) sourceOwnedAtomCount += 1;
    else initialSupportAtomCount += 1;
    const key = createCssOwnerKey({ owners: [...placement.owners] });
    const values = atomGroups.get(key) ?? [];
    values.push(atom);
    atomGroups.set(key, values);
  }
  const atomOwnerKeysBeforeCompression = [...atomGroups.keys()]
    .filter((key) => key !== 'initial')
    .sort();
  const atomCompression = maxSplitCssGroups === undefined
    ? {
      originalLazyGroupCount: atomOwnerKeysBeforeCompression.length,
      retainedLazyGroupCount: atomOwnerKeysBeforeCompression.length,
      promotedAtomCount: 0,
      retainedOwnerKeys: atomOwnerKeysBeforeCompression,
    }
    : compressAtomGroups({ atomGroups, maxSplitCssGroups });
  const runtimeFragmentsByOwner = new Map<string, CssRuntimeFragment[]>();
  const cssGroups = new Map<string, string>();
  for (const [key, atoms] of atomGroups) {
    const fragments = createOrderedFragments({ atoms });
    runtimeFragmentsByOwner.set(key, fragments);
    cssGroups.set(key, fragments.map(({ css }) => css).join('\n'));
  }
  assertOrderedFragmentsReconstructGlobalCss({ globalAtoms, fragmentsByOwner: runtimeFragmentsByOwner });

  const emittedRaw = [...cssGroups.values()].reduce((sum, css) => sum + Buffer.byteLength(css), 0);
  const emittedGzip = [...cssGroups.values()].reduce((sum, css) => sum + gzipSync(css).length, 0);
  const uniqueDelta = bytes({ css: globalDelta });
  const serializedGlobalCss = serializeCssAtoms({ atoms: globalAtoms });
  const runtimeFragmentCount = [...runtimeFragmentsByOwner.values()].reduce((sum, fragments) => sum + fragments.length, 0);
  const runtimeMetadata = JSON.stringify([...runtimeFragmentsByOwner].map(([key, fragments]) => [
    key,
    fragments.map(({ order }) => order),
  ]));
  const structuralOverheadRaw = Math.max(0, emittedRaw - Buffer.byteLength(serializedGlobalCss));
  const metrics: CssOwnershipMetrics = {
    baseline: bytes({ css: baseline.css }),
    uniqueDelta,
    ordering: {
      runtimeFragmentCount,
      runtimeMetadataRaw: Buffer.byteLength(runtimeMetadata),
      runtimeMetadataGzip: gzipSync(runtimeMetadata).length,
    },
    placement: {
      globalAtomCount: globalAtoms.length,
      sourceOwnedAtomCount,
      initialSupportAtomCount,
    },
    emitted: {
      groupCount: cssGroups.size,
      raw: emittedRaw,
      gzip: emittedGzip,
      duplicateAtomCount: 0,
      duplicateRaw: 0,
      duplicateRatio: 0,
      structuralOverheadRaw,
    },
  };

  return {
    outputMode,
    candidates,
    candidateOwners,
    ownerCandidateGroups,
    baselineCss: baseline.css,
    entryCss: '',
    globalCss,
    globalDelta,
    cssGroups,
    runtimeFragmentsByOwner,
    conflicts,
    compression: {
      maxSplitCssGroups,
      candidates: candidateCompression,
      atoms: atomCompression,
    },
    metrics,
    tailwindVersion: validator.tailwindVersion,
  };

}

export function serializeCssOwnershipPlan({ plan }: { plan: CssOwnershipPlan }): unknown {
  return {
    outputMode: plan.outputMode,
    tailwindVersion: plan.tailwindVersion,
    candidates: plan.candidates,
    candidateOwners: Object.fromEntries([...plan.candidateOwners].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([candidate, owners]) => [candidate, [...owners].sort()])),
    ownerCandidateGroups: Object.fromEntries([...plan.ownerCandidateGroups]),
    entryCssBytes: Buffer.byteLength(plan.entryCss),
    cssGroups: Object.fromEntries([...plan.cssGroups].map(([key, css]) => [key, {
      bytes: Buffer.byteLength(css),
      fragmentCount: plan.runtimeFragmentsByOwner.get(key)?.length ?? 0,
      fragmentOrders: plan.runtimeFragmentsByOwner.get(key)?.map(({ order }) => order) ?? [],
      css,
    }])),
    conflicts: plan.conflicts,
    compression: plan.compression,
    globalCssBytes: Buffer.byteLength(plan.globalCss),
    metrics: plan.metrics,
  };
}

export function writeCssOwnershipDebugFiles({ directory, plan }: { directory: string; plan: CssOwnershipPlan }): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'base.css'), plan.baselineCss);
  fs.writeFileSync(path.join(directory, 'single-global.css'), plan.globalCss);
  fs.writeFileSync(path.join(directory, 'all-utilities.css'), plan.globalDelta);
  const groups: Record<string, { filename: string; ownerKey: string; owners: string[]; bytes: number; fragmentCount: number; fragmentOrders: number[] }> = {};
  for (const [ownerKeyValue, css] of plan.cssGroups) {
    const hash = crypto.createHash('sha256').update(ownerKeyValue).digest('hex');
    const filename = `group-${hash}.css`;
    fs.writeFileSync(path.join(directory, filename), css);
    groups[hash] = {
      filename,
      ownerKey: ownerKeyValue,
      owners: parseCssOwnerKey({ key: ownerKeyValue }),
      bytes: Buffer.byteLength(css),
      fragmentCount: plan.runtimeFragmentsByOwner.get(ownerKeyValue)?.length ?? 0,
      fragmentOrders: plan.runtimeFragmentsByOwner.get(ownerKeyValue)?.map(({ order }) => order) ?? [],
    };
  }
  fs.writeFileSync(path.join(directory, 'groups.json'), `${JSON.stringify({ groups }, null, 2)}\n`);
}
