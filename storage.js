// storage.js — workspace persistence layer
// Depends on: permissions.js (loaded first)
// No DOM access. No Chrome tabs API. Pure data operations.
//
// All workspace data is stored in chrome.storage.local (10MB, device-only).
// License data is also stored in chrome.storage.local.

const WS_DEFAULT_ID  = 'ws_default'; // eslint-disable-line no-unused-vars
const WS_INDEX_KEY   = 'workspaceIds';

/* ---------------- Storage backend selector ---------------- */

function _getStorage() {
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

  // Migrate old single-key format to sharded format. Write each workspace
  // individually so a single oversized workspace can't block the entire migration.
  if (data.workspaces && !data[WS_INDEX_KEY]) {
    const ids = Object.keys(data.workspaces);
    await storageSet({ [WS_INDEX_KEY]: ids });
    for (const id of ids) {
      try {
        await storageSet({ [id]: data.workspaces[id] });
      } catch (e) {
        if (e.message && (e.message.includes('QUOTA_BYTES') || e.message.includes('kQuotaBytesPerItem'))) {
          console.warn(`storage: workspace "${id}" too large to sync, skipping`);
        } else {
          throw e;
        }
      }
    }
    await storageRemove('workspaces');
    return;
  }

  if (!data[WS_INDEX_KEY]) {
    await storageSet({ [WS_INDEX_KEY]: [] });
  }
}

/* ---------------- Reads ---------------- */

async function getAllWorkspaces() {
  const indexData = await storageGet([WS_INDEX_KEY, 'workspaces']);

  // Fallback: if migration hasn't run yet, return old single-key format directly.
  if (!indexData[WS_INDEX_KEY] && indexData.workspaces) {
    return indexData.workspaces;
  }

  const ids = indexData[WS_INDEX_KEY] || [];
  if (ids.length === 0) return {};

  const workspaceData = await storageGet(ids);
  const workspaces = {};
  for (const id of ids) {
    if (workspaceData[id] && workspaceData[id].name) workspaces[id] = workspaceData[id];
  }
  return workspaces;
}

async function getWorkspace(id) {
  const data = await storageGet([id, 'workspaces']);
  if (data[id]) return data[id];
  // Fallback: check old single-key format if individual key doesn't exist yet.
  return (data.workspaces || {})[id] || null;
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
  const [indexData, existing, oldData] = await Promise.all([
    storageGet([WS_INDEX_KEY]),
    storageGet([id]),
    storageGet(['workspaces'])
  ]);

  const ids = indexData[WS_INDEX_KEY] || [];
  // Prefer individual key; fall back to old single-key format during migration window.
  const existingWorkspace = existing[id] || (oldData.workspaces || {})[id] || {};

  const updated = {
    ...existingWorkspace,
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

  // Mirror to Supabase for Pro users. Fire-and-forget — local save already succeeded.
  if (typeof pushWorkspace === 'function' && canUseFeature(FEATURES.CLOUD_SYNC)) {
    pushWorkspace(id, updated).catch(e => console.warn('supabase: push after save failed', e));
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

  if (typeof deleteWorkspaceRemote === 'function' && canUseFeature(FEATURES.CLOUD_SYNC)) {
    deleteWorkspaceRemote(id).catch(e => console.warn('supabase: remote delete failed', e));
  }
}

async function renameWorkspace(id, name) {
  const data = await storageGet([id]);
  if (!data[id]) throw new Error(`Workspace "${id}" not found.`);
  data[id].name = name.trim() || 'Untitled';
  data[id].updatedAt = Date.now();
  await storageSet({ [id]: data[id] });
}

/* ---------------- Cloud sync ---------------- */

// Pulls all workspaces from Supabase and writes any that are newer than the
// local copy. Does not delete local workspaces missing from the cloud.
async function pullAndMergeFromCloud() { // eslint-disable-line no-unused-vars
  if (typeof pullAllWorkspaces !== 'function') return;
  if (!canUseFeature(FEATURES.CLOUD_SYNC)) return;

  const rows = await pullAllWorkspaces();
  if (!rows || rows.length === 0) return;

  for (const row of rows) {
    const { workspace_key: key, data } = row;
    if (!key || !data) continue;

    const localResult = await storageGet([key]);
    const local = localResult[key];
    const remoteTs = data.updatedAt || 0;
    const localTs  = local?.updatedAt || 0;

    if (remoteTs > localTs) {
      const indexResult = await storageGet([WS_INDEX_KEY]);
      const ids = indexResult[WS_INDEX_KEY] || [];
      const writes = { [key]: { ...data, id: key } };
      if (!ids.includes(key)) writes[WS_INDEX_KEY] = [...ids, key];
      try {
        await storageSet(writes);
      } catch (e) {
        console.warn('pullAndMergeFromCloud: failed to write', key, e);
      }
    }
  }
}

/* ---------------- Quota ---------------- */

async function checkStorageQuota() {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (used) => {
      const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
      resolve({ used, quota, pct: Math.round((used / quota) * 100), sync: false });
    });
  });
}

// No-op: sync is handled externally. Kept to avoid call-site errors during transition.
async function migrateLocalToSync() {}

/* ---------------- Custom errors ---------------- */

class StorageQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}
