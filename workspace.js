// workspace.js — Chrome API orchestration for workspace operations
// Depends on: storage.js (loaded first)

/* ---------------- Capture ---------------- */

// Reads open tabs and tab groups for a specific window and returns a
// workspace-shaped snapshot. Does NOT store favIconUrl — see architecture notes.
//
// expandedGroupIds: the Set<number> from sidebar.js tracking open accordions.
// allOpen: true when "expand all" is active, meaning every group is expanded.
// windowId: the browser window to capture (required — workspaces map 1:1 to windows).
async function captureCurrentState(expandedGroupIds = new Set(), allOpen = false, windowId = null) {
  const query = windowId ? { windowId } : {};
  const allTabs = await chrome.tabs.query(query);

  // Identify the active tab in the window so we can restore focus when next loaded.
  let activeTabId = null;
  try {
    const activeQuery = windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const [activeTab] = await chrome.tabs.query(activeQuery);
    if (activeTab) activeTabId = activeTab.id;
  } catch (e) {
    console.warn('captureCurrentState: could not determine active tab', e);
  }

  const pinnedTabs = [];
  const tabsByGroupId = new Map(); // groupId (number) → [{url, title}]
  const ungroupedTabs = [];

  for (const tab of allTabs) {
    const entry = { url: tab.url || '', title: tab.title || tab.url || '' };
    if (tab.id === activeTabId) entry.active = true;

    if (tab.pinned) {
      pinnedTabs.push(entry);
      continue;
    }

    const gid = (typeof tab.groupId === 'number' && tab.groupId >= 0) ? tab.groupId : -1;
    if (gid === -1) {
      ungroupedTabs.push(entry);
    } else {
      if (!tabsByGroupId.has(gid)) tabsByGroupId.set(gid, []);
      tabsByGroupId.get(gid).push(entry);
    }
  }

  // Fetch group metadata for each group ID encountered.
  const groups = [];
  for (const [groupId, tabs] of tabsByGroupId.entries()) {
    let name = '';
    let color = 'grey';
    // collapsed: a group is collapsed if it's not in expandedGroupIds
    // (unless allOpen overrides, in which case nothing is collapsed).
    const collapsed = allOpen ? false : !expandedGroupIds.has(groupId);

    try {
      if (chrome.tabGroups && chrome.tabGroups.get) {
        const info = await chrome.tabGroups.get(groupId);
        name = info.title || '';
        color = info.color || 'grey';
      }
    } catch (e) {
      console.warn('captureCurrentState: could not fetch group', groupId, e);
    }

    groups.push({ name, color, collapsed, tabs });
  }

  return { pinnedTabs, groups, ungroupedTabs };
}

/* ---------------- Save ---------------- */

// Blocked during workspace switches to prevent partial mid-switch state
// from being written to the old workspace.
let _switchInProgress = false;

// Captures current Chrome state and persists it to the active workspace.
// expandedGroupIds and allOpenState are passed in from sidebar.js so this
// file doesn't need direct access to sidebar's module-level variables.
// windowId: pass the sidebar's own window ID so saves are always scoped correctly.
async function saveWorkspaceNow(expandedGroupIds, allOpenState, windowId = null) {
  if (_switchInProgress) return;
  try {
    const wid = windowId ||
      (await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] })).id;
    const activeId = await getWindowWorkspaceId(wid);
    if (!activeId) return; // no workspace loaded in this window yet — nothing to save
    const state = await captureCurrentState(expandedGroupIds, allOpenState, wid);
    await saveWorkspace(activeId, state);
  } catch (e) {
    console.error('saveWorkspaceNow failed:', e);
  }
}

/* ---------------- Restore ---------------- */

