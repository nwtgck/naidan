import type { LocalModel } from '@/features/llama-cpp-browser/types';

/** Pure, transactional resolution. Never fetch on paste, guess a model by a
 * basename, or silently discard unresolved/ambiguous lines. */
export function resolvePerformanceModelInput({ text, models, selected }: {
  text: string, models: Pick<LocalModel, 'modelId'>[], selected: string[],
}): { selected: string[], errors: string[] } {
  if (text.length > 32768) {
    return { selected, errors: ['Model input exceeds 32,768 characters.'] };
  }
  const result = [...selected], errors: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const matches = models.filter(model => model.modelId === line);
    if (matches.length !== 1) {
      errors.push(`Line ${index + 1}: ${matches.length ? 'Ambiguous modelId' : 'Model is not stored here; import it first'}: ${line.slice(0, 200)}`);
    } else if (!result.includes(matches[0]!.modelId)) {
      result.push(matches[0]!.modelId);
    }
  }
  if (result.length > 16) {
    errors.push('Select at most 16 models.');
  }
  return errors.length ? { selected, errors } : { selected: result, errors: [] };
}

export const TEST_ONLY = {
};
