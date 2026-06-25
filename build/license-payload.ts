import type { BuildLicenseDependency } from './license-dependencies';

/**
 * Serializes license dependencies as one self-contained JavaScript expression.
 *
 * Compression deliberately uses the actual licenseText values rather than the
 * license identifiers: an identifier such as MIT is metadata, not proof that
 * two packages ship the same legal text. Repeated complete texts and repeated
 * line-aligned substrings are discovered from the values themselves.
 *
 * The substring index works on exact line tokens instead of UTF-16 code units.
 * License bodies usually repeat paragraphs while varying copyright or notice
 * lines, so this captures the useful structure while keeping suffix-array time
 * and memory proportional to the number of lines. No newline or whitespace is
 * normalized, and every candidate is accepted only when the complete emitted
 * JavaScript becomes smaller in UTF-8 bytes.
 *
 * The result reconstructs text with direct `"..." + d[index]` expressions.
 * There is no generic runtime decoder or compressed public data shape, keeping
 * the generated virtual module portable and its default export unchanged.
 */

type LicenseTextOccurrence = Readonly<{
  dependencyIndex: number,
  start: number,
  end: number,
}>;

type LicenseTextCandidate = Readonly<{
  text: string,
  occurrences: readonly LicenseTextOccurrence[],
  estimatedSavingBytes: number,
}>;

type SelectedLicenseTextOccurrence = LicenseTextOccurrence & Readonly<{
  dictionaryIndex: number,
}>;

type UniqueLicenseText = Readonly<{
  text: string,
  dependencyIndices: readonly number[],
  lineIds: Uint32Array,
  lineOffsets: Uint32Array,
}>;

type LicenseTextIndex = Readonly<{
  uniqueTexts: readonly UniqueLicenseText[],
  lineTexts: readonly string[],
  concatenatedLineIds: Uint32Array,
  concatenatedTextIndices: Int32Array,
  concatenatedLineIndices: Int32Array,
  positionsByLineId: readonly (readonly Readonly<{
    uniqueTextIndex: number,
    lineIndex: number,
  }>[])[],
}>;

type CompressionPlan = Readonly<{
  dictionary: readonly string[],
  selectedOccurrencesByDependency: readonly (readonly SelectedLicenseTextOccurrence[])[],
}>;

const dictionaryVariableName = 'd';

function getUtf8ByteLength({ value }: { value: string }): number {
  return Buffer.byteLength(value, 'utf8');
}

