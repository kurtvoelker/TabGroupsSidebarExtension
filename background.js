// background.js — open-only shortcut (recommended)

const COMMAND_OPEN = "open_tab_groups_sidebar";

chrome.commands.onCommand.addListener((command) => {
  if (command !== COMMAND_OPEN) return;

  // Keep everything synchronous in the gesture context (no awaits before open)
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.windowId !== "number") return;

    // Directly open the side panel (must be in the gesture handler)
    chrome.sidePanel.open({ windowId: tab.windowId }, () => {
      if (chrome.runtime.lastError) {
        console.error("Failed to open side panel:", chrome.runtime.lastError.message);
      }
    });
  });
});

