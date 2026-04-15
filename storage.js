// storage.js — workspace persistence layer
// Depends on: permissions.js (loaded first)
// No DOM access. No Chrome tabs API. Pure data operations.
//
// Free tier  → chrome.storage.local  (device-only, 10MB)
// Pro tier   → chrome.storage.sync   (cross-device, 100KB total / 8KB per item)
//
// License data is always stored in chrome.storage.local regardless of tier.
// Workspace data lives in whichever storage the user's tier allows.

const WS_DEFAULT_ID = 'ws_default'; // eslint-disable-line no-unused-vars

/* ---------------- Storage backend selector ---------------- */

// Returns the appropriate StorageArea for workspace data.
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

/* ---------------- Init ---------------- */

async function initWorkspaces() {
  const data = await storageGet(['workspaces', 'activeWorkspaceId']);
  const updates = {};

  if (!data.workspaces || Object.keys(data.workspaces).length === 0) {
    const now = Date.now();
    updates.workspaces = {
      [WS_DEFAULT_ID]: {
        id: WS_DEFAULT_ID,
        name: 'My First Workspace',
        createdAt: now,
        updatedAt: now,
        pinnedTabs: [],
        groups: [],
        ungroupedTabs: []
      }
    };
  }

  // Do NOT auto-set activeWorkspaceId here. On fresh Chrome starts, no workspace
  // should be considered active until the user explicitly selects one.
  // (The onStartup handler in background.js clears it on every launch.)

  if (Object.keys(updates).length > 0) {
    await storageSet(updates);
  }
}

/* ---------------- Reads ---------------- */

async function getAllWorkspaces() {
  const { workspaces = {} } = await storageGet(['workspaces']);
  return workspaces;
}

async function getWorkspace(id) {
  const workspaces = await getAllWorkspaces();
  return workspaces[id] || null;
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

// Merges workspaceData into the stored record for `id`.
async function saveWorkspace(id, workspaceData) {
  let workspaces;
  try {
    workspaces = await getAllWorkspaces();
  } catch (e) {
    console.error('saveWorkspace: failed to read workspaces before saving', e);
    return;
  }

  workspaces[id] = {
    ...(workspaces[id] || {}),
    ...workspaceData,
    id,
    updatedAt: Date.now()
  };

  try {
    await storageSet({ workspaces });
  } catch (e) {
    // Surface quota errors clearly so the UI can warn the user.
    if (e.message && e.message.includes('QUOTA_BYTES')) {
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
  const workspaces = await getAllWorkspaces();
  workspaces[id] = workspace;
  await storageSet({ workspaces });
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
  const workspaces = await getAllWorkspaces();
  delete workspaces[id];
  await storageSet({ workspaces });
}

async function renameWorkspace(id, name) {
  const workspaces = await getAllWorkspaces();
  if (!workspaces[id]) throw new Error(`Workspace "${id}" not found.`);
  workspaces[id].name = name.trim() || 'Untitled';
  workspaces[id].updatedAt = Date.now();
  await storageSet({ workspaces });
}

/* ---------------- Quota ---------------- */

// Returns usage info for the active storage backend.
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
    new Promise((resolve) => chrome.storage.local.get(['workspaces', 'activeWorkspaceId'], resolve)),
    new Promise((resolve) => chrome.storage.sync.get(['workspaces', 'activeWorkspaceId'], resolve))
  ]);

  // Don't overwrite if sync already has workspace data.
  if (syncData.workspaces && Object.keys(syncData.workspaces).length > 0) return;

  const payload = {};
  if (localData.workspaces)      payload.workspaces      = localData.workspaces;
  if (localData.activeWorkspaceId) payload.activeWorkspaceId = localData.activeWorkspaceId;

  if (Object.keys(payload).length > 0) {
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set(payload, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
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
