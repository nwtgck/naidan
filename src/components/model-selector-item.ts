export type ModelSelectorItem = {
  id: string,
  label: string,
  description: string | undefined,
  availability: 'local' | 'download_required' | 'remote' | 'checking',
};

/** Search relaxes model-name punctuation while preserving the original IDs. */
export function modelSearchFilter({ query }: { query: string }): ({ fields }: { fields: readonly (string | undefined)[] }) => boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean).map(term => ({ term, compact: term.replace(/[-_]/g, '') }));
  return ({ fields }) => {
    const text = fields.join(' ').toLowerCase();
    const compact = text.replace(/[-_]/g, '');
    return terms.every(term => text.includes(term.term) || (term.compact !== '' && compact.includes(term.compact)));
  };
}

export const TEST_ONLY = {
};
