export const contextCompact__preparing_messages_and_keeping_recent_messages = ({ compactedMessageCount, suffixMessageCount }: { compactedMessageCount: number; suffixMessageCount: number }): string => (
  `${compactedMessageCount}件のメッセージを準備し、直近${suffixMessageCount}件を残します。`
);
