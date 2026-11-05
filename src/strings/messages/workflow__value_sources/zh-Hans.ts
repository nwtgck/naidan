export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: "工具结果",
    definition: "定义中的固定值",
    model_output: "模型回复",
    file_input: "文件",
    interactive_input: "运行时输入",
    unknown: "未知来源",
  };
  return "值的来源：" + sources.map(source => labels[source]).join(', ');
}
