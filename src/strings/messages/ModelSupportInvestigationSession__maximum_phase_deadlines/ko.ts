export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `최대 대기 시간: 요청 ${runSeconds}초, 수집 ${collectionSeconds}초, 증거 준비 ${sealingSeconds}초, 정리 ${cleanupSeconds}초. 예상 소요 시간이 아닌 안전 한도입니다.`
);
