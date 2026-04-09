// storage.js — workspace persistence layer (chrome.storage.local)
// No DOM access. No Chrome tabs API. Pure data operations.

const WS_DEFAULT_ID = 'ws_default'; // eslint-disable-line no-unused-vars

/* ---------------- Storage primitives ---------------- */

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
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
        name: 'Default',
        createdAt: now,
        updatedAt: now,
        pinnedTabs: [],
        groups: [],
        ungroupedTabs: []
      }
    };
  }

  if (!data.activeWorkspaceId) {
    updates.activeWorkspaceId = WS_DEFAULT_ID;
  }

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
  const { activeWorkspaceId = WS_DEFAULT_ID } = await storageGet(['activeWorkspaceId']);
  return activeWorkspaceId;
}

/* ---------------- Writes ---------------- */

async function setActiveWorkspaceId(id) {
  await storageSet({ activeWorkspaceId: id });
}

// Merges workspaceData into the stored record for `id`.
// Does not capture Chrome state — caller provides the data.
async function saveWorkspace(id, workspaceData) {
  const workspaces = await getAllWorkspaces();
  workspaces[id] = {
    ...(workspaces[id] || {}),
    ...workspaceData,
    id,                  // id is never overwritten by incoming data
    updatedAt: Date.now()
  };
  await storageSet({ workspaces });
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

async function checkStorageQuota() {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (used) => {
      const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
      resolve({ used, quota, pct: Math.round((used / quota) * 100) });
    });
  });
}
