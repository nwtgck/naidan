export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "新規取得によるメタデータ準備: 実行中";
  case 'prepared': return "新規取得によるメタデータ準備: 成功";
  case 'failed': return "新規取得によるメタデータ準備: 失敗";
  case 'timeout': return "新規取得によるメタデータ準備: 時間切れ";
  case 'interrupted': return "新規取得によるメタデータ準備: 中断";
  case 'not-run': return "新規取得によるメタデータ準備: 未実行";
  case 'not-recorded': return "新規取得によるメタデータ準備: 記録なし";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
