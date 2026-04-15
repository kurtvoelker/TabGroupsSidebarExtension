// Pre-fetch the window ID at page load so the click handler can call
// sidePanel.open() without any preceding await (user gesture is preserved).
let cachedWindowId = null;

chrome.windows.getCurrent().then((win) => {
  if (win) cachedWindowId = win.id;
}).catch((e) => {
  console.error('welcome: could not get current window', e);
});

document.getElementById('openBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    if (cachedWindowId === null) {
      throw new Error('Could not identify window. Try clicking the extension icon in your toolbar.');
    }
    await chrome.sidePanel.open({ windowId: cachedWindowId });
    status.textContent = 'Sidebar opened — you can close this tab.';
  } catch (e) {
    status.textContent = e.message || 'Could not open sidebar. Click the extension icon in your toolbar.';
    console.error('welcome: could not open sidebar', e);
  }
});
