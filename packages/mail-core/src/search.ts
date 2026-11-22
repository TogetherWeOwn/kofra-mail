import type { Conversation, Label, Message } from './index.ts';

const operators = new Set(['from', 'to', 'subject', 'label', 'has', 'before', 'after', 'larger']);
const normalize = (s: string) => s.toLowerCase();
const contains = (haystack: string, needle: string) => normalize(haystack).includes(needle);

function terms(query: string): [string, string][] {
  return Array.from(query.matchAll(/(?:([a-z]+):)?(?:"([^"]+)"|([^\s"]+))/gi), ([raw, key, quoted, word]) => {
    const op = normalize(key ?? '');
    return operators.has(op) ? [op, normalize(quoted ?? word)] : ['', normalize(key ? raw : quoted ?? word)];
  });
}

function size(value: string): number {
  const match = /^(\d+)([km])?(?:b)?$/.exec(value);
  if (!match) return Infinity;
  return Number(match[1]) * (match[2] === 'm' ? 1024 ** 2 : match[2] === 'k' ? 1024 : 1);
}

export function matchesQuery(thread: Conversation, query: string, labels: Label[]): boolean {
  const filters = terms(query);
  function matches(message: Message, op: string, value: string): boolean {
    switch (op) {
      case 'from': return contains(`${message.from.name} ${message.from.email}`, value);
      case 'to': return message.to.some((a) => contains(`${a.name} ${a.email}`, value));
      case 'subject': return contains(message.subject, value);
      case 'label': return labels.some((l) => thread.labelIds.includes(l.id) && normalize(l.name) === value);
      case 'has': return value === 'attachment' && message.attachments.length > 0;
      case 'before':
      case 'after': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [year, month, day] = value.split('-').map(Number);
        const boundary = new Date(0);
        boundary.setHours(0, 0, 0, 0);
        boundary.setFullYear(year, month - 1, day);
        if (boundary.getFullYear() !== year || boundary.getMonth() !== month - 1 || boundary.getDate() !== day) return false;
        const date = Date.parse(message.date);
        return op === 'before' ? date < boundary.getTime() : date >= boundary.getTime();
      }
      case 'larger': return new TextEncoder().encode(message.text).length + message.attachments.reduce((sum, file) => sum + file.size, 0) > size(value);
      default: return contains(`${message.subject} ${message.text} ${message.from.name} ${message.from.email} ${message.attachments.map((file) => file.name).join(' ')}`, value);
    }
  }
  return thread.messages.some((message) => filters.every(([op, value]) => matches(message, op, value)));
}
