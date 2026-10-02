import {
  isSecretKey,
  SECRET_REDACTION_CENSOR,
} from '../security/secret-redaction';

const MIN_LITERAL_SECRET_LENGTH = 4;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function collectSecrets(value: unknown, parentKey?: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSecrets(item, parentKey));
  }
  if (value === null || typeof value !== 'object') {
    if (
      parentKey &&
      isSecretKey(parentKey) &&
      typeof value === 'string' &&
      value.length >= MIN_LITERAL_SECRET_LENGTH
    ) {
      return [value];
    }
    return [];
  }

  return Object.entries(value).flatMap(([key, item]) =>
    collectSecrets(item, key),
  );
}

export function safeConnectorErrorMessage(
  error: unknown,
  ...secretSources: unknown[]
): string {
  let message = errorMessage(error);
  const secrets = secretSources
    .flatMap((source) => collectSecrets(source))
    .filter((secret, index, all) => all.indexOf(secret) === index)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    message = message.split(secret).join(SECRET_REDACTION_CENSOR);
  }

  return message
    .replace(
      /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._:-]+/g,
      `$1 ${SECRET_REDACTION_CENSOR}`,
    )
    .replace(
      /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/g,
      `$1${SECRET_REDACTION_CENSOR}$2`,
    )
    .replace(
      /\b(Password|Pwd|User Password|Access Token|Api Token|Private Key|Connection String)\s*=\s*[^;,\s]+/gi,
      `$1=${SECRET_REDACTION_CENSOR}`,
    );
}
