export type ObjectKind = 'raw' | 'att';
const DIGEST = /^[a-f0-9]{64}(?![\s\S])/;
const GENERATION = /^[0-7][0-9A-HJKMNP-TV-Z]{25}(?![\s\S])/;

export function isObjectDigest(digest: string): boolean {
  return DIGEST.test(digest);
}

export function parseObjectKey(key: string): { kind: ObjectKind; digest: string; gen: string } | null {
  const [kind, digest, gen, ...rest] = key.split('/');
  if ((kind !== 'raw' && kind !== 'att') || !isObjectDigest(digest) || !GENERATION.test(gen) || rest.length) return null;
  return { kind, digest, gen };
}
