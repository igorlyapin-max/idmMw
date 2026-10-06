export const SECRET_REDACTION_CENSOR = '[REDACTED]';
export const MASKED_SECRET_VALUE = '***';

const SECRET_KEY_RE =
  /(^|[_\-.])(password|passwd|pwd|token|secret|authorization|cookie|credential|connection[-_]?string|connectionString|api[-_]?key|apiKey|api[-_]?token|apiToken|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|master[-_]?key|masterKey|master[-_]?key[-_]?hash|masterKeyHash|private[-_]?key|privateKey|wallet[-_]?password|walletPassword|cert|ca|pem|key|new[-_]?value|newValue|old[-_]?value|oldValue|value)$/i;

const MASKED_PLACEHOLDERS = new Set([
  MASKED_SECRET_VALUE,
  '*** preserved ***',
  SECRET_REDACTION_CENSOR,
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function isMaskedSecretValue(value: unknown): boolean {
  return typeof value === 'string' && MASKED_PLACEHOLDERS.has(value.trim());
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) ? MASKED_SECRET_VALUE : redactSecrets(item),
    ]),
  );
}

export function mergeConfigPreservingSecrets(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };

  for (const [key, currentValue] of Object.entries(current)) {
    const hasIncoming = Object.prototype.hasOwnProperty.call(incoming, key);
    const incomingValue = incoming[key];

    if (isSecretKey(key)) {
      if (!hasIncoming || isMaskedSecretValue(incomingValue)) {
        merged[key] = currentValue;
      }
      continue;
    }

    if (
      hasIncoming &&
      incomingValue !== null &&
      typeof incomingValue === 'object' &&
      !Array.isArray(incomingValue) &&
      currentValue !== null &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue)
    ) {
      merged[key] = mergeConfigPreservingSecrets(
        currentValue as Record<string, unknown>,
        incomingValue as Record<string, unknown>,
      );
    }
  }

  return merged;
}
