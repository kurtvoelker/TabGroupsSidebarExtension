// background.js — service worker
// Imports shared logic so it can perform workspace switches on behalf of the
// popup (which gets killed by Chrome as soon as it loses focus).
importScripts('permissions.js', 'storage.js', 'workspace.js');

const COMMAND_OPEN = 'open_tab_groups_sidebar';

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

/* ---------------- Message handler ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'switchWorkspace') {
    // Run entirely in the service worker — the popup will be dead by the time
    // the first tab operation fires, so this must not depend on popup context.
    initPermissions()
      .then(() => switchWorkspace(message.targetId, new Set(), false))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error('background: switchWorkspace failed', e);
        sendResponse({ ok: false, error: e.message });
      });
    return true; // Keep the message channel open for the async response
  }
});
