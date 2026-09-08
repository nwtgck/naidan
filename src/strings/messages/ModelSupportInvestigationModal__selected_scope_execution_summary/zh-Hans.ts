export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "正在调查所选范围。可以导出已收集的证据。";
  case 'completed': return "所选范围的调查已结束。请查看结果和证据的验证范围。";
  case 'interrupted': return "调查在完成前已停止。可以查看已收集的证据。";
  case 'unknown': return "尚未记录调查执行完成。";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
