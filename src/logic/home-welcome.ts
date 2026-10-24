import { idToRaw, type ChatGroupId, type ChatId } from '@/01-models/ids';

// Home shows a small selection of existing summaries, without sorting or
// mutating the sidebar's full collection.
export function selectHomeRecentItems<T extends { id: ChatId | ChatGroupId, updatedAt: number }>({ items }: { items: readonly T[] }): T[] {
  const recent: T[] = [];
  for (const item of items) {
    const index = recent.findIndex(candidate => item.updatedAt > candidate.updatedAt
      || (item.updatedAt === candidate.updatedAt && idToRaw({ id: item.id }) < idToRaw({ id: candidate.id })));
    if (index !== -1) {
      recent.splice(index, 0, item);
      if (recent.length > 3) {
        recent.pop();
      }
    } else if (recent.length < 3) {
      recent.push(item);
    }
  }
  return recent;
}

export function homeDateCategory({ timestamp, now }: { timestamp: number, now: number }): 'today' | 'yesterday' | 'date' {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (timestamp >= today.getTime() && timestamp < tomorrow.getTime()) {
    return 'today';
  }
  return timestamp >= yesterday.getTime() && timestamp < today.getTime() ? 'yesterday' : 'date';
}

export function nextHomeDateChange({ now }: { now: number }): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
