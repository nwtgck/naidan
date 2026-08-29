export const contextCompact__preparing_messages_and_keeping_recent_messages = ({ compactedMessageCount, suffixMessageCount }: { compactedMessageCount: number; suffixMessageCount: number }): string => (
  `메시지 ${compactedMessageCount}개를 준비하고 최근 ${suffixMessageCount}개를 유지합니다.`
);
