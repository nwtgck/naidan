export const StorageTab__confirm_switch_to_storage = ({ storageName }: { storageName: string }): string => (
  `저장소를 전환하시겠습니까? 대상: ${storageName}. 모든 데이터가 마이그레이션되고 애플리케이션이 다시 로드됩니다.`
);
