export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "選択した範囲を調査中です。収集済みの証拠を出力できます。";
  case 'completed': return "選択した範囲の調査が終了しました。結果と証拠の検証範囲を確認してください。";
  case 'interrupted': return "調査は完了前に停止しました。収集済みの証拠を確認できます。";
  case 'unknown': return "調査の実行完了は記録されていません。";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
