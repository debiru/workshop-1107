'use strict';

/* PhoenixField 設定画面 */

const DATA_KEY = 'phoenixfield:data:v1';
const SETTINGS_KEY = 'phoenixfield:settings:v1';
const QUOTA_BYTES = 10485760;

const DEFAULT_SETTINGS = {
  enabled: true,
  scope: 'textlike',
  maxGenerations: 30,
  snapshotIntervalMinutes: 3,
  snapshotMinChangeChars: 10,
  retentionDays: 90
};

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result || {}));
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function storageRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

function getBytesInUse() {
  return new Promise((resolve) => {
    if (chrome.storage.local.getBytesInUse) {
      chrome.storage.local.getBytesInUse(null, (bytes) => resolve(bytes || 0));
    } else {
      resolve(0);
    }
  });
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('ja-JP');
}

async function loadSettings() {
  const result = await storageGet(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

async function loadData() {
  const result = await storageGet(DATA_KEY);
  const data = result[DATA_KEY];
  if (data && typeof data === 'object' && data.pages) return data;
  return { pages: {} };
}

function fillSettingsForm(settings) {
  document.getElementById('enabled').checked = !!settings.enabled;
  const scopeRadio = document.querySelector(
    'input[name="scope"][value="' + settings.scope + '"]'
  );
  if (scopeRadio) scopeRadio.checked = true;
  document.getElementById('maxGenerations').value = settings.maxGenerations;
  document.getElementById('snapshotIntervalMinutes').value = settings.snapshotIntervalMinutes;
  document.getElementById('snapshotMinChangeChars').value = settings.snapshotMinChangeChars;
  document.getElementById('retentionDays').value = settings.retentionDays;
}

async function onSaveSettings(event) {
  event.preventDefault();
  const scopeEl = document.querySelector('input[name="scope"]:checked');
  const settings = {
    enabled: document.getElementById('enabled').checked,
    scope: scopeEl ? scopeEl.value : DEFAULT_SETTINGS.scope,
    maxGenerations: clampInt(document.getElementById('maxGenerations').value, 1, 100, 30),
    snapshotIntervalMinutes: clampInt(
      document.getElementById('snapshotIntervalMinutes').value, 1, 120, 3
    ),
    snapshotMinChangeChars: clampInt(
      document.getElementById('snapshotMinChangeChars').value, 1, 10000, 10
    ),
    retentionDays: clampInt(document.getElementById('retentionDays').value, 1, 3650, 90)
  };
  await storageSet({ [SETTINGS_KEY]: settings });
  fillSettingsForm(settings);
  document.getElementById('settings-msg').textContent = '保存しました。';
}

async function renderData() {
  const usage = await getBytesInUse();
  const percent = Math.round((usage / QUOTA_BYTES) * 1000) / 10;
  document.getElementById('usage').textContent =
    'ストレージ使用量: 約 ' + usage.toLocaleString() + ' バイト / ' +
    QUOTA_BYTES.toLocaleString() + ' バイト（' + percent + '%）';

  const data = await loadData();
  const container = document.getElementById('pages');
  container.textContent = '';
  const pages = Object.values(data.pages).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (pages.length === 0) {
    const p = document.createElement('p');
    p.textContent = '保存データはありません。';
    container.appendChild(p);
    return;
  }
  for (const page of pages) {
    const items = Object.values(page.items);
    const box = document.createElement('div');
    box.className = 'page';
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = page.pageId;
    box.appendChild(url);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      'データ ' + items.length + '件 / 最終更新 ' + formatDate(page.updatedAt || 0);
    box.appendChild(meta);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'このページのデータを削除';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm('このページの保存データをすべて削除しますか？')) return;
      const latest = await loadData();
      delete latest.pages[page.pageId];
      await storageSet({ [DATA_KEY]: latest });
      renderData();
    });
    box.appendChild(delBtn);
    container.appendChild(box);
  }
}

async function onExport() {
  const data = await loadData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'phoenixfield-export.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function onDeleteAll() {
  if (!window.confirm('すべての保存データを削除しますか？この操作は元に戻せません。')) return;
  await storageRemove(DATA_KEY);
  renderData();
}

document.addEventListener('DOMContentLoaded', async () => {
  fillSettingsForm(await loadSettings());
  renderData();
  document.getElementById('settings-form').addEventListener('submit', onSaveSettings);
  document.getElementById('export-btn').addEventListener('click', onExport);
  document.getElementById('delete-all-btn').addEventListener('click', onDeleteAll);
});
