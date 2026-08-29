export const StorageTab__failed_to_enable_persistence = ({ errorMessage }: { errorMessage: string }): string => (
  `Beim Aktivieren des persistenten Speichers ist ein Fehler aufgetreten: ${errorMessage}`
);
