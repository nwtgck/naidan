export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: 'ツールの結果',
    definition: "定義内の固定値",
    model_output: "モデルの回答",
    file_input: "ファイル",
    interactive_input: "実行中の入力",
    unknown: "出所不明",
  };
  return "値の出所：" + sources.map(source => labels[source]).join(', ');
}
