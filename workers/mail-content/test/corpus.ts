import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

export interface Vector {
  id: string;
  html: string;
  ri?: boolean;
  verdict?: 'phishing';
  refs?: number;
  hrefs?: number;
  has?: string;
  absent?: string;
  text?: string;
  overlay?: true;
}

export const vectors = (JSON.parse(readFileSync(new URL('./corpus/vectors.json', import.meta.url), 'utf8')) as Vector[]).map(vector => ({
  ...vector,
  html: vector.html.replace('{{largeImage}}', () => 'AAAA'.repeat(24_000))
    .replace('{{manyImages}}', () => Array.from({ length: 103 }, (_, i) => `<img src="https://sender.example/${i}">`).join('')),
}));
