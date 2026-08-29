export const contextCompact__compacting_will_condense_messages_into_a_single_summary = ({ count }: { count: number }): string => (
  `压缩会将前 ${count} 条消息浓缩为一份摘要，从而减少 token 使用量，同时保留核心上下文。`
);
