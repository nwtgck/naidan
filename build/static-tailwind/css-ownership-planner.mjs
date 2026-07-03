import { Buffer } from 'node:buffer';
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

function unionOwners({ left, right }) {
  const values = new Set([...left, ...right]);
  return values.has('initial') ? new Set(['initial']) : values;
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
    if (node.type === 'comment') continue;
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

function propertyFamily({ property }) {
  if (property.startsWith('--')) return property;
  const normalized = property.toLowerCase();
  const shorthandGroups = [
    ['margin', ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block']],
    ['padding', ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block']],
    ['inset', ['inset', 'top', 'right', 'bottom', 'left', 'inset-inline', 'inset-block']],
    ['border-width', ['border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']],
    ['border-color', ['border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']],
    ['border-style', ['border-style', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style']],
    ['background', ['background', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat']],
    ['overflow', ['overflow', 'overflow-x', 'overflow-y']],
    ['outline', ['outline', 'outline-width', 'outline-color', 'outline-style']],
    ['transition', ['transition', 'transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function']],
    ['animation', ['animation', 'animation-name', 'animation-duration', 'animation-delay', 'animation-timing-function', 'animation-iteration-count']],
    ['flex', ['flex', 'flex-grow', 'flex-shrink', 'flex-basis']],
    ['grid', ['grid', 'grid-template', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows']],
  ];
  for (const [family, properties] of shorthandGroups) if (properties.includes(normalized)) return family;
  return normalized;
}

function cssPropertyFamilies({ css }) {
  if (css === null) return new Set();
  const families = new Set();
  const root = postcss.parse(css);
  function visitContainer({ container, sameElement }) {
    for (const node of container.nodes ?? []) {
      if (node.type === 'decl' && sameElement) families.add(propertyFamily({ property: node.prop }));
      else if (node.type === 'atrule') visitContainer({ container: node, sameElement });
      else if (node.type === 'rule') {
        const childIsSameElement = sameElement && node.selector.includes('&');
        if (childIsSameElement) visitContainer({ container: node, sameElement: true });
      }
    }
  }
  for (const node of root.nodes ?? []) {
    if (node.type === 'rule') visitContainer({ container: node, sameElement: true });
    else if (node.type === 'atrule') visitContainer({ container: node, sameElement: true });
  }
  return families;
}

function intersects({ left, right }) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function hasInitialOwner({ owners }) {
  return owners.has('initial');
}

function orderRequiresOwnerMerge({ left, right, leftOwners, rightOwners, classOrder }) {
  const leftKey = ownerKey({ owners: [...leftOwners] });
  const rightKey = ownerKey({ owners: [...rightOwners] });
  if (leftKey === rightKey) return false;
  const leftInitial = hasInitialOwner({ owners: leftOwners });
  const rightInitial = hasInitialOwner({ owners: rightOwners });
  if (!leftInitial && !rightInitial) return true;
  if (leftInitial && rightInitial) return false;
  const leftOrder = classOrder.get(left);
  const rightOrder = classOrder.get(right);
  if (leftOrder === null || leftOrder === undefined || rightOrder === null || rightOrder === undefined) return true;
  const initialOrder = leftInitial ? leftOrder : rightOrder;
  const lazyOrder = leftInitial ? rightOrder : leftOrder;
  return initialOrder > lazyOrder;
}

function bytes({ css }) {
  return { raw: Buffer.byteLength(css), gzip: gzipSync(css).length };
}

async function compileDelta({ cssEntryPath, candidates, expectedTailwindVersion, baselineCss }) {
  const compiled = await compileTailwindCss({ cssEntryPath, candidates, expectedTailwindVersion });
  return subtractCss({ css: compiled.css, baselineCss });
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

function compressCandidateOwnerGroups({ candidateOwners, candidateCss, maxLazyCssGroups }) {
  const groups = groupCandidatesByOwner({ candidateOwners });
  const lazyGroups = [...groups]
    .filter(([key]) => key !== 'initial')
    .map(([key, candidates]) => ({
      key,
      candidates,
      itemCount: candidates.length,
      bytes: candidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidateCss.get(candidate) ?? ''), 0),
    }))
    .sort((left, right) => lazyGroupPriority({ left, right }));
  const retained = new Set(lazyGroups.slice(0, maxLazyCssGroups).map(({ key }) => key));
  const promoted = [];
  for (const [candidate, owners] of candidateOwners) {
    const key = ownerKey({ owners: [...owners] });
    if (key === 'initial' || retained.has(key)) continue;
    candidateOwners.set(candidate, new Set(['initial']));
    promoted.push(candidate);
  }
  return {
    originalLazyGroupCount: lazyGroups.length,
    retainedLazyGroupCount: retained.size,
    promotedCandidateCount: promoted.length,
    retainedOwnerKeys: [...retained].sort(),
  };
}

function compressAtomGroups({ atomGroups, maxLazyCssGroups }) {
  const lazyGroups = [...atomGroups]
    .filter(([key]) => key !== 'initial')
    .map(([key, atoms]) => ({
      key,
      atoms,
      itemCount: atoms.length,
      bytes: atoms.reduce((sum, atom) => sum + Buffer.byteLength(atom.css), 0),
    }))
    .sort((left, right) => lazyGroupPriority({ left, right }));
  const retained = new Set(lazyGroups.slice(0, maxLazyCssGroups).map(({ key }) => key));
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
  maxLazyCssGroups = 40,
}) {
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
  const candidateCss = new Map(candidates.map((candidate, index) => [candidate, classification.generatedCss[index]]));
  const propertyFamilies = new Map(candidates.map((candidate) => [candidate, cssPropertyFamilies({ css: candidateCss.get(candidate) })]));
  const candidateOwners = new Map([...analysis.candidateOwners].map(([candidate, owners]) => [candidate, new Set(owners)]));
  const classOrder = validator.getClassOrder({ candidates });
  const conflicts = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of analysis.candidateGroups) {
      const generated = group.candidates.filter((candidate) => (
        candidateOwners.has(candidate) && candidateCss.get(candidate) !== null
      ));
      for (let leftIndex = 0; leftIndex < generated.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < generated.length; rightIndex += 1) {
          const left = generated[leftIndex];
          const right = generated[rightIndex];
          if (!intersects({ left: propertyFamilies.get(left), right: propertyFamilies.get(right) })) continue;
          const leftOwners = candidateOwners.get(left);
          const rightOwners = candidateOwners.get(right);
          if (!orderRequiresOwnerMerge({ left, right, leftOwners, rightOwners, classOrder })) continue;
          const merged = unionOwners({ left: leftOwners, right: rightOwners });
          const leftBefore = ownerKey({ owners: [...leftOwners] });
          const rightBefore = ownerKey({ owners: [...rightOwners] });
          const after = ownerKey({ owners: [...merged] });
          if (leftBefore !== after) {
            candidateOwners.set(left, new Set(merged));
            changed = true;
          }
          if (rightBefore !== after) {
            candidateOwners.set(right, new Set(merged));
            changed = true;
          }
          if (leftBefore !== after || rightBefore !== after) {
            conflicts.push({ groupId: group.id, left, right, leftBefore, rightBefore, after });
          }
        }
      }
    }
  }

  const candidateCompression = compressCandidateOwnerGroups({ candidateOwners, candidateCss, maxLazyCssGroups });
  const baseline = await compileTailwindCss({ cssEntryPath, candidates: [], expectedTailwindVersion });
  const baselineCss = baseline.css;
  const ownerCandidateGroups = groupCandidatesByOwner({ candidateOwners });
  const globalCompilation = await compileTailwindCss({ cssEntryPath, candidates, expectedTailwindVersion });
  const globalCss = globalCompilation.css;
  const globalDelta = subtractCss({ css: globalCss, baselineCss });
  const globalAtoms = flattenCssAtoms({ css: globalDelta });
  const globalOrder = new Map(globalAtoms.map((atom, index) => [atom.fingerprint, index]));
  const atomRecords = new Map();
  for (const [key, groupCandidates] of ownerCandidateGroups) {
    const css = await compileDelta({ cssEntryPath, candidates: groupCandidates, expectedTailwindVersion, baselineCss });
    for (const atom of flattenCssAtoms({ css })) {
      const record = atomRecords.get(atom.fingerprint) ?? { ...atom, owners: new Set(), sourceOwnerKeys: new Set() };
      ownerSetFromKey({ key }).forEach((owner) => record.owners.add(owner));
      record.sourceOwnerKeys.add(key);
      atomRecords.set(atom.fingerprint, record);
    }
  }
  const atomGroups = new Map();
  for (const atom of atomRecords.values()) {
    const key = ownerKey({ owners: [...atom.owners] });
    const values = atomGroups.get(key) ?? [];
    values.push(atom);
    atomGroups.set(key, values);
  }
  const atomCompression = compressAtomGroups({ atomGroups, maxLazyCssGroups });
  const cssGroups = new Map();
  for (const [key, atoms] of atomGroups) {
    atoms.sort((left, right) => (globalOrder.get(left.fingerprint) ?? Number.MAX_SAFE_INTEGER) - (globalOrder.get(right.fingerprint) ?? Number.MAX_SAFE_INTEGER));
    cssGroups.set(key, serializeCssAtoms({ atoms }));
  }

  const emittedRaw = [...cssGroups.values()].reduce((sum, css) => sum + Buffer.byteLength(css), 0);
  const emittedGzip = [...cssGroups.values()].reduce((sum, css) => sum + gzipSync(css).length, 0);
  const uniqueDelta = bytes({ css: globalDelta });
  const metrics = {
    baseline: bytes({ css: baselineCss }),
    uniqueDelta,
    emitted: {
      groupCount: cssGroups.size,
      raw: emittedRaw,
      gzip: emittedGzip,
      duplicateRaw: Math.max(0, emittedRaw - uniqueDelta.raw),
      duplicateRatio: uniqueDelta.raw === 0 ? 0 : Math.max(0, emittedRaw - uniqueDelta.raw) / uniqueDelta.raw,
    },
  };

  return {
    candidates,
    candidateOwners,
    ownerCandidateGroups,
    baselineCss,
    globalCss,
    globalDelta,
    cssGroups,
    conflicts,
    compression: {
      maxLazyCssGroups,
      candidates: candidateCompression,
      atoms: atomCompression,
    },
    metrics,
    tailwindVersion: validator.tailwindVersion,
  };
}

export function serializeCssOwnershipPlan({ plan }) {
  return {
    tailwindVersion: plan.tailwindVersion,
    candidates: plan.candidates,
    candidateOwners: Object.fromEntries([...plan.candidateOwners].sort(([left], [right]) => left.localeCompare(right)).map(([candidate, owners]) => [candidate, [...owners].sort()])),
    ownerCandidateGroups: Object.fromEntries([...plan.ownerCandidateGroups]),
    cssGroups: Object.fromEntries([...plan.cssGroups].map(([key, css]) => [key, { bytes: Buffer.byteLength(css), css }])),
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
  for (const [key, css] of plan.cssGroups) {
    const name = key === '' ? 'unowned' : key.replaceAll(/[^a-zA-Z0-9._-]+/gu, '__');
    fs.writeFileSync(path.join(directory, `${name}.css`), css);
  }
}