// Opens all tabs from a saved workspace snapshot into `windowId`, recreating
// tab groups with their names, colors, and collapsed states.
async function restoreWorkspaceTabs(workspaceData, windowId) {
  const { pinnedTabs = [], groups = [], ungroupedTabs = [] } = workspaceData;

  // All tabs are created with active:false. We track which tab should receive
  // focus (the one saved with entry.active === true) and activate it at the end.
  // Falls back to the first non-pinned tab for old snapshots without the flag.
  let activeTabId    = null; // the tab to focus after restore
  let firstNonPinned = null; // fallback if no active flag found

  const openTab = async (tabData, opts = {}) => {
    try {
      const tab = await chrome.tabs.create({ url: tabData.url, windowId, active: false, ...opts });
      if (!opts.pinned) {
        if (!firstNonPinned) firstNonPinned = tab.id;
        if (tabData.active)  activeTabId   = tab.id;
      }
      return tab;
    } catch (e) {
      console.warn('restoreWorkspaceTabs: could not open tab', tabData.url, e);
      return null;
    }
  };

  // Pinned tabs first — they anchor to the left of the tab strip.
  for (const tabData of pinnedTabs) {
    await openTab(tabData, { pinned: true });
  }

  // Named tab groups, in saved order.
  for (const group of groups) {
    if (!Array.isArray(group.tabs) || group.tabs.length === 0) continue;

    const tabIds = [];
    for (const tabData of group.tabs) {
      const tab = await openTab(tabData);
      if (tab) tabIds.push(tab.id);
    }

    if (tabIds.length === 0) continue;

    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, {
        title: group.name || '',
        color: group.color || 'grey',
        collapsed: group.collapsed || false
      });
    } catch (e) {
      console.warn('restoreWorkspaceTabs: could not create group', group.name, e);
    }
  }

  // Ungrouped tabs last.
  for (const tabData of ungroupedTabs) {
    await openTab(tabData);
  }

  // Activate the previously focused tab (or the first non-pinned tab as fallback).
  const toActivate = activeTabId || firstNonPinned;
  if (toActivate) {
    try { await chrome.tabs.update(toActivate, { active: true }); } catch (e) {}
  }
}

/* ---------------- Switch ---------------- */

// callerWindowId: the window performing the switch. If null, falls back to
// getLastFocused (background service worker context where getCurrent() is unavailable).
async function switchWorkspace(targetId, expandedGroupIds, allOpenState, callerWindowId = null) {
  if (_switchInProgress) {
    console.warn('switchWorkspace: already in progress, ignoring.');
    return;
  }

  // Resolve which window we're operating on.
  let windowId = callerWindowId;
  if (!windowId) {
    const currentWindow = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    windowId = currentWindow.id;
  }

  // Per-window check: is this workspace already loaded in this window?
  const activeId = await getWindowWorkspaceId(windowId);
  if (targetId === activeId) return;

  _switchInProgress = true;
  try {
    // Save current state BEFORE touching any tabs.
    if (activeId !== null) {
      // Normal case — save this window's state back to its active workspace.
      const currentState = await captureCurrentState(expandedGroupIds, allOpenState, windowId);
      await saveWorkspace(activeId, currentState);
    } else {
      // No workspace assigned to this window yet. This happens on fresh Chrome
      // starts (blank window, nothing to save) AND on first install (real tabs
      // exist and should be preserved). Use content to distinguish:
      // if the window has real tabs, save them into 'ws_default' so they aren't lost.
      const currentState = await captureCurrentState(new Set(), false, windowId);
      const hasContent =
        currentState.pinnedTabs.length > 0 ||
        currentState.ungroupedTabs.length > 0 ||
        currentState.groups.some(g => g.tabs && g.tabs.length > 0);
      if (hasContent) {
        await saveWorkspace('ws_default', currentState);
      }
    }

    // Load the target workspace into memory BEFORE closing anything.
    // If this fails, we haven't destroyed the user's current session yet.
    const targetWorkspace = await getWorkspace(targetId);
    if (!targetWorkspace) throw new Error(`Workspace "${targetId}" not found.`);

    // Open a placeholder tab so the window survives while we close its tabs.
    const placeholder = await chrome.tabs.create({ windowId });

    // Close only tabs in this window — other windows are untouched.
    const windowTabs = await chrome.tabs.query({ windowId });
    const toClose = windowTabs.map(t => t.id).filter(id => id !== placeholder.id);
    if (toClose.length > 0) {
      try {
        await chrome.tabs.remove(toClose);
      } catch (e) {
        // Individual tabs may already be gone — not fatal, continue restoring.
        console.warn('switchWorkspace: some tabs could not be closed', e);
      }
    }

    // Restore the target workspace into this window.
    await restoreWorkspaceTabs(targetWorkspace, windowId);

    // Remove the placeholder if the workspace opened any other tabs.
    const remaining = await chrome.tabs.query({ windowId });
    if (remaining.length > 1) {
      try { await chrome.tabs.remove(placeholder.id); } catch (e) { /* already gone */ }
    }

    // Commit — record which workspace this window is now displaying.
    await setWindowWorkspaceId(windowId, targetId);

  } finally {
    // Always release the lock, even if something threw.
    _switchInProgress = false;
  }
}
