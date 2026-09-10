export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"보관된 내부 기록 없음","partial":"명시적 누락이 있는 기록","recorded":"제한된 기록에서 추가 누락이 감지되지 않음"};
  return `내부 기록: ${labels[recording]}. 기록과 완료된 요청은 응답의 정확성이나 완전한 재현을 보장하지 않습니다.`;
};
