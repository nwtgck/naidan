export const DeveloperTab__reset_data_provider_warning = ({ storageType }: { storageType: string }): string => (
  `이 작업은 취소할 수 없습니다. ${storageType} 프로바이더에 저장된 모든 채팅 기록, 채팅 그룹 및 설정이 영구적으로 삭제됩니다.`
);
