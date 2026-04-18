// Ky's Canvas — Background service worker
// Polls GitHub for new versions every 6 hours, stores latest result in chrome.storage
// so the content script / popup can display an update banner.

const api = (typeof browser !== 'undefined') ? browser : chrome;

// ---- CONFIG --------------------------------------------------------------
// Set this to the raw-content URL of a version.json hosted on your GitHub repo
// or any public URL. Example:
//   https://raw.githubusercontent.com/<user>/<repo>/main/version.json
// File format: { "version": "3.6", "url": "https://github.com/<user>/<repo>/releases/latest", "notes": "…" }
const VERSION_URL = 'https://raw.githubusercontent.com/kyle004/KysCanvas/main/version.json';
const CHECK_INTERVAL_MINUTES = 360; // 6 hours
// -------------------------------------------------------------------------

function cmpVersion(a, b) {
  const ap = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const bp = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const d = (ap[i] || 0) - (bp[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const currentVersion = api.runtime.getManifest().version;
    const resp = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('fetch failed: ' + resp.status);
    const data = await resp.json();
    const latest = data.version;
    const hasUpdate = cmpVersion(latest, currentVersion) > 0;
    await api.storage.local.set({
      updateInfo: {
        currentVersion,
        latestVersion: latest,
        hasUpdate,
        url: data.url || '',
        notes: data.notes || '',
        checkedAt: Date.now()
      }
    });
    if (hasUpdate) {
      api.action.setBadgeText({ text: 'NEW' });
      api.action.setBadgeBackgroundColor({ color: '#0770A3' });
    } else {
      api.action.setBadgeText({ text: '' });
    }
  } catch (err) {
    console.warn("[Ky's Canvas] update check failed:", err);
  }
}

// Run on install, startup, and on a recurring alarm
api.runtime.onInstalled.addListener(() => {
  api.alarms.create('kys-canvas-update-check', {
    delayInMinutes: 1,
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });
  checkForUpdate();
});

api.runtime.onStartup.addListener(() => {
  checkForUpdate();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'kys-canvas-update-check') checkForUpdate();
});

// Allow the popup / content script to trigger a manual check
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'check-update') {
    checkForUpdate().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async
  }
});
