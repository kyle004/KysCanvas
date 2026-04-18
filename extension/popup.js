// Cross-browser shim
const api = (typeof browser !== 'undefined') ? browser : chrome;

const toggle = document.getElementById('enable-toggle');
const status = document.getElementById('status');
const ver = document.getElementById('ver');
const banner = document.getElementById('update-banner');
const updateInfo = document.getElementById('update-info');
const updateLink = document.getElementById('update-link');
const checkBtn = document.getElementById('check-update');

function renderStatus(enabled) {
  status.classList.remove('active', 'disabled');
  if (enabled) {
    status.classList.add('active');
    status.textContent = 'Active on Canvas pages.';
  } else {
    status.classList.add('disabled');
    status.textContent = 'Extension is off. UI will not appear on Canvas.';
  }
}

function renderUpdate(info) {
  if (!info || !info.hasUpdate) {
    banner.classList.remove('shown');
    return;
  }
  banner.classList.add('shown');
  updateInfo.textContent = `v${info.latestVersion} is out (you're on v${info.currentVersion}).`;
  if (info.url) updateLink.href = info.url;
}

async function init() {
  ver.textContent = 'v' + api.runtime.getManifest().version;
  const result = await api.storage.local.get({ enabled: true, updateInfo: null });
  toggle.checked = result.enabled;
  renderStatus(result.enabled);
  renderUpdate(result.updateInfo);
}

toggle.addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await api.storage.local.set({ enabled });
  renderStatus(enabled);
});

checkBtn.addEventListener('click', async () => {
  checkBtn.textContent = 'Checking…';
  try {
    await api.runtime.sendMessage({ type: 'check-update' });
    const { updateInfo } = await api.storage.local.get({ updateInfo: null });
    renderUpdate(updateInfo);
    checkBtn.textContent = updateInfo && updateInfo.hasUpdate ? 'Update available' : 'You\'re up to date';
  } catch (e) {
    checkBtn.textContent = 'Check failed';
  }
  setTimeout(() => { checkBtn.textContent = 'Check for updates'; }, 2000);
});

// Re-render banner when storage changes
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.updateInfo) {
    renderUpdate(changes.updateInfo.newValue);
  }
});

init();
