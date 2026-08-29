export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `Dadurch werden Daten gelöscht, die für diesen Ursprung mit ${selectedCount} ${selectedCount === 1 ? 'ausgewähltem Selektor' : 'ausgewählten Selektoren'} übereinstimmen. Aktueller Speicheranbieter: ${storageType}.`
);
