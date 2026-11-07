export function workflow__value_sources({ sources }: { sources: readonly ('definition' | 'tool_output' | 'model_output' | 'file_input' | 'interactive_input' | 'unknown')[] }): string {
  const labels = {
    tool_output: '도구 결과',
    definition: "정의의 고정값",
    model_output: "모델 응답",
    file_input: "파일",
    interactive_input: "실행 중 입력",
    unknown: "알 수 없음",
  };
  return "값의 출처: " + sources.map(source => labels[source]).join(', ');
}
