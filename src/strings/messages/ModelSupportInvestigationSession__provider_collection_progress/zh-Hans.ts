export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"准备中","loading":"正在加载本地模型","running":"正在执行固定请求","collecting":"正在收集内部记录","sealing":"正在准备证据文件","cleanup":"等待 Worker 清理","seal-release":"等待释放记录所有权","finished":"收集结束"};
  return `${labels[phase]} · ${settled}/${total} 个请求已结束${active === undefined ? "" : ` · ${active}`}`;
};
