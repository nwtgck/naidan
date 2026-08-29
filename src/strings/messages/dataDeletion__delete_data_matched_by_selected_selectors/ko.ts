export const dataDeletion__delete_data_matched_by_selected_selectors = ({ selectedCount, storageType }: { selectedCount: number; storageType: string }): string => (
  `이 출처에서 선택한 선택기 ${selectedCount}개와 일치하는 데이터가 삭제됩니다. 현재 저장소 프로바이더: ${storageType}.`
);
