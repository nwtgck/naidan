export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"준비 중","loading":"로컬 모델 불러오는 중","running":"고정 요청 실행 중","collecting":"내부 기록 수집 중","sealing":"증거 파일 준비 중","cleanup":"Worker 정리 대기 중","seal-release":"기록 소유권 해제 대기 중","finished":"수집 종료"};
  return `${labels[phase]} · 요청 ${settled}/${total}개 종료${active === undefined ? "" : ` · ${active}`}`;
};
