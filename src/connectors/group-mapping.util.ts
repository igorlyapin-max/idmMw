export type GroupMappingMode = 'id' | 'name' | 'code';

export interface GroupMappingSettings {
  enabled: boolean;
  mode: GroupMappingMode;
}

export interface GroupMappingConfig {
  groupMappingEnabled?: boolean | string;
  groupMappingMode?: unknown;
}

interface GroupRefObject {
  id?: unknown;
  name?: unknown;
  code?: unknown;
}

export function booleanConfig(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === 'string' &&
      ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()))
  );
}

export function groupMappingSettings(
  config: GroupMappingConfig,
): GroupMappingSettings {
  return {
    enabled: booleanConfig(config.groupMappingEnabled),
    mode: groupMappingMode(config.groupMappingMode),
  };
}

export function groupMappingMode(value: unknown): GroupMappingMode {
  if (value === undefined || value === null || value === '') {
    return 'name';
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid groupMappingMode: expected id, name or code');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'id' || normalized === 'name' || normalized === 'code') {
    return normalized;
  }
  throw new Error('Invalid groupMappingMode: expected id, name or code');
}

export function groupRefValues(
  values: unknown,
  mode: GroupMappingMode,
  fieldName = 'groups',
): Array<string | number> {
  if (values === undefined || values === null || values === '') {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error(`Invalid ${fieldName}: expected array`);
  }
  return values
    .map((value) => groupRefValue(value, mode, fieldName))
    .filter((value): value is string | number => value !== undefined);
}

export function directGroupValues(
  values: unknown,
  fieldName = 'groups',
): Array<string | number> {
  if (values === undefined || values === null || values === '') {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error(`Invalid ${fieldName}: expected array`);
  }
  return values
    .map((value) => directGroupValue(value, fieldName))
    .filter((value): value is string | number => value !== undefined);
}

function groupRefValue(
  value: unknown,
  mode: GroupMappingMode,
  fieldName: string,
): string | number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid ${fieldName} item: expected string, number or object with id/name/code`,
    );
  }
  const ref = value as GroupRefObject;
  const selected = scalarGroupValue(ref[mode], `${fieldName}.${mode}`);
  if (selected === undefined) {
    throw new Error(`Invalid ${fieldName}.${mode}: expected string or number`);
  }
  return selected;
}

function directGroupValue(
  value: unknown,
  fieldName: string,
): string | number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid ${fieldName} item: expected string, number or object with id/name/code`,
    );
  }
  const ref = value as GroupRefObject;
  return (
    scalarGroupValue(ref.id, `${fieldName}.id`) ??
    scalarGroupValue(ref.name, `${fieldName}.name`) ??
    scalarGroupValue(ref.code, `${fieldName}.code`)
  );
}

function scalarGroupValue(
  value: unknown,
  fieldName: string,
): string | number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Invalid ${fieldName}: expected string or number`);
}
