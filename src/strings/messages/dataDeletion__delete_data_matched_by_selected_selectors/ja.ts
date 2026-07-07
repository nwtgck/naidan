export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `このoriginで${selectedCount}個のselectorに一致するデータを削除します。現在のstorage provider: ${storageType}.`
);
