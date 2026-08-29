export const StorageTab__failed_to_migrate_data = ({ errorMessage }: { errorMessage: string }): string => (
  `No se pudieron migrar los datos. ${errorMessage}`
);
