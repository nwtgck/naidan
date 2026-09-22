export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "선택한 범위를 조사 중입니다. 수집한 증거를 내보낼 수 있습니다.";
  case 'completed': return "선택한 범위의 조사가 끝났습니다. 결과와 증거의 검증 범위를 확인하세요.";
  case 'interrupted': return "조사가 완료 전에 중단되었습니다. 수집한 증거를 확인할 수 있습니다.";
  case 'unknown': return "조사 실행 완료가 기록되지 않았습니다.";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
