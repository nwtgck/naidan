import type { LocalModel } from '@/features/llama-cpp-browser/types';

/** Pure, transactional resolution. Never fetch on paste, guess a model by a
 * basename, or silently discard unresolved/ambiguous lines. */
export function resolvePerformanceModelInput({ text, models, selected }: {
  text: string, models: Pick<LocalModel, 'modelId'>[], selected: string[],
}): { selected: string[], errors: string[] } {
  if (text.length > 32768) {
    return { selected, errors: ['Model input exceeds 32,768 characters.'] };
  }
  const result = [...new Set(selected)], errors: string[] = [];
  const known = new Map<string, number>();
  for (const model of models) {
    known.set(model.modelId, (known.get(model.modelId) ?? 0) + 1);
  }
  for (const id of result) {
    if (known.get(id) !== 1) {
      errors.push(`${known.has(id) ? 'Ambiguous modelId' : 'Model is not stored here; import it first'}: ${id.slice(0, 200)}`);
    }
  }
  const included = new Set(result);
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const matches = known.get(line) ?? 0;
    if (matches !== 1) {
      errors.push(`Line ${index + 1}: ${matches ? 'Ambiguous modelId' : 'Model is not stored here; import it first'}: ${line.slice(0, 200)}`);
    } else if (!included.has(line)) {
      result.push(line);
      included.add(line);
    }
  }
  return errors.length ? { selected, errors } : { selected: result, errors: [] };
}

export const TEST_ONLY = {
};
