export const StorageTab__failed_to_migrate_data = ({ errorMessage }: { errorMessage: string }): string => (
  `Daten konnten nicht migriert werden. ${errorMessage}`
);
