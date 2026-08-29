export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `这将删除此来源中与所选 ${selectedCount} 个选择器匹配的数据。当前存储提供程序：${storageType}。`
);
