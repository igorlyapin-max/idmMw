import { createHmac, timingSafeEqual } from 'crypto';

const COMPARISON_KEY = 'idmmw-fixed-length-comparison-v1';

export function fixedLengthFingerprint(value: string, purpose: string): string {
  return createHmac('sha256', COMPARISON_KEY)
    .update(purpose)
    .update('\0')
    .update(value)
    .digest('base64url');
}

export function safeEqualFixedLength(
  a: string,
  b: string,
  purpose: string,
): boolean {
  const left = Buffer.from(fixedLengthFingerprint(a, purpose), 'base64url');
  const right = Buffer.from(fixedLengthFingerprint(b, purpose), 'base64url');
  return timingSafeEqual(left, right);
}
