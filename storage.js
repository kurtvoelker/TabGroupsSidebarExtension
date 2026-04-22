// storage.js — workspace persistence layer
// Depends on: permissions.js (loaded first)
// No DOM access. No Chrome tabs API. Pure data operations.
//
// Free tier  → chrome.storage.local  (device-only, 10MB)
// Pro tier   → chrome.storage.sync   (cross-device, 100KB total / 8KB per item)
//
// Workspaces are stored as individual keys (one per workspace) to stay under
// the 8KB per-item sync limit. A 'workspaceIds' index key tracks all IDs.
//
// License data is always stored in chrome.storage.local regardless of tier.

const WS_DEFAULT_ID  = 'ws_default'; // eslint-disable-line no-unused-vars
const WS_INDEX_KEY   = 'workspaceIds';

/* ---------------- Storage backend selector ---------------- */

function _getStorage() {
  if (
    typeof canUseFeature === 'function' &&
    canUseFeature(FEATURES.CLOUD_SYNC) &&
    chrome.storage.sync
  ) {
    return chrome.storage.sync;
  }
  return chrome.storage.local;
}

/* ---------------- Storage primitives ---------------- */

function storageGet(keys) {
  return new Promise((resolve) => _getStorage().get(keys, resolve));
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    _getStorage().set(data, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    _getStorage().remove(keys, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

/* ---------------- Init ---------------- */

async function initWorkspaces() {
  const data = await storageGet([WS_INDEX_KEY, 'workspaces']);

  // Migrate old single-key format to sharded format.
  if (data.workspaces && !data[WS_INDEX_KEY]) {
    const ids = Object.keys(data.workspaces);
    const writes = { [WS_INDEX_KEY]: ids };
    for (const id of ids) writes[id] = data.workspaces[id];
    await storageSet(writes);
    await storageRemove('workspaces');
    return;
  }

  if (!data[WS_INDEX_KEY]) {
    await storageSet({ [WS_INDEX_KEY]: [] });
  }
}

/* ---------------- Reads ---------------- */

async function getAllWorkspaces() {
  const indexData = await storageGet([WS_INDEX_KEY]);
  const ids = indexData[WS_INDEX_KEY] || [];
  if (ids.length === 0) return {};

  const workspaceData = await storageGet(ids);
  const workspaces = {};
  for (const id of ids) {
    if (workspaceData[id]) workspaces[id] = workspaceData[id];
  }
  return workspaces;
}

async function getWorkspace(id) {
  const data = await storageGet([id]);
  return data[id] || null;
}

async function getActiveWorkspaceId() {
  const { activeWorkspaceId = null } = await storageGet(['activeWorkspaceId']);
  return activeWorkspaceId;
}

/* ---------------- Writes ---------------- */

async function setActiveWorkspaceId(id) {
  await storageSet({ activeWorkspaceId: id });
}

/* ---------------- Per-window workspace map (session storage) ---------------- */

// Maps windowId → workspaceId in chrome.storage.session.
// Session storage is cleared automatically when Chrome restarts — no cleanup needed.

async function getWindowWorkspaceId(windowId) {
  const { _windowWorkspaceMap = {} } = await chrome.storage.session.get('_windowWorkspaceMap');
  return _windowWorkspaceMap[windowId] ?? null;
}

async function setWindowWorkspaceId(windowId, wsId) {
  const { _windowWorkspaceMap = {} } = await chrome.storage.session.get('_windowWorkspaceMap');
  if (wsId === null) {
    delete _windowWorkspaceMap[windowId];
  } else {
    _windowWorkspaceMap[windowId] = wsId;
  }
  await chrome.storage.session.set({ _windowWorkspaceMap });
}

async function saveWorkspace(id, workspaceData) {
  const [indexData, existing] = await Promise.all([
    storageGet([WS_INDEX_KEY]),
    storageGet([id])
  ]);

  const ids = indexData[WS_INDEX_KEY] || [];
  const updated = {
    ...(existing[id] || {}),
    ...workspaceData,
    id,
    updatedAt: Date.now()
  };

  const writes = { [id]: updated };
  if (!ids.includes(id)) writes[WS_INDEX_KEY] = [...ids, id];

  try {
    await storageSet(writes);
  } catch (e) {
    if (e.message && (e.message.includes('QUOTA_BYTES') || e.message.includes('kQuotaBytesPerItem'))) {
      throw new StorageQuotaError(e.message);
    }
    throw e;
  }
}

// Pro-gated by the caller via canUseFeature(FEATURES.MULTIPLE_WORKSPACES).
async function createWorkspace(name) {
  const id = 'ws_' + Date.now();
  const now = Date.now();
  const workspace = {
    id,
    name: name.trim() || 'Untitled',
    createdAt: now,
    updatedAt: now,
    pinnedTabs: [],
    groups: [],
    ungroupedTabs: []
  };

  const indexData = await storageGet([WS_INDEX_KEY]);
  const ids = indexData[WS_INDEX_KEY] || [];

  await storageSet({ [id]: workspace, [WS_INDEX_KEY]: [...ids, id] });
  return workspace;
}

async function deleteWorkspace(id) {
  if (id === WS_DEFAULT_ID) {
    throw new Error('Cannot delete the Default workspace.');
  }
  const activeId = await getActiveWorkspaceId();
  if (id === activeId) {
    throw new Error('Cannot delete the active workspace — switch away first.');
  }

  const indexData = await storageGet([WS_INDEX_KEY]);
  const ids = (indexData[WS_INDEX_KEY] || []).filter(i => i !== id);

  await storageSet({ [WS_INDEX_KEY]: ids });
  await storageRemove(id);
}

async function renameWorkspace(id, name) {
  const data = await storageGet([id]);
  if (!data[id]) throw new Error(`Workspace "${id}" not found.`);
  data[id].name = name.trim() || 'Untitled';
  data[id].updatedAt = Date.now();
  await storageSet({ [id]: data[id] });
}

/* ---------------- Quota ---------------- */

async function checkStorageQuota() {
  const backend = _getStorage();
  return new Promise((resolve) => {
    backend.getBytesInUse(null, (used) => {
      const quota = backend.QUOTA_BYTES || (backend === chrome.storage.sync ? 102400 : 10485760);
      resolve({ used, quota, pct: Math.round((used / quota) * 100), sync: backend === chrome.storage.sync });
    });
  });
}

/* ---------------- Sync migration ---------------- */

// Call when a user activates a Pro license to copy their local workspaces into
// sync storage. Safe to call multiple times — skips if sync already has data.
async function migrateLocalToSync() {
  if (!chrome.storage.sync) return;

  const [localData, syncData] = await Promise.all([
    new Promise((resolve) => chrome.storage.local.get(null, resolve)),
    new Promise((resolve) => chrome.storage.sync.get([WS_INDEX_KEY, 'workspaces'], resolve))
  ]);

  const syncHasData =
    (syncData[WS_INDEX_KEY] && syncData[WS_INDEX_KEY].length > 0) ||
    (syncData.workspaces && Object.keys(syncData.workspaces).length > 0);
  if (syncHasData) return;

  const writes = {};

  if (localData[WS_INDEX_KEY]) {
    // Already sharded locally — copy index and individual workspace keys.
    writes[WS_INDEX_KEY] = localData[WS_INDEX_KEY];
    for (const id of localData[WS_INDEX_KEY]) {
      if (localData[id]) writes[id] = localData[id];
    }
  } else if (localData.workspaces) {
    // Old single-key format — shard on the way over.
    const ids = Object.keys(localData.workspaces);
    writes[WS_INDEX_KEY] = ids;
    for (const id of ids) writes[id] = localData.workspaces[id];
  }

  if (localData.activeWorkspaceId) writes.activeWorkspaceId = localData.activeWorkspaceId;

  // Write each key individually to respect per-item quota.
  for (const [key, value] of Object.entries(writes)) {
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  }

  if (Object.keys(writes).length > 0) {
    console.log('storage: migrated local workspaces to sync storage');
  }
}

/* ---------------- Custom errors ---------------- */

class StorageQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}
