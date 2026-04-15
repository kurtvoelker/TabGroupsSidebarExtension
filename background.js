// background.js — service worker
importScripts('permissions.js', 'storage.js', 'workspace.js');

const COMMAND_OPEN = 'open_tab_groups_sidebar';

/* ---------------- First install ---------------- */
//
// Capture whatever tabs the user already has open and save them as their first
// workspace so nothing is lost when they first interact with the extension.

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;

  try {
    await initPermissions();
    await initWorkspaces(); // creates 'My First Workspace' with empty state
  } catch (e) {
    console.error('background: onInstalled failed', e);
  }

  // Open the welcome tab. The button on that page opens the sidebar via a user
  // gesture, which is required by Chrome for sidePanel.open().
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  } catch (e) {
    console.warn('background: could not open welcome tab on install', e);
  }
});

/* ---------------- Fresh-start cleanup ---------------- */
//
// On every Chrome startup, clear the stored activeWorkspaceId so no workspace
// is "active" until the user explicitly loads one. This prevents a blank
// Chrome window from being captured as the workspace state when the user
// switches workspaces without first opening the sidebar.

// Fired when Chrome itself starts (full quit → relaunch).
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove('activeWorkspaceId');
  chrome.storage.sync.remove('activeWorkspaceId');
});

// Fired whenever any window closes.
chrome.windows.onRemoved.addListener((windowId) => {
  // Remove this window's workspace assignment from the session map.
  setWindowWorkspaceId(windowId, null).catch(() => {});

  // If no normal windows remain, also clear the legacy global activeWorkspaceId.
  chrome.windows.getAll({ windowTypes: ['normal'] }, (remaining) => {
    if (!remaining || remaining.length === 0) {
      chrome.storage.local.remove('activeWorkspaceId');
      chrome.storage.sync.remove('activeWorkspaceId');
    }
  });
});

/* ---------------- Keyboard shortcut ---------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command !== COMMAND_OPEN) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.windowId !== 'number') return;

    chrome.sidePanel.open({ windowId: tab.windowId }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to open side panel:', chrome.runtime.lastError.message);
      }
    });
  });
});

/* ---------------- Workspace switch (triggered by popup) ---------------- */
//
// The popup writes { _requestSwitchToWorkspace: targetId } to local storage
// instead of using sendMessage. Storage writes are committed by the browser
// process and survive popup teardown, so this fires reliably even on the first
// click when the service worker was previously sleeping.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes._requestSwitchToWorkspace) return;

  const newValue = changes._requestSwitchToWorkspace.newValue;
  if (!newValue) return; // fired by our own remove() call below — ignore

  // Clear immediately so a re-open doesn't replay the switch.
  chrome.storage.local.remove('_requestSwitchToWorkspace');

  // Support both old format (string) and new format ({ targetId, windowId }).
  const targetId   = typeof newValue === 'string' ? newValue : newValue.targetId;
  const callerWindowId = typeof newValue === 'object' ? newValue.windowId : null;

  if (!targetId) return;

  initPermissions()
    .then(() => switchWorkspace(targetId, new Set(), false, callerWindowId))
    .catch((e) => console.error('background: switchWorkspace failed', e));
});
