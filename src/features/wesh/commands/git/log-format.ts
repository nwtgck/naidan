
export function parseAuthorForLog({ author }: {
    author: string;
}): {
    identity: string;
    timestamp: number;
    timezone: string;
} {
  const match = /^(.* <[^>]*>) ([0-9]+) ([+-][0-9]{4})$/u.exec(author);
  if (match === null)
    return { identity: author, timestamp: 0, timezone: '+0000' };
  return { identity: match[1]!, timestamp: Number.parseInt(match[2]!, 10), timezone: match[3]! };
}
export function formatLogDate({ timestamp, timezone }: {
    timestamp: number;
    timezone: string;
}): string {
  const sign = timezone.startsWith('-') ? -1 : 1;
  const hours = Number.parseInt(timezone.slice(1, 3), 10);
  const minutes = Number.parseInt(timezone.slice(3, 5), 10);
  const adjusted = new Date((timestamp + sign * (hours * 60 + minutes) * 60) * 1000);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[adjusted.getUTCDay()]} ${months[adjusted.getUTCMonth()]} ${adjusted.getUTCDate()} ${adjusted.getUTCHours().toString().padStart(2, '0')}:${adjusted.getUTCMinutes().toString().padStart(2, '0')}:${adjusted.getUTCSeconds().toString().padStart(2, '0')} ${adjusted.getUTCFullYear()} ${timezone}`;
}

export const TEST_ONLY = {
};
