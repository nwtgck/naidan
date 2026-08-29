export const StorageTab__failed_to_migrate_data = ({ errorMessage }: { errorMessage: string }): string => (
  `데이터 마이그레이션에 실패했습니다. ${errorMessage}`
);
