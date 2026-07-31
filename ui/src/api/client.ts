import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';
const API_KEY = import.meta.env.VITE_API_KEY || '';

let csrfToken = '';

export const apiClient = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
  },
});

apiClient.interceptors.request.use((config) => {
  if (csrfToken && config.method && config.method.toUpperCase() !== 'GET') {
    config.headers['X-CSRF-Token'] = csrfToken;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const message = formatAxiosError(error);
    return Promise.reject(message ? new Error(message) : error);
  },
);

function formatAxiosError(error: unknown): string | null {
  if (!axios.isAxiosError(error)) {
    return null;
  }

  const status = error.response?.status;
  const message = extractResponseMessage(error.response?.data) ?? error.message;
  return status ? `${status}: ${message}` : message;
}

function extractResponseMessage(data: unknown): string | null {
  if (typeof data === 'string' && data.trim()) {
    return data;
  }

  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const payload = data as Record<string, unknown>;
  const message = payload['message'];
  if (typeof message === 'string' && message.trim()) {
    return message;
  }
  if (Array.isArray(message) && message.length > 0) {
    return message.map(String).join('; ');
  }

  const error = payload['error'];
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return null;
}

export function setCsrfToken(value: string): void {
  csrfToken = value;
}

export interface AuthSession {
  authEnabled: boolean;
  authenticated: boolean;
  mode: string;
  csrfToken?: string;
  user?: {
    sub: string;
    name: string;
    provider: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAuthSession(value: unknown): AuthSession {
  if (!isRecord(value)) {
    throw new Error('Invalid auth session response');
  }

  if (
    typeof value['authEnabled'] !== 'boolean' ||
    typeof value['authenticated'] !== 'boolean' ||
    typeof value['mode'] !== 'string'
  ) {
    throw new Error('Invalid auth session response');
  }

  return value as unknown as AuthSession;
}

export async function fetchAuthSession(): Promise<AuthSession> {
  const res = await apiClient.get('/auth/session');
  const session = parseAuthSession(res.data);
  setCsrfToken(session.csrfToken ?? '');
  return session;
}

export async function loginLocal(
  username: string,
  password: string,
): Promise<AuthSession> {
  const res = await apiClient.post('/auth/login', { username, password });
  const session = parseAuthSession(res.data);
  setCsrfToken(session.csrfToken ?? '');
  return session;
}

export async function loginSso(): Promise<AuthSession> {
  const res = await apiClient.post('/auth/sso-login');
  const session = parseAuthSession(res.data);
  setCsrfToken(session.csrfToken ?? '');
  return session;
}

export async function logout(): Promise<void> {
  await apiClient.post('/auth/logout');
  setCsrfToken('');
}

export interface DlqItem {
  id: string;
  eventId: string;
  operation: string;
  targetSystem: string;
  payload: Record<string, unknown>;
  error: string;
  retryCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchDlqItems(params?: {
  status?: string;
  targetSystem?: string;
  limit?: number;
  offset?: number;
}): Promise<DlqItem[]> {
  const res = await apiClient.get('/admin/dlq', { params });
  return res.data as DlqItem[];
}

export async function retryDlqItem(id: string): Promise<void> {
  await apiClient.post(`/admin/dlq/${id}/retry`);
}

export async function retryDlqItems(data: {
  targetSystem?: string;
  status?: string;
  limit?: number;
}): Promise<{
  requested: number;
  queued: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}> {
  const res = await apiClient.post('/admin/dlq/retry', data);
  return res.data as {
    requested: number;
    queued: number;
    skipped: number;
    errors: Array<{ id: string; error: string }>;
  };
}

export async function skipDlqItem(id: string): Promise<void> {
  await apiClient.post(`/admin/dlq/${id}/skip`);
}

export interface AdminStats {
  dlq: Record<string, number>;
  processedLast5Minutes: {
    total: number;
    byStatus: Record<string, number>;
    byTargetSystem: Record<string, Record<string, number>>;
  };
  infrastructure: {
    kafkaEnabled: boolean;
    redisEnabled: boolean;
    processingMode: string;
  };
}

export async function fetchAdminStats(): Promise<AdminStats> {
  const res = await apiClient.get('/admin/stats');
  return res.data as AdminStats;
}

export interface TargetSystem {
  id: string;
  name: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchTargetSystems(params?: {
  type?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<TargetSystem[]> {
  const res = await apiClient.get('/admin/target-systems', { params });
  return res.data as TargetSystem[];
}

export async function createTargetSystem(data: {
  name: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<TargetSystem> {
  const res = await apiClient.post('/admin/target-systems', data);
  return res.data as TargetSystem;
}

export async function updateTargetSystem(
  id: string,
  data: Partial<Omit<TargetSystem, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<TargetSystem> {
  const res = await apiClient.patch(`/admin/target-systems/${id}`, data);
  return res.data as TargetSystem;
}

export async function deleteTargetSystem(id: string): Promise<void> {
  await apiClient.delete(`/admin/target-systems/${id}`);
}

export async function testTargetSystemConnection(id: string): Promise<{
  success: boolean;
  message: string;
}> {
  const res = await apiClient.post(`/admin/target-systems/${id}/test`);
  return res.data as { success: boolean; message: string };
}
