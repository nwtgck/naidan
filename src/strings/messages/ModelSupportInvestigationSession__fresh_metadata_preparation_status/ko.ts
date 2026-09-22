export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "새로 가져온 메타데이터 준비: 실행 중";
  case 'prepared': return "새로 가져온 메타데이터 준비: 성공";
  case 'failed': return "새로 가져온 메타데이터 준비: 실패";
  case 'timeout': return "새로 가져온 메타데이터 준비: 시간 초과";
  case 'interrupted': return "새로 가져온 메타데이터 준비: 중단됨";
  case 'not-run': return "새로 가져온 메타데이터 준비: 실행하지 않음";
  case 'not-recorded': return "새로 가져온 메타데이터 준비: 기록 없음";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
