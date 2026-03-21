import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Provider } from '@clawbot/shared';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: mockSend })),
  },
  GetCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Get', ...input as object })),
  PutCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Put', ...input as object })),
  UpdateCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Update', ...input as object })),
  DeleteCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Delete', ...input as object })),
  ScanCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Scan', ...input as object })),
  QueryCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

vi.mock('../config.js', () => ({
  config: {
    region: 'us-east-1',
    tables: {
      providers: 'nanoclawbot-dev-providers',
    },
  },
}));

const sampleProvider: Provider = {
  providerId: 'prov-bedrock',
  providerName: 'Amazon Bedrock',
  providerType: 'bedrock',
  hasApiKey: false,
  modelIds: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
  isDefault: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

describe('Provider CRUD operations', () => {
  let getProvider: (id: string) => Promise<Provider | null>;
  let listProviders: () => Promise<Provider[]>;
  let putProvider: (p: Provider) => Promise<void>;
  let updateProvider: (id: string, updates: Partial<Provider>) => Promise<void>;
  let deleteProvider: (id: string) => Promise<void>;
  let clearDefaultProvider: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    mockSend.mockReset();

    vi.doMock('@aws-sdk/client-dynamodb', () => ({
      DynamoDBClient: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: vi.fn().mockImplementation(() => ({ send: mockSend })),
      },
      GetCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Get', ...input as object })),
      PutCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Put', ...input as object })),
      UpdateCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Update', ...input as object })),
      DeleteCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Delete', ...input as object })),
      ScanCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Scan', ...input as object })),
      QueryCommand: vi.fn().mockImplementation((input: unknown) => input),
    }));

    vi.doMock('../config.js', () => ({
      config: {
        region: 'us-east-1',
        tables: {
          providers: 'nanoclawbot-dev-providers',
        },
      },
    }));

    const mod = await import('../services/dynamo.js');
    getProvider = mod.getProvider;
    listProviders = mod.listProviders;
    putProvider = mod.putProvider;
    updateProvider = mod.updateProvider;
    deleteProvider = mod.deleteProvider;
    clearDefaultProvider = mod.clearDefaultProvider;
  });

  // ── getProvider ──────────────────────────────────────────────────────────

  it('getProvider returns provider when found', async () => {
    mockSend.mockResolvedValue({ Item: sampleProvider });
    const result = await getProvider('prov-bedrock');
    expect(result).toEqual(sampleProvider);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      _type: 'Get',
      TableName: 'nanoclawbot-dev-providers',
      Key: { providerId: 'prov-bedrock' },
    });
  });

  it('getProvider returns null when not found', async () => {
    mockSend.mockResolvedValue({});
    const result = await getProvider('prov-nonexistent');
    expect(result).toBeNull();
  });

  it('getProvider throws on empty providerId', async () => {
    await expect(getProvider('')).rejects.toThrow();
  });

  // ── listProviders ────────────────────────────────────────────────────────

  it('listProviders returns all items from single page', async () => {
    mockSend.mockResolvedValue({ Items: [sampleProvider] });
    const result = await listProviders();
    expect(result).toEqual([sampleProvider]);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      _type: 'Scan',
      TableName: 'nanoclawbot-dev-providers',
    });
  });

  it('listProviders paginates through multiple pages', async () => {
    const provider2: Provider = { ...sampleProvider, providerId: 'prov-api', providerName: 'API Provider', isDefault: false };
    mockSend
      .mockResolvedValueOnce({ Items: [sampleProvider], LastEvaluatedKey: { providerId: 'prov-bedrock' } })
      .mockResolvedValueOnce({ Items: [provider2] });

    const result = await listProviders();
    expect(result).toEqual([sampleProvider, provider2]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('listProviders returns empty array when table is empty', async () => {
    mockSend.mockResolvedValue({ Items: undefined });
    const result = await listProviders();
    expect(result).toEqual([]);
  });

  // ── putProvider ──────────────────────────────────────────────────────────

  it('putProvider sends PutCommand with full item', async () => {
    mockSend.mockResolvedValue({});
    await putProvider(sampleProvider);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      _type: 'Put',
      TableName: 'nanoclawbot-dev-providers',
      Item: sampleProvider,
    });
  });

  // ── updateProvider ───────────────────────────────────────────────────────

  it('updateProvider builds SET expression for given fields', async () => {
    mockSend.mockResolvedValue({});
    await updateProvider('prov-bedrock', { providerName: 'Updated Name', isDefault: false });
    expect(mockSend).toHaveBeenCalledOnce();
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._type).toBe('Update');
    expect(cmd.TableName).toBe('nanoclawbot-dev-providers');
    expect(cmd.Key).toEqual({ providerId: 'prov-bedrock' });
    expect(cmd.UpdateExpression).toContain('SET');
    expect(cmd.UpdateExpression).toContain('#providerName');
    expect(cmd.UpdateExpression).toContain('#isDefault');
    expect(cmd.ExpressionAttributeNames).toMatchObject({
      '#providerName': 'providerName',
      '#isDefault': 'isDefault',
    });
    expect(cmd.ExpressionAttributeValues).toMatchObject({
      ':providerName': 'Updated Name',
      ':isDefault': false,
    });
  });

  it('updateProvider skips call when updates object is empty', async () => {
    await updateProvider('prov-bedrock', {});
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('updateProvider throws on empty providerId', async () => {
    await expect(updateProvider('', { providerName: 'X' })).rejects.toThrow();
  });

  it('updateProvider handles modelIds array', async () => {
    mockSend.mockResolvedValue({});
    const newModels = ['claude-sonnet-4-20250514'];
    await updateProvider('prov-bedrock', { modelIds: newModels });
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.ExpressionAttributeValues[':modelIds']).toEqual(newModels);
  });

  // ── deleteProvider ───────────────────────────────────────────────────────

  it('deleteProvider sends DeleteCommand', async () => {
    mockSend.mockResolvedValue({});
    await deleteProvider('prov-bedrock');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      _type: 'Delete',
      TableName: 'nanoclawbot-dev-providers',
      Key: { providerId: 'prov-bedrock' },
    });
  });

  it('deleteProvider throws on empty providerId', async () => {
    await expect(deleteProvider('')).rejects.toThrow();
  });

  // ── clearDefaultProvider ────────────────────────────────────────────────

  it('clearDefaultProvider unsets isDefault on all default providers', async () => {
    const defaultProv: Provider = { ...sampleProvider, isDefault: true };
    const nonDefault: Provider = { ...sampleProvider, providerId: 'prov-api', isDefault: false };

    // First call: listProviders (scan)
    mockSend.mockResolvedValueOnce({ Items: [defaultProv, nonDefault] });
    // Second call: updateProvider for the default one
    mockSend.mockResolvedValueOnce({});

    await clearDefaultProvider();

    // scan + 1 update (only for the provider with isDefault=true)
    expect(mockSend).toHaveBeenCalledTimes(2);
    const updateCmd = mockSend.mock.calls[1][0];
    expect(updateCmd._type).toBe('Update');
    expect(updateCmd.Key).toEqual({ providerId: 'prov-bedrock' });
    expect(updateCmd.ExpressionAttributeValues[':isDefault']).toBe(false);
  });

  it('clearDefaultProvider does nothing when no defaults exist', async () => {
    const nonDefault: Provider = { ...sampleProvider, isDefault: false };
    mockSend.mockResolvedValueOnce({ Items: [nonDefault] });

    await clearDefaultProvider();

    // Only the scan call, no update
    expect(mockSend).toHaveBeenCalledOnce();
  });
});
