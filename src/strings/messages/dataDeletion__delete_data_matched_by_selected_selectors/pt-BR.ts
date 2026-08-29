export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `Isso excluirá os dados correspondentes a ${selectedCount} ${selectedCount === 1 ? 'seletor selecionado' : 'seletores selecionados'} para esta origem. Provedor de armazenamento atual: ${storageType}.`
);
