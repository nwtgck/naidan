import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import postcss from 'postcss';
import {
  compileTailwindCss,
  createTailwindCandidateValidator,
} from './tailwind-candidate-validator.mjs';

function ownerKey({ owners }) {
  const normalized = owners.includes('initial') ? ['initial'] : [...new Set(owners)].sort();
  return normalized.join('|');
}

function ownerSetFromKey({ key }) {
  return key === '' ? [] : key.split('|');
}

function nodeHeader({ node }) {
  if (node.type === 'rule') return `rule:${node.selector}`;
  if (node.type === 'atrule') return `atrule:${node.name}:${node.params}`;
  if (node.type === 'decl') return `decl:${node.prop}:${node.value}:${node.important}`;
  if (node.type === 'comment') return `comment:${node.text}`;
  return `${node.type}:${node.toString()}`;
}

function subtractContainer({ target, baseline }) {
  const baselineNodes = baseline.nodes ?? [];
  const used = new Set();
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

function subtractCss({ css, baselineCss }) {
  const target = postcss.parse(css);
  const baseline = postcss.parse(baselineCss);
  subtractContainer({ target, baseline });
  return target.toString();
}

function wrapAtom({ wrappers, nodeCss }) {
  let result = nodeCss;
  for (const wrapper of [...wrappers].reverse()) {
    if (wrapper.type === 'atrule') result = `@${wrapper.name} ${wrapper.params} {\n${result}\n}`;
    else result = `${wrapper.selector} {\n${result}\n}`;
  }
  return result;
}

function flattenCssAtoms({ css }) {
  const root = postcss.parse(css);
  const atoms = [];
  function append({ wrappers, node }) {
    const nodeCss = node.type === 'atrule' && !Array.isArray(node.nodes)
      ? `@${node.name}${node.params === '' ? '' : ` ${node.params}`};`
      : node.type === 'decl'
        ? `${node.toString()};`
        : node.toString();
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
      const layerWrapper = [{ type: 'atrule', name: 'layer', params: node.params }];
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

function serializeCssAtoms({ atoms }) {
  const output = [];
  let current;
  function flush() {
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

function cssOwnershipKeys({ css }) {
  if (css === null || css.trim() === '') return new Set();
  const keys = new Set();
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    const selectorPath = [];
    let current = rule;
    while (current !== undefined && current.type !== 'root') {
      if (current.type === 'atrule' && current.name === 'keyframes') return;
      if (current.type === 'rule') selectorPath.unshift(current.selector);
      current = current.parent;
    }
    keys.add(`selector-path:${selectorPath.join('\0')}`);
  });
  root.walkAtRules('keyframes', (atRule) => {
    keys.add(`keyframes:${atRule.params}`);
  });
  return keys;
}

function createOwnershipHints({ candidates, candidateCss, candidateOwners }) {
  const hints = new Map();
  for (const candidate of candidates) {
    const owners = candidateOwners.get(candidate);
    if (owners === undefined) continue;
    for (const key of cssOwnershipKeys({ css: candidateCss.get(candidate) })) {
      const values = hints.get(key) ?? new Set();
      owners.forEach((owner) => values.add(owner));
      hints.set(key, values);
    }
  }
  return hints;
}

function atomOwners({ atom, ownershipHints }) {
  const owners = new Set();
  for (const key of cssOwnershipKeys({ css: atom.nodeCss })) {
    ownershipHints.get(key)?.forEach((owner) => owners.add(owner));
  }
  return owners.size === 0
    ? { owners: new Set(['initial']), sourceOwned: false }
    : { owners, sourceOwned: true };
}

function annotateCanonicalAtoms({ atoms }) {
  return atoms.map((atom, canonicalOrder) => ({
    ...atom,
    canonicalOrder,
  }));
}

function fingerprintCounts({ atoms }) {
  const counts = new Map();
  for (const atom of atoms) counts.set(atom.fingerprint, (counts.get(atom.fingerprint) ?? 0) + 1);
  return counts;
}

function consumeFingerprint({ counts, fingerprint }) {
  const count = counts.get(fingerprint) ?? 0;
  if (count === 0) return false;
  if (count === 1) counts.delete(fingerprint);
  else counts.set(fingerprint, count - 1);
  return true;
}

function createOrderedFragments({ atoms }) {
  const ordered = [...atoms].sort((left, right) => left.canonicalOrder - right.canonicalOrder);
  const runs = [];
  for (const atom of ordered) {
    const previous = runs.at(-1);
    if (previous === undefined || previous.atoms.at(-1)?.canonicalOrder + 1 !== atom.canonicalOrder) {
      runs.push({ order: atom.canonicalOrder, atoms: [atom] });
    } else previous.atoms.push(atom);
  }
  return runs.map(({ order, atoms: runAtoms }) => ({
    order,
    css: serializeCssAtoms({ atoms: runAtoms }),
  }));
}

function assertOrderedFragmentsReconstructGlobalCss({ globalAtoms, fragmentsByOwner }) {
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

function bytes({ css }) {
  return { raw: Buffer.byteLength(css), gzip: gzipSync(css).length };
}

function groupCandidatesByOwner({ candidateOwners }) {
  const result = new Map();
  for (const [candidate, owners] of candidateOwners) {
    const key = ownerKey({ owners: [...owners] });
    const candidates = result.get(key) ?? [];
    candidates.push(candidate);
    result.set(key, candidates);
  }
  for (const candidates of result.values()) candidates.sort();
  return result;
}

function lazyGroupPriority({ left, right }) {
  const leftSingleOwner = ownerSetFromKey({ key: left.key }).length === 1;
  const rightSingleOwner = ownerSetFromKey({ key: right.key }).length === 1;
  if (leftSingleOwner !== rightSingleOwner) return leftSingleOwner ? -1 : 1;
  if (left.bytes !== right.bytes) return right.bytes - left.bytes;
  if (left.itemCount !== right.itemCount) return right.itemCount - left.itemCount;
  return left.key.localeCompare(right.key);
}

function compressAtomGroups({ atomGroups, maxSplitCssGroups }) {
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
}) {
  if (outputMode !== 'single' && outputMode !== 'split') {
    throw new Error(`[tw-class] Unknown CSS output mode: ${String(outputMode)}`);
  }
  if (maxSplitCssGroups !== undefined && (!Number.isInteger(maxSplitCssGroups) || maxSplitCssGroups < 0)) {
    throw new Error(`[tw-class] maxSplitCssGroups must be a non-negative integer or undefined: ${String(maxSplitCssGroups)}`);
  }
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
  if (outputMode === 'single') {
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
  const candidateCss = new Map(candidates.map((candidate, index) => [candidate, classification.generatedCss[index]]));
  const candidateOwners = new Map([...analysis.candidateOwners].map(([candidate, owners]) => [candidate, new Set(owners)]));
  const conflicts = [];
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
  const globalDelta = subtractCss({ css: globalCss, baselineCss: baseline.css });
  const globalAtoms = annotateCanonicalAtoms({ atoms: flattenCssAtoms({ css: globalCss }) });
  const baselineFingerprints = fingerprintCounts({ atoms: flattenCssAtoms({ css: baseline.css }) });
  const ownershipHints = createOwnershipHints({ candidates, candidateCss, candidateOwners });
  const atomGroups = new Map();
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
    const key = ownerKey({ owners: [...placement.owners] });
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
  const runtimeFragmentsByOwner = new Map();
  const cssGroups = new Map();
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
  const metrics = {
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

export function serializeCssOwnershipPlan({ plan }) {
  return {
    outputMode: plan.outputMode,
    tailwindVersion: plan.tailwindVersion,
    candidates: plan.candidates,
    candidateOwners: Object.fromEntries([...plan.candidateOwners].sort(([left], [right]) => left.localeCompare(right)).map(([candidate, owners]) => [candidate, [...owners].sort()])),
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

export function writeCssOwnershipDebugFiles({ directory, plan }) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'base.css'), plan.baselineCss);
  fs.writeFileSync(path.join(directory, 'single-global.css'), plan.globalCss);
  fs.writeFileSync(path.join(directory, 'all-utilities.css'), plan.globalDelta);
  const groups = {};
  for (const [ownerKeyValue, css] of plan.cssGroups) {
    const hash = crypto.createHash('sha256').update(ownerKeyValue).digest('hex');
    const filename = `group-${hash}.css`;
    fs.writeFileSync(path.join(directory, filename), css);
    groups[hash] = {
      filename,
      ownerKey: ownerKeyValue,
      owners: ownerSetFromKey({ key: ownerKeyValue }),
      bytes: Buffer.byteLength(css),
      fragmentCount: plan.runtimeFragmentsByOwner.get(ownerKeyValue)?.length ?? 0,
      fragmentOrders: plan.runtimeFragmentsByOwner.get(ownerKeyValue)?.map(({ order }) => order) ?? [],
    };
  }
  fs.writeFileSync(path.join(directory, 'groups.json'), `${JSON.stringify({ groups }, null, 2)}\n`);
}
