const period = 60;

// Verification expectations only. The deployed configuration controls the limits.
export const EXPECTED_BUCKETS = {
  reads: { binding: 'MAIL_RATE_READS', limit: 600, period },
  writes: { binding: 'MAIL_RATE_WRITES', limit: 120, period },
  uploads: { binding: 'MAIL_RATE_UPLOADS', limit: 64, period },
  sends: { binding: 'MAIL_RATE_SENDS', limit: 20, period },
  undo: { binding: 'MAIL_RATE_UNDO', limit: 10, period },
  undo_flood: { binding: 'MAIL_RATE_UNDO_FLOOD', limit: 600, period },
  admin_writes: { binding: 'MAIL_RATE_ADMIN_WRITES', limit: 60, period },
} as const;

export type Bucket = keyof typeof EXPECTED_BUCKETS;
export const bucketNames = Object.keys(EXPECTED_BUCKETS) as Bucket[];

export function isBucket(value: string): value is Bucket {
  return Object.hasOwn(EXPECTED_BUCKETS, value);
}
