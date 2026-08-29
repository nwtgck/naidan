export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `Esto eliminará los datos que coincidan con ${selectedCount} ${selectedCount === 1 ? 'selector seleccionado' : 'selectores seleccionados'} para este origen. Proveedor de almacenamiento actual: ${storageType}.`
);
