import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level spies — one per SDK method
const mockGetHubProjects = vi.fn().mockResolvedValue({ data: [] });
const mockGetProjectTopFolders = vi.fn().mockResolvedValue({ data: [] });
const mockGetItem = vi.fn().mockResolvedValue({ data: {} });
const mockGetItemVersions = vi.fn().mockResolvedValue({ data: [] });
const mockGetProject = vi.fn().mockResolvedValue({ data: { relationships: {} } });
const mockGetFolderContents = vi.fn().mockResolvedValue({ data: [] });

vi.mock('@aps_sdk/data-management', () => ({
  DataManagementClient: vi.fn().mockImplementation(() => ({
    getHubProjects: mockGetHubProjects,
    getProjectTopFolders: mockGetProjectTopFolders,
    getItem: mockGetItem,
    getItemVersions: mockGetItemVersions,
    getProject: mockGetProject,
    getFolderContents: mockGetFolderContents,
  })),
}));

function makeAuth(): { getAccessToken: ReturnType<typeof vi.fn>; getScopes: ReturnType<typeof vi.fn> } {
  return { getAccessToken: vi.fn().mockResolvedValue('tok'), getScopes: vi.fn().mockReturnValue([]) };
}

describe('data-management adapter — addBPrefix normalization', () => {
  let dm: typeof import('../../../src/apis/data-management.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-apply default resolved values after clearAllMocks
    mockGetHubProjects.mockResolvedValue({ data: [] });
    mockGetProjectTopFolders.mockResolvedValue({ data: [] });
    mockGetItem.mockResolvedValue({ data: {} });
    mockGetItemVersions.mockResolvedValue({ data: [] });
    mockGetProject.mockResolvedValue({ data: { relationships: {} } });
    mockGetFolderContents.mockResolvedValue({ data: [] });

    dm = await import('../../../src/apis/data-management.js');
  });

  it('listProjects: passes b.-prefixed hub ID to SDK even when bare ID given', async () => {
    await dm.listProjects(makeAuth(), 'my-hub');
    expect(mockGetHubProjects).toHaveBeenCalledWith('b.my-hub');
  });

  it('listProjects: does not double-prefix when b. already present', async () => {
    await dm.listProjects(makeAuth(), 'b.my-hub');
    expect(mockGetHubProjects).toHaveBeenCalledWith('b.my-hub');
  });

  it('listTopFolders: applies b. prefix to both hubId and projectId', async () => {
    await dm.listTopFolders(makeAuth(), 'hub-abc', 'proj-abc');
    expect(mockGetProjectTopFolders).toHaveBeenCalledWith('b.hub-abc', 'b.proj-abc');
  });

  it('getItem: applies b. prefix to projectId, passes itemId unchanged', async () => {
    await dm.getItem(makeAuth(), 'proj-xyz', 'item-001').catch(() => undefined);
    expect(mockGetItem).toHaveBeenCalledWith('b.proj-xyz', 'item-001');
  });

  it('listItemVersions: applies b. prefix to projectId, passes itemId unchanged', async () => {
    await dm.listItemVersions(makeAuth(), 'proj-xyz', 'item-001');
    expect(mockGetItemVersions).toHaveBeenCalledWith('b.proj-xyz', 'item-001');
  });

  it('getProjectContainerIds: applies b. prefix to both hubId and projectId', async () => {
    await dm.getProjectContainerIds(makeAuth(), 'hub-1', 'proj-1');
    expect(mockGetProject).toHaveBeenCalledWith('b.hub-1', 'b.proj-1');
  });

  it('listFolderContents: applies b. prefix to projectId, passes folderId unchanged', async () => {
    await dm.listFolderContents(makeAuth(), 'proj-abc', 'folder-001');
    expect(mockGetFolderContents).toHaveBeenCalledWith('b.proj-abc', 'folder-001');
  });
});
