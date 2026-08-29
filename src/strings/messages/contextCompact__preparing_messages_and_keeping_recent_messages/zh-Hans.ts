export const contextCompact__preparing_messages_and_keeping_recent_messages = ({ compactedMessageCount, suffixMessageCount }: { compactedMessageCount: number; suffixMessageCount: number }): string => (
  `正在准备 ${compactedMessageCount} 条消息，并保留最近的 ${suffixMessageCount} 条。`
);
