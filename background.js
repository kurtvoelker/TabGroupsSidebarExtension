// background.js — service worker
importScripts('permissions.js', 'storage.js', 'workspace.js');

const COMMAND_OPEN = 'open_tab_groups_sidebar';

/* ---------------- Fresh-start cleanup ---------------- */
//
// On every Chrome startup, clear the stored activeWorkspaceId so no workspace
// is "active" until the user explicitly loads one. This prevents a blank
// Chrome window from being captured as the workspace state when the user
// switches workspaces without first opening the sidebar.

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove('activeWorkspaceId');
  chrome.storage.sync.remove('activeWorkspaceId');
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

  const targetId = changes._requestSwitchToWorkspace.newValue;
  if (!targetId) return; // fired by our own remove() call below — ignore

  // Clear immediately so a re-open doesn't replay the switch.
  chrome.storage.local.remove('_requestSwitchToWorkspace');

  initPermissions()
    .then(() => switchWorkspace(targetId, new Set(), false))
    .catch((e) => console.error('background: switchWorkspace failed', e));
});
