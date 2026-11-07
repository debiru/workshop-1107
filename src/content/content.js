'use strict';

/*
 * PhoenixField content script
 * - テキスト系フォームへの入力を chrome.storage.local に自動保存する
 * - ページ内ツールバー（Shadow DOM）で、保存データとフォームコントロールを
 *   手動で対応付けて自動入力（復元）を実行する
 * - 外部から取得したコードは実行しない（Manifest V3 のルール）
 */

if (window.__phoenixFieldLoaded) {
  // 二重注入防止
} else {
  window.__phoenixFieldLoaded = true;

  const DATA_KEY = 'phoenixfield:data:v1';
  const SETTINGS_KEY = 'phoenixfield:settings:v1';
  const QUOTA_BYTES = 10485760; // chrome.storage.local の上限（約10MB）
  const QUOTA_GUARD = Math.floor(QUOTA_BYTES * 0.8);
  const DEBOUNCE_MS = 800;

  const DEFAULT_SETTINGS = {
    enabled: true,
    scope: 'textlike', // 'textlike' = 案2 / 'textonly' = 案1
    maxGenerations: 30,
    snapshotIntervalMinutes: 3,
    snapshotMinChangeChars: 10,
    retentionDays: 90
  };

  const TEXT_TYPES = new Set(['text', 'email', 'search', 'url', 'tel']);

  let settings = { ...DEFAULT_SETTINGS };
  let toolbarHost = null;
  let toolbarRefs = null;
  let toolbarEntries = []; // 表示範囲内の保存データ [{pageId, page, item}]
  let toolbarFields = []; // 現在のページの入力欄 [{uid, el, desc}]
  let pairs = []; // 対応付け [{value, dataLabel, genLabel, fieldUid, fieldLabel}]
  let fieldUidCounter = 0;

  /* ---------- ストレージ操作（直列化して競合を避ける） ---------- */

  let queue = Promise.resolve();
  function enqueue(fn) {
    const run = () => Promise.resolve().then(fn).catch((err) => {
      console.warn('[PhoenixField]', err);
    });
    queue = queue.then(run, run);
    return queue;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => resolve(result || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  async function loadSettings() {
    const result = await storageGet(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...result[SETTINGS_KEY] };
    }
    return settings;
  }

  async function loadData() {
    const result = await storageGet(DATA_KEY);
    const data = result[DATA_KEY];
    if (data && typeof data === 'object' && data.pages) return data;
    return { pages: {} };
  }

  function saveData(data) {
    return storageSet({ [DATA_KEY]: data });
  }

  /* ---------- ページID ---------- */

  function currentPageInfo() {
    const url = new URL(window.location.href);
    url.hash = '';
    const params = new URLSearchParams(url.search);
    params.sort();
    const qs = params.toString();
    url.search = qs ? '?' + qs : '';
    return { pageId: url.toString(), origin: url.origin, path: url.pathname };
  }

  /* ---------- フォームコントロールの検出 ---------- */

  function isTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'password') return false;
      if (settings.scope === 'textonly') return type === 'text';
      return TEXT_TYPES.has(type);
    }
    return false;
  }

  function labelText(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    if (el.getAttribute('name')) return el.getAttribute('name');
    if (el.id) return el.id;
    return '';
  }

  function describeField(el, index) {
    const label = labelText(el);
    return {
      tag: el.tagName.toLowerCase(),
      type: el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label: label ? label.slice(0, 80) : '入力欄 ' + (index + 1),
      placeholder: (el.getAttribute('placeholder') || '').slice(0, 80)
    };
  }

  function fieldSignature(el, desc) {
    const base = [desc.tag, desc.type, desc.name, desc.id].join('|');
    const same = Array.from(document.querySelectorAll('textarea, input')).filter((other) => {
      if (!isTarget(other)) return false;
      const d = describeField(other, 0);
      return [d.tag, d.type, d.name, d.id].join('|') === base;
    });
    const occurrence = Math.max(0, same.indexOf(el));
    return base + '|' + occurrence;
  }

  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function scanFields() {
    const elements = Array.from(document.querySelectorAll('textarea, input')).filter(isTarget);
    toolbarFields = elements.map((el, index) => {
      if (!el.dataset.pfUid) {
        fieldUidCounter += 1;
        el.dataset.pfUid = 'pf-f' + fieldUidCounter;
      }
      return { uid: el.dataset.pfUid, el, desc: describeField(el, index) };
    });
    return toolbarFields;
  }

  function findFieldByUid(uid) {
    scanFields();
    const found = toolbarFields.find((f) => f.uid === uid);
    return found ? found.el : null;
  }

  /* ---------- 世代管理 ---------- */

  function changeAmount(a, b) {
    if (a === b) return 0;
    const min = Math.min(a.length, b.length);
    let start = 0;
    while (start < min && a[start] === b[start]) start++;
    let end = 0;
    while (end < min - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    return (a.length - start - end) + (b.length - start - end);
  }

  function pushGeneration(item, value, now, reason) {
    if (!value) return;
    const last = item.generations[item.generations.length - 1];
    if (last && last.value === value) return;
    item.generations.push({ value, savedAt: now, reason });
    while (item.generations.length > settings.maxGenerations) {
      item.generations.shift();
    }
  }

  function pruneRetention(data, now) {
    const cutoff = now - settings.retentionDays * 86400000;
    for (const page of Object.values(data.pages)) {
      for (const item of Object.values(page.items)) {
        item.generations = item.generations.filter((g) => g.savedAt >= cutoff);
      }
    }
  }

  async function enforceQuota(data) {
    let size = JSON.stringify(data).length;
    if (size <= QUOTA_GUARD) return;
    // 各アイテムの最新世代（配列の最後）は残し、それ以外を古い順に削除する
    const candidates = [];
    for (const page of Object.values(data.pages)) {
      for (const item of Object.values(page.items)) {
        item.generations.slice(0, -1).forEach((g) => {
          candidates.push({ item, savedAt: g.savedAt, value: g.value });
        });
      }
    }
    candidates.sort((a, b) => a.savedAt - b.savedAt);
    for (const cand of candidates) {
      if (size <= QUOTA_GUARD) break;
      const idx = cand.item.generations.findIndex(
        (g) => g.savedAt === cand.savedAt && g.value === cand.value
      );
      if (idx >= 0) {
        size -= cand.item.generations[idx].value.length + 32;
        cand.item.generations.splice(idx, 1);
      }
    }
    await saveData(data);
  }

  /* ---------- 自動保存 ---------- */

  function saveFieldValue(el, value) {
    return enqueue(async () => {
      if (!settings.enabled) return;
      const data = await loadData();
      const info = currentPageInfo();
      let page = data.pages[info.pageId];
      if (!page) {
        page = { pageId: info.pageId, origin: info.origin, path: info.path, items: {}, updatedAt: Date.now() };
        data.pages[info.pageId] = page;
      }
      const index = scanFields().findIndex((f) => f.el === el);
      const desc = describeField(el, Math.max(0, index));
      const signature = fieldSignature(el, desc);
      const itemId = 'item-' + hashString(info.pageId + '|' + signature);
      const now = Date.now();
      let item = page.items[itemId];
      if (!item) {
        item = {
          id: itemId,
          signature,
          sourceHint: desc,
          latest: { value, updatedAt: now },
          generations: [],
          createdAt: now,
          updatedAt: now
        };
        page.items[itemId] = item;
        pushGeneration(item, value, now, 'initial');
      } else {
        const prev = item.latest ? item.latest.value : '';
        if (prev && value.length <= Math.floor(prev.length / 2) && prev.length >= 20) {
          pushGeneration(item, prev, now, 'shrink');
        }
        const lastGen = item.generations[item.generations.length - 1];
        const intervalMs = settings.snapshotIntervalMinutes * 60000;
        if (
          value &&
          (!lastGen ||
            (now - lastGen.savedAt >= intervalMs &&
              changeAmount(lastGen.value, value) >= settings.snapshotMinChangeChars))
        ) {
          pushGeneration(item, value, now, 'interval');
        }
        item.latest = { value, updatedAt: now };
        item.updatedAt = now;
        item.sourceHint = desc;
        while (item.generations.length > settings.maxGenerations) item.generations.shift();
      }
      page.updatedAt = now;
      pruneRetention(data, now);
      await saveData(data);
      await enforceQuota(data);
      refreshToolbarCounts();
    });
  }

  const pendingTimers = new WeakMap();
  const pendingValues = new Map();
  function scheduleSave(el) {
    pendingValues.set(el, el.value);
    if (pendingTimers.has(el)) clearTimeout(pendingTimers.get(el));
    const timer = setTimeout(() => {
      pendingValues.delete(el);
      saveFieldValue(el, el.value);
    }, DEBOUNCE_MS);
    pendingTimers.set(el, timer);
  }

  document.addEventListener(
    'input',
    (event) => {
      if (!settings.enabled) return;
      if (isTarget(event.target)) scheduleSave(event.target);
    },
    true
  );

  window.addEventListener('pagehide', () => {
    for (const [el, value] of pendingValues) {
      saveFieldValue(el, value);
    }
    pendingValues.clear();
  });

  /* ---------- ツールバー UI（Shadow DOM） ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const TOOLBAR_CSS = [
    ':host { all: initial; }',
    '.pf { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;',
    '  width: auto; max-width: calc(100vw - 24px); background: #171b26; color: #f5f7fa;',
    '  border: 1px solid #39415a; border-radius: 10px; font: 13px/1.5 system-ui, sans-serif;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,.45); }',
    '.pf[open] { width: 720px; }',
    'summary { cursor: pointer; padding: 8px 14px; font-weight: 700; list-style: none; }',
    'summary:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid #ffc107; outline-offset: 1px; }',
    '.flame { margin-right: 6px; }',
    '.count { font-weight: 400; color: #c8d0e0; margin-left: 8px; }',
    '.body { padding: 4px 14px 14px; max-height: 62vh; overflow: auto; }',
    '.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }',
    '.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }',
    '@media (max-width: 640px) { .cols { grid-template-columns: 1fr; } }',
    'h3 { font-size: 13px; margin: 10px 0 6px; border-bottom: 1px solid #39415a; padding-bottom: 4px; }',
    'button { background: #232a3a; color: #f5f7fa; border: 1px solid #4a5470; border-radius: 6px;',
    '  padding: 5px 12px; cursor: pointer; font: inherit; }',
    'button:hover { background: #2d3649; }',
    'button.primary { background: #ff7a1a; color: #171b26; border-color: #ff7a1a; font-weight: 700; }',
    'select { background: #0f1219; color: #f5f7fa; border: 1px solid #4a5470; border-radius: 6px;',
    '  padding: 4px 6px; font: inherit; max-width: 100%; }',
    '.item { border: 1px solid #2c3345; border-radius: 8px; padding: 8px; margin-bottom: 8px; background: #1d2333; }',
    '.item .meta { color: #c8d0e0; font-size: 12px; }',
    '.item .preview { white-space: pre-wrap; word-break: break-word; color: #e8ecf4; margin-top: 4px; }',
    '.msg { color: #ffd9ae; }',
    '.empty { color: #c8d0e0; }',
    'ul.pairs { margin: 6px 0; padding-left: 18px; }',
    'label { display: inline-flex; gap: 6px; align-items: center; }'
  ].join('\n');

  function formatDate(ts) {
    return new Date(ts).toLocaleString('ja-JP');
  }

  function sourceLabel(item) {
    const hint = item.sourceHint || {};
    const parts = [hint.label || '（名称なし）'];
    const sub = [];
    if (hint.tag) sub.push(hint.tag + (hint.type ? ':' + hint.type : ''));
    if (hint.name) sub.push('name=' + hint.name);
    return { main: parts[0], sub: sub.join(' ') };
  }

  function buildToolbar() {
    if (toolbarHost) return;
    toolbarHost = document.createElement('div');
    toolbarHost.id = 'phoenixfield-host';
    const shadow = toolbarHost.attachShadow({ mode: 'open' });
    const style = el('style', null, TOOLBAR_CSS);
    shadow.appendChild(style);

    const details = el('details', 'pf');
    details.setAttribute('aria-label', 'PhoenixField ツールバー');
    const summary = el('summary');
    const flame = el('span', 'flame', '🔥');
    summary.appendChild(flame);
    summary.appendChild(document.createTextNode('PhoenixField'));
    const count = el('span', 'count');
    count.id = 'pf-count';
    summary.appendChild(count);
    details.appendChild(summary);

    const body = el('div', 'body');

    const topRow = el('div', 'row');
    const scopeLabel = el('label', null, '表示範囲');
    const scopeSelect = document.createElement('select');
    scopeSelect.id = 'pf-scope';
    [
      ['page', 'このページ'],
      ['path', '同じパス（クエリ違い）'],
      ['domain', '同じドメイン内'],
      ['all', 'すべて']
    ].forEach(([value, text]) => scopeSelect.appendChild(new Option(text, value)));
    scopeLabel.appendChild(scopeSelect);
    topRow.appendChild(scopeLabel);
    const refreshBtn = el('button', null, '再読み込み');
    refreshBtn.type = 'button';
    refreshBtn.id = 'pf-refresh';
    topRow.appendChild(refreshBtn);
    const msg = el('span', 'msg');
    msg.id = 'pf-msg';
    msg.setAttribute('aria-live', 'polite');
    topRow.appendChild(msg);
    body.appendChild(topRow);

    const cols = el('div', 'cols');
    const dataSection = el('section');
    dataSection.appendChild(el('h3', null, '保存データ'));
    const dataList = el('div');
    dataList.id = 'pf-data';
    dataSection.appendChild(dataList);
    cols.appendChild(dataSection);
    const fieldSection = el('section');
    fieldSection.appendChild(el('h3', null, 'このページの入力欄'));
    const fieldList = el('div');
    fieldList.id = 'pf-fields';
    fieldSection.appendChild(fieldList);
    cols.appendChild(fieldSection);
    body.appendChild(cols);

    const pairBox = el('div');
    pairBox.appendChild(el('h3', null, '対応付けと自動入力'));
    const pairRow = el('div', 'row');
    const dataLabel = el('label', null, '保存データ');
    const pairData = document.createElement('select');
    pairData.id = 'pf-pair-data';
    dataLabel.appendChild(pairData);
    pairRow.appendChild(dataLabel);
    const genLabel = el('label', null, '世代');
    const pairGen = document.createElement('select');
    pairGen.id = 'pf-pair-gen';
    genLabel.appendChild(pairGen);
    pairRow.appendChild(genLabel);
    const fieldLabel = el('label', null, '入力先');
    const pairField = document.createElement('select');
    pairField.id = 'pf-pair-field';
    fieldLabel.appendChild(pairField);
    pairRow.appendChild(fieldLabel);
    const addBtn = el('button', null, '対応を追加');
    addBtn.type = 'button';
    addBtn.id = 'pf-add-pair';
    pairRow.appendChild(addBtn);
    pairBox.appendChild(pairRow);
    const pairList = el('ul', 'pairs');
    pairList.id = 'pf-pairs';
    pairBox.appendChild(pairList);
    const execBtn = el('button', 'primary', '自動入力を実行');
    execBtn.type = 'button';
    execBtn.id = 'pf-execute';
    pairBox.appendChild(execBtn);
    body.appendChild(pairBox);

    details.appendChild(body);
    shadow.appendChild(details);
    document.documentElement.appendChild(toolbarHost);

    toolbarRefs = { details, count, scopeSelect, msg, dataList, fieldList, pairData, pairGen, pairField, pairList };

    details.addEventListener('toggle', () => {
      if (details.open) renderToolbar();
    });
    refreshBtn.addEventListener('click', () => renderToolbar());
    scopeSelect.addEventListener('change', () => renderToolbar());
    pairData.addEventListener('change', () => fillGenerationSelect());
    addBtn.addEventListener('click', addPair);
    execBtn.addEventListener('click', executePairs);
  }

  function setMsg(text) {
    if (toolbarRefs) toolbarRefs.msg.textContent = text || '';
  }

  function refreshToolbarCounts() {
    if (!toolbarHost || !toolbarRefs) return;
    if (toolbarRefs.details.open) renderToolbar();
  }

  function scopeFilter(info, scope) {
    return (page) => {
      if (scope === 'all') return true;
      if (scope === 'domain') return page.origin === info.origin;
      if (scope === 'path') return page.origin === info.origin && page.path === info.path;
      return page.pageId === info.pageId;
    };
  }

  async function collectEntries(scope) {
    const data = await loadData();
    const info = currentPageInfo();
    const filter = scopeFilter(info, scope);
    const entries = [];
    for (const page of Object.values(data.pages)) {
      if (!filter(page)) continue;
      for (const item of Object.values(page.items)) {
        entries.push({ pageId: page.pageId, page, item });
      }
    }
    entries.sort((a, b) => (b.item.updatedAt || 0) - (a.item.updatedAt || 0));
    return entries;
  }

  async function renderToolbar() {
    if (!toolbarRefs) return;
    const scope = toolbarRefs.scopeSelect.value || 'page';
    toolbarEntries = await collectEntries(scope);
    scanFields();
    toolbarRefs.count.textContent = '保存データ ' + toolbarEntries.length + ' 件';

    // 保存データ一覧
    const dataList = toolbarRefs.dataList;
    dataList.textContent = '';
    if (toolbarEntries.length === 0) {
      dataList.appendChild(el('p', 'empty', '表示範囲内に保存データはありません。'));
    }
    for (const entry of toolbarEntries) {
      const { item } = entry;
      const label = sourceLabel(item);
      const box = el('div', 'item');
      box.appendChild(el('div', null, label.main));
      const metaParts = [];
      if (label.sub) metaParts.push(label.sub);
      metaParts.push(formatDate(item.updatedAt));
      metaParts.push((item.latest ? item.latest.value.length : 0) + '字');
      metaParts.push('世代 ' + item.generations.length + '件');
      if (entry.pageId !== currentPageInfo().pageId) metaParts.push(entry.page.path);
      box.appendChild(el('div', 'meta', metaParts.join(' / ')));
      const previewText = (item.latest ? item.latest.value : '').slice(0, 120);
      box.appendChild(el('div', 'preview', previewText || '（最新版は空です。世代から復元できます）'));
      const delBtn = el('button', null, 'このデータを削除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => deleteItem(entry.pageId, item.id));
      box.appendChild(delBtn);
      dataList.appendChild(box);
    }

    // 入力欄一覧
    const fieldList = toolbarRefs.fieldList;
    fieldList.textContent = '';
    if (toolbarFields.length === 0) {
      fieldList.appendChild(el('p', 'empty', '対象の入力欄が見つかりません。'));
    }
    for (const field of toolbarFields) {
      const box = el('div', 'item');
      box.appendChild(el('div', null, field.desc.label));
      const meta = [];
      meta.push(field.desc.tag + (field.desc.type ? ':' + field.desc.type : ''));
      if (field.desc.name) meta.push('name=' + field.desc.name);
      meta.push('現在 ' + field.el.value.length + '字');
      box.appendChild(el('div', 'meta', meta.join(' / ')));
      fieldList.appendChild(box);
    }

    // 対応付け用セレクト
    const pairData = toolbarRefs.pairData;
    pairData.textContent = '';
    for (const entry of toolbarEntries) {
      const label = sourceLabel(entry.item);
      const opt = new Option(
        label.main + '（' + formatDate(entry.item.updatedAt) + '）',
        entry.pageId + '||' + entry.item.id
      );
      pairData.appendChild(opt);
    }
    fillGenerationSelect();

    const pairField = toolbarRefs.pairField;
    pairField.textContent = '';
    for (const field of toolbarFields) {
      pairField.appendChild(new Option(field.desc.label, field.uid));
    }
    renderPairs();
  }

  function selectedEntry() {
    if (!toolbarRefs) return null;
    const value = toolbarRefs.pairData.value;
    if (!value) return null;
    const [pageId, itemId] = value.split('||');
    return toolbarEntries.find((e) => e.pageId === pageId && e.item.id === itemId) || null;
  }

  function fillGenerationSelect() {
    if (!toolbarRefs) return;
    const genSelect = toolbarRefs.pairGen;
    genSelect.textContent = '';
    const entry = selectedEntry();
    if (!entry) return;
    const { item } = entry;
    genSelect.appendChild(
      new Option('最新版（' + formatDate(item.latest.updatedAt) + '・' + item.latest.value.length + '字）', 'latest')
    );
    const gens = [...item.generations].reverse();
    gens.forEach((g, i) => {
      const reason = g.reason === 'shrink' ? '・急減時の保存' : g.reason === 'initial' ? '・初回' : '';
      genSelect.appendChild(
        new Option(
          '世代' + (gens.length - i) + '（' + formatDate(g.savedAt) + '・' + g.value.length + '字' + reason + '）',
          String(g.savedAt)
        )
      );
    });
  }

  function resolveGenerationValue(entry, genValue) {
    const { item } = entry;
    if (genValue === 'latest') return item.latest.value;
    const gen = item.generations.find((g) => String(g.savedAt) === genValue);
    return gen ? gen.value : item.latest.value;
  }

  function addPair() {
    const entry = selectedEntry();
    if (!entry) {
      setMsg('保存データがありません。');
      return;
    }
    const fieldUid = toolbarRefs.pairField.value;
    const field = toolbarFields.find((f) => f.uid === fieldUid);
    if (!field) {
      setMsg('入力先がありません。');
      return;
    }
    const genValue = toolbarRefs.pairGen.value || 'latest';
    const value = resolveGenerationValue(entry, genValue);
    const genLabel =
      toolbarRefs.pairGen.selectedOptions[0] ? toolbarRefs.pairGen.selectedOptions[0].textContent : '最新版';
    pairs.push({
      value,
      dataLabel: sourceLabel(entry.item).main,
      genLabel,
      fieldUid,
      fieldLabel: field.desc.label
    });
    renderPairs();
    setMsg('対応を追加しました。');
  }

  function renderPairs() {
    if (!toolbarRefs) return;
    const list = toolbarRefs.pairList;
    list.textContent = '';
    pairs.forEach((pair, index) => {
      const li = el('li', null, pair.dataLabel + ' / ' + pair.genLabel + ' → ' + pair.fieldLabel + ' ');
      const removeBtn = el('button', null, '取り消し');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        pairs.splice(index, 1);
        renderPairs();
      });
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  function setFieldValue(field, value) {
    const proto =
      field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function executePairs() {
    if (pairs.length === 0) {
      setMsg('対応付けがありません。先に「対応を追加」してください。');
      return;
    }
    let ok = 0;
    let failed = 0;
    for (const pair of pairs) {
      const field = findFieldByUid(pair.fieldUid);
      if (field && isTarget(field)) {
        setFieldValue(field, pair.value);
        ok++;
      } else {
        failed++;
      }
    }
    pairs = [];
    renderPairs();
    setMsg('自動入力を実行しました：' + ok + '件成功' + (failed ? '、' + failed + '件失敗（入力欄が見つかりませんでした）' : ''));
    renderToolbar();
  }

  function deleteItem(pageId, itemId) {
    enqueue(async () => {
      const data = await loadData();
      const page = data.pages[pageId];
      if (page) {
        delete page.items[itemId];
        if (Object.keys(page.items).length === 0) delete data.pages[pageId];
        await saveData(data);
      }
      renderToolbar();
    });
  }

  /* ---------- 初期化 ---------- */

  async function init() {
    await loadSettings();
    if (settings.enabled) {
      buildToolbar();
      enqueue(async () => {
        const data = await loadData();
        pruneRetention(data, Date.now());
        await saveData(data);
        await enforceQuota(data);
      });
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[SETTINGS_KEY]) return;
        settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
        if (settings.enabled && !toolbarHost) buildToolbar();
        if (!settings.enabled && toolbarHost) {
          toolbarHost.remove();
          toolbarHost = null;
          toolbarRefs = null;
        }
      });
    } catch (e) {
      // storage が使えない環境では何もしない
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
