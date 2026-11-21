export type ModelSelectorItem = {
  id: string,
  label: string,
  description: string | undefined,
  availability: 'local' | 'download_required' | 'remote' | 'checking',
};

export const TEST_ONLY = {
};
