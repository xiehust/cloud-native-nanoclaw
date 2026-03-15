import { getAuthToken } from './auth';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

// Types (simplified from shared, for frontend use)
export interface Bot {
  botId: string;
  name: string;
  description?: string;
  status: string;
  triggerPattern: string;
  createdAt: string;
}

export interface ChannelConfig {
  botId: string;
  channelType: string;
  channelId: string;
  status: string;
  healthStatus: string;
  webhookUrl: string;
  createdAt: string;
}

export interface Group {
  botId: string;
  groupJid: string;
  name: string;
  channelType: string;
  isGroup: boolean;
  lastMessageAt: string;
}

export interface Message {
  messageId: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
}

export interface ScheduledTask {
  taskId: string;
  groupJid: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  status: string;
  nextRun?: string;
  lastRun?: string;
}

export interface CreateBotRequest {
  name: string;
  description?: string;
  triggerPattern?: string;
}

export interface CreateChannelRequest {
  channelType: string;
  credentials: Record<string, string>;
}

export interface CreateTaskRequest {
  groupJid: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
}

export interface UpdateTaskRequest {
  status?: string;
  prompt?: string;
}

// Bot API
export const bots = {
  list: () => request<Bot[]>('/bots'),
  get: (botId: string) => request<Bot>(`/bots/${botId}`),
  create: (data: CreateBotRequest) => request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  update: (botId: string, data: Partial<Bot>) => request<Bot>(`/bots/${botId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (botId: string) => request<void>(`/bots/${botId}`, { method: 'DELETE' }),
};

// Channel API
export const channels = {
  list: (botId: string) => request<ChannelConfig[]>(`/bots/${botId}/channels`),
  create: (botId: string, data: CreateChannelRequest) => request<ChannelConfig>(`/bots/${botId}/channels`, { method: 'POST', body: JSON.stringify(data) }),
  delete: (botId: string, channelKey: string) => request<void>(`/bots/${botId}/channels/${channelKey}`, { method: 'DELETE' }),
};

// Group API
export const groups = {
  list: (botId: string) => request<Group[]>(`/bots/${botId}/groups`),
  messages: (botId: string, groupJid: string, limit?: number) => request<Message[]>(`/bots/${botId}/groups/${groupJid}/messages${limit ? `?limit=${limit}` : ''}`),
};

// Task API
export const tasks = {
  list: (botId: string) => request<ScheduledTask[]>(`/bots/${botId}/tasks`),
  create: (botId: string, data: CreateTaskRequest) => request<ScheduledTask>(`/bots/${botId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  update: (botId: string, taskId: string, data: UpdateTaskRequest) => request<ScheduledTask>(`/bots/${botId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (botId: string, taskId: string) => request<void>(`/bots/${botId}/tasks/${taskId}`, { method: 'DELETE' }),
};