function splitLinesPreservingEndings({ text }: { text: string }): readonly string[] {
  // License files may use LF, CRLF, or CR. Keeping each terminator in its line
  // token lets compression share only text that is byte-for-byte equivalent;
  // no whitespace or newline normalization can silently alter legal notices.
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function createUniqueLicenseTexts({ dependencies }: {
  dependencies: readonly BuildLicenseDependency[],
}): readonly Readonly<{
  text: string,
  dependencyIndices: readonly number[],
}>[] {
  const dependencyIndicesByText = new Map<string, number[]>();
  for (const [dependencyIndex, dependency] of dependencies.entries()) {
    if (dependency.licenseText === null) continue;
    const dependencyIndices = dependencyIndicesByText.get(dependency.licenseText);
    if (dependencyIndices === undefined) {
      dependencyIndicesByText.set(dependency.licenseText, [dependencyIndex]);
    } else {
      dependencyIndices.push(dependencyIndex);
    }
  }
  return [...dependencyIndicesByText.entries()].map(([text, dependencyIndices]) => ({
    text,
    dependencyIndices,
  }));
}

function createLicenseTextIndex({ dependencies }: {
  dependencies: readonly BuildLicenseDependency[],
}): LicenseTextIndex {
  const lineIdByText = new Map<string, number>();
  const lineTexts: string[] = [];
  const uniqueTexts = createUniqueLicenseTexts({ dependencies }).map(({ text, dependencyIndices }) => {
    const lines = splitLinesPreservingEndings({ text });
    const lineIds = new Uint32Array(lines.length);
    const lineOffsets = new Uint32Array(lines.length + 1);
    let offset = 0;
    for (const [lineIndex, line] of lines.entries()) {
      let lineId = lineIdByText.get(line);
      if (lineId === undefined) {
        lineId = lineTexts.length + 1;
        lineIdByText.set(line, lineId);
        lineTexts.push(line);
      }
      lineIds[lineIndex] = lineId;
      offset += line.length;
      lineOffsets[lineIndex + 1] = offset;
    }
    return {
      text,
      dependencyIndices,
      lineIds,
      lineOffsets,
    };
  });

  const concatenatedLength = uniqueTexts.reduce((total, uniqueText) => total + uniqueText.lineIds.length + 1, 0);
  const concatenatedLineIds = new Uint32Array(concatenatedLength);
  const concatenatedTextIndices = new Int32Array(concatenatedLength);
  const concatenatedLineIndices = new Int32Array(concatenatedLength);
  concatenatedTextIndices.fill(-1);
  concatenatedLineIndices.fill(-1);
  const mutablePositionsByLineId: Readonly<{
    uniqueTextIndex: number,
    lineIndex: number,
  }>[][] = Array.from({ length: lineTexts.length + 1 }, () => []);

  let concatenatedIndex = 0;
  for (const [uniqueTextIndex, uniqueText] of uniqueTexts.entries()) {
    for (const [lineIndex, lineId] of uniqueText.lineIds.entries()) {
      concatenatedLineIds[concatenatedIndex] = lineId;
      concatenatedTextIndices[concatenatedIndex] = uniqueTextIndex;
      concatenatedLineIndices[concatenatedIndex] = lineIndex;
      mutablePositionsByLineId[lineId]?.push({ uniqueTextIndex, lineIndex });
      concatenatedIndex += 1;
    }
    // A distinct separator per text prevents a repeated sequence from crossing
    // from one license into the next while still allowing one compact suffix index.
    concatenatedLineIds[concatenatedIndex] = lineTexts.length + uniqueTextIndex + 1;
    concatenatedIndex += 1;
  }

  return {
    uniqueTexts,
    lineTexts,
    concatenatedLineIds,
    concatenatedTextIndices,
    concatenatedLineIndices,
    positionsByLineId: mutablePositionsByLineId,
  };
}

function countingSortSuffixes({ source, target, ranks, offset, maximumRank, counts }: {
  source: Uint32Array,
  target: Uint32Array,
  ranks: Int32Array,
  offset: number,
  maximumRank: number,
  counts: Uint32Array,
}): void {
  counts.fill(0, 0, maximumRank + 2);
  for (const suffixIndex of source) {
    const rankIndex = suffixIndex + offset;
    const key = rankIndex < ranks.length ? ranks[rankIndex] + 1 : 0;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  let total = 0;
  for (let index = 0; index < maximumRank + 2; index += 1) {
    const count = counts[index] ?? 0;
    counts[index] = total;
    total += count;
  }
  for (const suffixIndex of source) {
    const rankIndex = suffixIndex + offset;
    const key = rankIndex < ranks.length ? ranks[rankIndex] + 1 : 0;
    const targetIndex = counts[key] ?? 0;
    target[targetIndex] = suffixIndex;
    counts[key] = targetIndex + 1;
  }
}

function createSuffixArray({ values }: { values: Uint32Array }): Uint32Array {
  const length = values.length;
  const suffixes = new Uint32Array(length);
  const temporarySuffixes = new Uint32Array(length);
  let ranks = new Int32Array(length);
  let nextRanks = new Int32Array(length);
  let maximumRank = 0;
  for (let index = 0; index < length; index += 1) {
    suffixes[index] = index;
    const rank = values[index] ?? 0;
    ranks[index] = rank;
    maximumRank = Math.max(maximumRank, rank);
  }
  const counts = new Uint32Array(Math.max(length, maximumRank) + 2);

  // Prefix doubling with two counting-sort passes keeps the index O(n log n)
  // without allocating comparison tuples for every sort. The indexed sequence
  // contains lines rather than UTF-16 code units, so n is small even for large
  // license corpora and memory remains proportional to the number of lines.
  for (let offset = 1; offset < length; offset *= 2) {
    countingSortSuffixes({
      source: suffixes,
      target: temporarySuffixes,
      ranks,
      offset,
      maximumRank,
      counts,
    });
    countingSortSuffixes({
      source: temporarySuffixes,
      target: suffixes,
      ranks,
      offset: 0,
      maximumRank,
      counts,
    });

    let nextRank = 0;
    const firstSuffix = suffixes[0];
    if (firstSuffix === undefined) return suffixes;
    nextRanks[firstSuffix] = nextRank;
    for (let suffixArrayIndex = 1; suffixArrayIndex < length; suffixArrayIndex += 1) {
      const previousSuffix = suffixes[suffixArrayIndex - 1];
      const currentSuffix = suffixes[suffixArrayIndex];
      if (previousSuffix === undefined || currentSuffix === undefined) continue;
      const previousPair = [
        ranks[previousSuffix],
        previousSuffix + offset < length ? ranks[previousSuffix + offset] : -1,
      ] as const;
      const currentPair = [
        ranks[currentSuffix],
        currentSuffix + offset < length ? ranks[currentSuffix + offset] : -1,
      ] as const;
      if (previousPair[0] !== currentPair[0] || previousPair[1] !== currentPair[1]) nextRank += 1;
      nextRanks[currentSuffix] = nextRank;
    }
    const previousRanks = ranks;
    ranks = nextRanks;
    nextRanks = previousRanks;
    maximumRank = nextRank;
    if (nextRank === length - 1) break;
  }
  return suffixes;
}

function createLongestCommonPrefixArray({ values, suffixes }: {
  values: Uint32Array,
  suffixes: Uint32Array,
}): Uint32Array {
  const rankBySuffix = new Uint32Array(values.length);
  for (const [rank, suffix] of suffixes.entries()) rankBySuffix[suffix] = rank;
  const longestCommonPrefixes = new Uint32Array(values.length);
  let commonLength = 0;
  for (let suffix = 0; suffix < values.length; suffix += 1) {
    const rank = rankBySuffix[suffix] ?? 0;
    if (rank === 0) continue;
    const previousSuffix = suffixes[rank - 1];
    if (previousSuffix === undefined) continue;
    while (
      suffix + commonLength < values.length
      && previousSuffix + commonLength < values.length
      && values[suffix + commonLength] === values[previousSuffix + commonLength]
    ) {
      commonLength += 1;
    }
    longestCommonPrefixes[rank] = commonLength;
    if (commonLength > 0) commonLength -= 1;
  }
  return longestCommonPrefixes;
}

function addCandidateOccurrences({ occurrencesByCandidateText, text, occurrences }: {
  occurrencesByCandidateText: Map<string, Map<string, LicenseTextOccurrence>>,
  text: string,
  occurrences: readonly LicenseTextOccurrence[],
}): void {
  let occurrencesByLocation = occurrencesByCandidateText.get(text);
  if (occurrencesByLocation === undefined) {
    occurrencesByLocation = new Map();
    occurrencesByCandidateText.set(text, occurrencesByLocation);
  }
  for (const occurrence of occurrences) {
    occurrencesByLocation.set(
      `${occurrence.dependencyIndex}:${occurrence.start}:${occurrence.end}`,
      occurrence,
    );
  }
}

function findLineSequenceOccurrences({ index, sourceStart, lineCount }: {
  index: LicenseTextIndex,
  sourceStart: number,
  lineCount: number,
}): readonly LicenseTextOccurrence[] {
  const firstLineId = index.concatenatedLineIds[sourceStart];
  if (firstLineId === undefined) return [];
  const positions = index.positionsByLineId[firstLineId] ?? [];
  const occurrences: LicenseTextOccurrence[] = [];
  for (const { uniqueTextIndex, lineIndex } of positions) {
    const uniqueText = index.uniqueTexts[uniqueTextIndex];
    if (uniqueText === undefined || lineIndex + lineCount > uniqueText.lineIds.length) continue;
    let matches = true;
    for (let candidateLineIndex = 0; candidateLineIndex < lineCount; candidateLineIndex += 1) {
      if (
        uniqueText.lineIds[lineIndex + candidateLineIndex]
        !== index.concatenatedLineIds[sourceStart + candidateLineIndex]
      ) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const start = uniqueText.lineOffsets[lineIndex];
    const end = uniqueText.lineOffsets[lineIndex + lineCount];
    if (start === undefined || end === undefined) continue;
    for (const dependencyIndex of uniqueText.dependencyIndices) {
      occurrences.push({ dependencyIndex, start, end });
    }
  }
  return occurrences;
}

function createLicenseTextCandidates({ dependencies }: {
  dependencies: readonly BuildLicenseDependency[],
}): readonly LicenseTextCandidate[] {
  const index = createLicenseTextIndex({ dependencies });
  const occurrencesByCandidateText = new Map<string, Map<string, LicenseTextOccurrence>>();

  for (const uniqueText of index.uniqueTexts) {
    if (uniqueText.dependencyIndices.length < 2 || uniqueText.text.length === 0) continue;
    addCandidateOccurrences({
      occurrencesByCandidateText,
      text: uniqueText.text,
      occurrences: uniqueText.dependencyIndices.map((dependencyIndex) => ({
        dependencyIndex,
        start: 0,
        end: uniqueText.text.length,
      })),
    });
  }

  if (index.concatenatedLineIds.length > 0) {
    // Restrict substring discovery to complete lines. A character-level suffix
    // array would index hundreds of thousands of UTF-16 code units for the same
    // corpus, while licenses normally repeat complete clauses and paragraphs.
    // The exact whole-text pass above still handles single-line duplicate files.
    const suffixes = createSuffixArray({ values: index.concatenatedLineIds });
    const longestCommonPrefixes = createLongestCommonPrefixArray({
      values: index.concatenatedLineIds,
      suffixes,
    });
    const seenLineSequenceKeys = new Set<string>();
    for (let suffixArrayIndex = 1; suffixArrayIndex < suffixes.length; suffixArrayIndex += 1) {
      const lineCount = longestCommonPrefixes[suffixArrayIndex] ?? 0;
      const sourceStart = suffixes[suffixArrayIndex];
      if (lineCount === 0 || sourceStart === undefined) continue;
      const uniqueTextIndex = index.concatenatedTextIndices[sourceStart];
      const sourceLineIndex = index.concatenatedLineIndices[sourceStart];
      const uniqueText = uniqueTextIndex === undefined || uniqueTextIndex < 0
        ? undefined
        : index.uniqueTexts[uniqueTextIndex];
      if (
        uniqueText === undefined
        || sourceLineIndex === undefined
        || sourceLineIndex < 0
        || sourceLineIndex + lineCount > uniqueText.lineIds.length
      ) {
        continue;
      }
      const lineSequenceKey = Array.from(
        index.concatenatedLineIds.subarray(sourceStart, sourceStart + lineCount),
      ).join(',');
      if (seenLineSequenceKeys.has(lineSequenceKey)) continue;
      seenLineSequenceKeys.add(lineSequenceKey);

      const start = uniqueText.lineOffsets[sourceLineIndex];
      const end = uniqueText.lineOffsets[sourceLineIndex + lineCount];
      if (start === undefined || end === undefined) continue;
      const text = uniqueText.text.slice(start, end);
      const occurrences = findLineSequenceOccurrences({ index, sourceStart, lineCount });
      if (occurrences.length < 2) continue;
      addCandidateOccurrences({ occurrencesByCandidateText, text, occurrences });
    }
  }

  return [...occurrencesByCandidateText.entries()]
    .map(([text, occurrencesByLocation]) => {
      const occurrences = [...occurrencesByLocation.values()];
      const serializedTextBytes = getUtf8ByteLength({ value: JSON.stringify(text) });
      // Even in the best case, every occurrence needs at least d[0], while the
      // first dictionary item needs the self-contained arrow-function wrapper.
      // This remains an upper bound; acceptance later measures exact JavaScript.
      const estimatedSavingBytes = (occurrences.length - 1) * serializedTextBytes
        - occurrences.length * getUtf8ByteLength({ value: 'd[0]' })
        - getUtf8ByteLength({ value: '(d=>)([])' });
      return { text, occurrences, estimatedSavingBytes };
    })
    .filter(({ estimatedSavingBytes }) => estimatedSavingBytes > 0)
    .sort((left, right) => right.estimatedSavingBytes - left.estimatedSavingBytes);
}

function overlapsSelectedOccurrence({ occurrence, selectedOccurrences }: {
  occurrence: LicenseTextOccurrence,
  selectedOccurrences: readonly SelectedLicenseTextOccurrence[],
}): boolean {
  return selectedOccurrences.some((selectedOccurrence) => (
    occurrence.start < selectedOccurrence.end && occurrence.end > selectedOccurrence.start
  ));
}

function selectAvailableOccurrences({ candidate, selectedOccurrencesByDependency }: {
  candidate: LicenseTextCandidate,
  selectedOccurrencesByDependency: readonly (readonly SelectedLicenseTextOccurrence[])[],
}): readonly LicenseTextOccurrence[] {
  const occurrencesByDependency = new Map<number, LicenseTextOccurrence[]>();
  for (const occurrence of candidate.occurrences) {
    if (overlapsSelectedOccurrence({
      occurrence,
      selectedOccurrences: selectedOccurrencesByDependency[occurrence.dependencyIndex] ?? [],
    })) {
      continue;
    }
    const occurrences = occurrencesByDependency.get(occurrence.dependencyIndex);
    if (occurrences === undefined) {
      occurrencesByDependency.set(occurrence.dependencyIndex, [occurrence]);
    } else {
      occurrences.push(occurrence);
    }
  }

  const selected: LicenseTextOccurrence[] = [];
  for (const occurrences of occurrencesByDependency.values()) {
    occurrences.sort((left, right) => left.start - right.start || right.end - left.end);
    let previousEnd = -1;
    for (const occurrence of occurrences) {
      if (occurrence.start < previousEnd) continue;
      selected.push(occurrence);
      previousEnd = occurrence.end;
    }
  }
  return selected;
}

function serializeLicenseTextExpression({ text, selectedOccurrences }: {
  text: string,
  selectedOccurrences: readonly SelectedLicenseTextOccurrence[],
}): string {
  if (selectedOccurrences.length === 0) return JSON.stringify(text);
  const parts: string[] = [];
  let offset = 0;
  for (const occurrence of selectedOccurrences) {
    if (occurrence.start > offset) parts.push(JSON.stringify(text.slice(offset, occurrence.start)));
    parts.push(`${dictionaryVariableName}[${occurrence.dictionaryIndex}]`);
    offset = occurrence.end;
  }
  if (offset < text.length) parts.push(JSON.stringify(text.slice(offset)));
  return parts.length === 0 ? JSON.stringify('') : parts.join('+');
}

function getAdditionalDictionaryBytes({ dictionary, candidateText }: {
  dictionary: readonly string[],
  candidateText: string,
}): number {
  const serializedCandidate = JSON.stringify(candidateText);
  // With the first entry, the expression changes from ARRAY to
  // (d=>ARRAY)([ENTRY]). Later entries only add a comma and one string.
  return dictionary.length === 0
    ? getUtf8ByteLength({ value: `(d=>)([${serializedCandidate}])` })
    : getUtf8ByteLength({ value: `,${serializedCandidate}` });
}

function createCompressionPlan({ dependencies }: {
  dependencies: readonly BuildLicenseDependency[],
}): CompressionPlan {
  const selectedOccurrencesByDependency: SelectedLicenseTextOccurrence[][] = dependencies.map(() => []);
  const currentExpressions = dependencies.map((dependency) => (
    dependency.licenseText === null ? 'null' : JSON.stringify(dependency.licenseText)
  ));
  const dictionary: string[] = [];

  // Greedily consider the largest estimated savings first, then recalculate the
  // exact affected expressions after earlier choices have occupied text ranges.
  // This avoids an expensive global set-packing search while never accepting a
  // dictionary entry that makes the final JavaScript larger.
  for (const candidate of createLicenseTextCandidates({ dependencies })) {
    const availableOccurrences = selectAvailableOccurrences({
      candidate,
      selectedOccurrencesByDependency,
    });
    if (availableOccurrences.length < 2) continue;
    const dictionaryIndex = dictionary.length;
    const affectedDependencyIndices = [...new Set(
      availableOccurrences.map((occurrence) => occurrence.dependencyIndex),
    )];
    const proposedOccurrencesByDependency = new Map<number, SelectedLicenseTextOccurrence[]>();
    let previousExpressionBytes = 0;
    let proposedExpressionBytes = 0;
    for (const dependencyIndex of affectedDependencyIndices) {
      previousExpressionBytes += getUtf8ByteLength({ value: currentExpressions[dependencyIndex] ?? '' });
      const proposedOccurrences = [
        ...(selectedOccurrencesByDependency[dependencyIndex] ?? []),
        ...availableOccurrences
          .filter((occurrence) => occurrence.dependencyIndex === dependencyIndex)
          .map((occurrence) => ({ ...occurrence, dictionaryIndex })),
      ].sort((left, right) => left.start - right.start);
      proposedOccurrencesByDependency.set(dependencyIndex, proposedOccurrences);
      const licenseText = dependencies[dependencyIndex]?.licenseText;
      if (licenseText === null || licenseText === undefined) continue;
      proposedExpressionBytes += getUtf8ByteLength({
        value: serializeLicenseTextExpression({ text: licenseText, selectedOccurrences: proposedOccurrences }),
      });
    }
    const additionalDictionaryBytes = getAdditionalDictionaryBytes({
      dictionary,
      candidateText: candidate.text,
    });
    if (previousExpressionBytes <= proposedExpressionBytes + additionalDictionaryBytes) continue;

    dictionary.push(candidate.text);
    for (const dependencyIndex of affectedDependencyIndices) {
      const proposedOccurrences = proposedOccurrencesByDependency.get(dependencyIndex);
      const licenseText = dependencies[dependencyIndex]?.licenseText;
      if (proposedOccurrences === undefined || licenseText === null || licenseText === undefined) continue;
      selectedOccurrencesByDependency[dependencyIndex] = proposedOccurrences;
      currentExpressions[dependencyIndex] = serializeLicenseTextExpression({
        text: licenseText,
        selectedOccurrences: proposedOccurrences,
      });
    }
  }

  return { dictionary, selectedOccurrencesByDependency };
}

function serializeLicenseArray({ dependencies, plan }: {
  dependencies: readonly BuildLicenseDependency[],
  plan: CompressionPlan,
}): string {
  const records = dependencies.map((dependency, dependencyIndex) => {
    const licenseText = dependency.licenseText === null
      ? 'null'
      : serializeLicenseTextExpression({
        text: dependency.licenseText,
        selectedOccurrences: plan.selectedOccurrencesByDependency[dependencyIndex] ?? [],
      });
    return `{name:${JSON.stringify(dependency.name)},version:${JSON.stringify(dependency.version)},license:${JSON.stringify(dependency.license)},licenseText:${licenseText}}`;
  });
  return `[${records.join(',')}]`;
}

export function serializeLicenseDependencies({ dependencies }: {
  dependencies: readonly BuildLicenseDependency[],
}): string {
  const plan = createCompressionPlan({ dependencies });
  const licenseArray = serializeLicenseArray({ dependencies, plan });
  if (plan.dictionary.length === 0) return licenseArray;

  // Emit normal JavaScript concatenations instead of a generic runtime decoder.
  // The generated virtual module is therefore portable and self-contained: it
  // needs only its local dictionary, evaluates directly to NaidanLicense[], and
  // exposes no compression format or reconstruction helper to application code.
  return `(${dictionaryVariableName}=>${licenseArray})(${JSON.stringify(plan.dictionary)})`;
}
