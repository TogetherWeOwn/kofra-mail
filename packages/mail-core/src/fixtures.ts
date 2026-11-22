import type { Address, Attachment, Conversation, DriveFile, Identity, Label, MailboxId } from './index.ts';

export const identities: Identity[] = [
  { name: 'Alex Morgan', email: 'alex@example.com', primary: true },
  { name: 'Alex Morgan', email: 'hello@example.com', primary: false }
];
export const labels: Label[] = [
  { id: 'projects', name: 'Projects' }, { id: 'finance', name: 'Finance' },
  { id: 'family', name: 'Family' }, { id: 'travel', name: 'Travel' }
];
export const attachments: Attachment[] = [
  { id: 'plan', name: 'floor-plan-notes.txt', size: 38, type: 'text/plain' },
  { id: 'budget', name: 'renovation-budget.csv', size: 22, type: 'text/csv' }
];
export const driveFiles: DriveFile[] = [
  { id: 'drive-plan', name: 'floor-plan-v3.txt', size: 18, type: 'text/plain' },
  { id: 'drive-budget', name: 'renovation-budget.csv', size: 18, type: 'text/csv' },
  { id: 'drive-checklist', name: 'site-checklist.txt', size: 18, type: 'text/plain' }
];

const sample: Array<[string, string, string, string, string, boolean, string[], MailboxId?]> = [
  ['plan', 'Mira Chen', 'mira', 'Floor plan revisions', 'Hi Alex,\n\nI’ve attached the latest floor plan notes and budget. Could you take a look before Tuesday? I’ve highlighted the kitchen changes and updated the measurements.\n\nThanks,\nMira', true, ['projects']],
  ['receipt', 'Northstar Studio', 'billing', 'Your November receipt', 'Your November payment went through. Thanks for working with us.', true, ['finance']],
  ['dinner', 'Sam Taylor', 'sam', 'Dinner on Sunday?', 'Would you like to join us for dinner on Sunday? Let’s say around six.', true, ['family']],
  ['travel', 'Cedar Rail', 'tickets', 'Your ticket confirmation', 'Your booking is confirmed. Check in fifteen minutes before departure.', false, ['travel']],
  ['visit', 'Jordan Park', 'jordan', 'Site visit next week', 'Wednesday morning works for everyone. Let’s meet at the north entrance.', false, ['projects']],
  ['notes', 'Riley Shaw', 'riley', 'Notes from Thursday', 'Here are the next steps we discussed. Let me know if I missed anything.', false, []],
  ['hello', 'Tess Avery', 'tess', 'Checking in', 'It was good to see you last week. Let’s do it again soon.', false, []],
  ['prize', 'Rewards Desk', 'rewards', 'Claim your prize today', 'You have been selected to claim a prize. This is a fake spam fixture.', true, [], 'spam'],
  ['old', 'Casey Reed', 'casey', 'Old calendar invite', 'This invitation was superseded.', false, [], 'trash']
];

export function seed(now: number): Conversation[] {
  return sample.map(([id, name, local, subject, text, unread, labelIds, mailboxId = 'inbox'], i) => {
    const from: Address = { name, email: `${local}@example.com` };
    const date = new Date(Date.UTC(2026, 10, 22 - i, 14, 36)).toISOString();
    const recipient = identities[id === 'plan' ? 1 : 0];
    const to = [{ name: recipient.name, email: recipient.email }];
    const linked: Attachment = { id: 'site-notes', name: 'Site notes', type: 'text/plain', size: 0, link: 'https://example.com/drive/site-notes' };
    const message = { id: `${id}-latest`, from, to, date, subject, text, attachments: id === 'plan' ? attachments : id === 'visit' ? [linked] : [], remoteImages: id === 'plan' || id === 'prize', hasHtml: id === 'plan' };
    const messages = id === 'plan' ? [{ ...message, id: 'plan-first', date: '2026-11-19T13:00:00.000Z', text: 'Hi Alex, I’ll send over the revised drawings this week.', attachments: [], remoteImages: false, hasHtml: false }, message] : [message];
    return { id, subject, from, date, snippet: text.replace(/\s+/g, ' '), unread, labelIds, mailboxId, starred: id === 'visit', messages, count: messages.length, hasAttachments: message.attachments.length > 0, ...(['spam', 'trash'].includes(mailboxId) ? { expiresAt: now + 30 * 86400_000 } : {}) };
  });
}
