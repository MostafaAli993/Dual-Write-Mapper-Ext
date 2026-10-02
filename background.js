// Minimal service worker: opens the panel and relays progress events.
// No network access happens here - all fetching is done same-origin by content.js.

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('panel/panel.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
