export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "重新获取元数据后的准备: 进行中";
  case 'prepared': return "重新获取元数据后的准备: 成功";
  case 'failed': return "重新获取元数据后的准备: 失败";
  case 'timeout': return "重新获取元数据后的准备: 超时";
  case 'interrupted': return "重新获取元数据后的准备: 已中断";
  case 'not-run': return "重新获取元数据后的准备: 未运行";
  case 'not-recorded': return "重新获取元数据后的准备: 无记录";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
