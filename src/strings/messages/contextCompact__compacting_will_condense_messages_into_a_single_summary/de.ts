export const contextCompact__compacting_will_condense_messages_into_a_single_summary = ({ count }: { count: number }): string => (
  `${count === 1 ? 'Beim Komprimieren wird die erste Nachricht' : `Beim Komprimieren werden die ersten ${count} Nachrichten`} zu einer einzigen Zusammenfassung verdichtet. Das reduziert die Token-Nutzung und bewahrt den wesentlichen Kontext.`
);
