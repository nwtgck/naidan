export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `This will delete data matched by ${selectedCount} selected selector(s) for this origin. Current storage provider: ${storageType}.`
);
