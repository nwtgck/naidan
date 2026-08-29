export const contextCompact__preparing_messages_and_keeping_recent_messages = ({ compactedMessageCount, suffixMessageCount }: { compactedMessageCount: number; suffixMessageCount: number }): string => (
  `${compactedMessageCount} ${compactedMessageCount === 1 ? 'Nachricht wird' : 'Nachrichten werden'} vorbereitet, ${suffixMessageCount} ${suffixMessageCount === 1 ? 'aktuelle bleibt' : 'aktuelle bleiben'} erhalten.`
);
