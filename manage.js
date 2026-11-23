const $ = id => document.getElementById(id);

const state = {
  entries: [],
  view: 'all',          // all | today | week | wx | noted | untagged
  tags: new Set(),      // 选中的标签（小写）
  tagMode: 'or',        // or | and
  tagSort: 'count',     // count | alpha
  tagSearch: '',
  q: '',
  datePreset: 'all',    // all | today | 7d | 30d | custom
  fs: 0,
  fe: Infinity,
  sort: 'newest',       // newest | oldest | updated
  density: localStorage.getItem('edeli_density') || 'comfortable',
  selected: new Set(),  // 选中的 url
  lastAnchorUrl: null,  // Shift+Click 连选锚点
  quickList: [],
  allTagNames: [],
  exportMode: 'week',   // today | yesterday | week | lastweek | custom | current | selected
  lastExport: null,
  editingOldUrl: null,  // null 表示新建
  managingTag: null,
  batchTagAction: 'add', // add | remove
  lastRenderedRev: -1,  // 已渲染的本地版本号，用于与 storage.onChanged 去重防双倍重绘
};

// ===== 工具函数 =====
const pad = n => String(n).padStart(2, '0');
const fmtTime = ts => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDayKey = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtCompactDay = ts => fmtDayKey(ts).replace(/-/g, '');
const fmtSize = b => b < 1048576
  ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`
  : `${(b / 1048576).toFixed(2)} MB`;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function dayLabel(dayKey) {
  const now = new Date();
  const todayKey = fmtDayKey(now.getTime());
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  const yestKey = fmtDayKey(yest.getTime());
  if (dayKey === todayKey) return '今天';
  if (dayKey === yestKey) return '昨天';
  const d = new Date(dayKey + 'T00:00:00');
  return `${dayKey} ${Digest.weekday(d)}`;
}

async function copyTextSafe(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

// ===== 主题初始化与切换（默认浅色，仅手动点击开启深色） =====
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('edeli_theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('edeli_theme', 'light');
  }
  if (window.EDeliSettings && typeof window.EDeliSettings.syncGeneralToggles === 'function') {
    window.EDeliSettings.syncGeneralToggles();
  }
}
applyTheme(localStorage.getItem('edeli_theme') === 'dark' ? 'dark' : 'light');
$('themeBtn').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  applyTheme(isDark ? 'light' : 'dark');
});

// ===== Toast 通知（支持 5 秒撤销） =====
function showToast(msg, undoFn) {
  const host = $('toastHost');
  const t = el('div', 'toast');
  t.append(el('span', null, msg));
  let timer = null;
  if (undoFn) {
    const btn = el('button', 'toast-undo', '撤销');
    btn.onclick = async () => {
      clearTimeout(timer);
      t.remove();
      await undoFn();
    };
    t.append(btn);
  }
  host.append(t);
  timer = setTimeout(() => t.remove(), undoFn ? 5500 : 2800);
}

// ===== 筛选与排序 =====
function filtered() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = Digest.weekStart(now).getTime();

  const list = state.entries.filter(e => {
    if (state.view === 'today' && e.savedAt < todayStart) return false;
    if (state.view === 'week' && e.savedAt < weekStart) return false;
    if (state.view === 'wx' && !Store.isWx(e.url)) return false;
    if (state.view === 'noted' && !(e.note && e.note.trim())) return false;
    if (state.view === 'untagged' && e.tags && e.tags.length > 0) return false;

    if (state.tags.size) {
      const entryTags = new Set((e.tags || []).map(t => t.toLowerCase()));
      if (state.tagMode === 'and') {
        for (const t of state.tags) if (!entryTags.has(t)) return false;
      } else {
        let hit = false;
        for (const t of state.tags) if (entryTags.has(t)) { hit = true; break; }
        if (!hit) return false;
      }
    }

    if (state.q) {
      const q = state.q.toLowerCase();
      const hay = `${e.title} ${e.url} ${e.note || ''} ${(e.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return e.savedAt >= state.fs && e.savedAt <= state.fe;
  });

  if (state.sort === 'oldest') {
    list.sort((a, b) => a.savedAt - b.savedAt);
  } else if (state.sort === 'updated') {
    list.sort((a, b) => (b.updatedAt || b.savedAt) - (a.updatedAt || a.savedAt));
  } else {
    list.sort((a, b) => b.savedAt - a.savedAt);
  }
  return list;
}

// ===== 侧栏渲染：视图计数、存储、快捷标签、标签索引 =====
function updateViewActiveUI() {
  document.querySelectorAll('#viewList .view-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });
}

async function renderStorageAndCounts() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = Digest.weekStart(now).getTime();

  let cntToday = 0, cntWeek = 0, cntWx = 0, cntNoted = 0, cntUntagged = 0;
  for (const e of state.entries) {
    if (e.savedAt >= todayStart) cntToday++;
    if (e.savedAt >= weekStart) cntWeek++;
    if (Store.isWx(e.url)) cntWx++;
    if (e.note && e.note.trim()) cntNoted++;
    if (!e.tags || e.tags.length === 0) cntUntagged++;
  }

  $('cnt-all').textContent = state.entries.length;
  $('cnt-today').textContent = cntToday;
  $('cnt-week').textContent = cntWeek;
  $('cnt-wx').textContent = cntWx;
  $('cnt-noted').textContent = cntNoted;
  $('cnt-untagged').textContent = cntUntagged;

  updateViewActiveUI();

  const bytes = await chrome.storage.local.getBytesInUse();
  const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
  const pct = Math.min(100, Math.round((bytes / quota) * 100));
  $('storageText').textContent = `${fmtSize(bytes)} / ${fmtSize(quota)}`;
  $('storageFill').style.width = `${pct}%`;
  const warn = bytes > quota * 0.8;
  $('storageMeta').classList.toggle('warn', warn);
  $('storageFill').classList.toggle('warn', warn);
}

function renderQuickChipsDOM() {
  const box = $('quickList');
  box.textContent = '';
  for (const t of state.quickList) {
    const k = t.toLowerCase();
    const chip = el('span', 'chip' + (state.tags.has(k) ? ' on' : ''));
    chip.append(el('span', null, t));
    const x = el('span', 'x', '×');
    x.title = '从快捷标签移除';
    x.onclick = async ev => {
      ev.stopPropagation();
      await Store.removeQuickTag(t);
      state.lastRenderedRev = await Store.getLocalRev();
      await renderQuick();
    };
    chip.append(x);
    chip.onclick = () => toggleTagFilter(k);
    box.append(chip);
  }
}

async function renderQuick() {
  state.quickList = await Store.quickTags();
  renderQuickChipsDOM();
}

function renderTags() {
  const counts = {};
  const displayNames = {};
  for (const e of state.entries) {
    for (const t of e.tags || []) {
      const k = t.toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
      if (!displayNames[k]) displayNames[k] = t;
    }
  }
  state.allTagNames = Object.values(displayNames).sort((a, b) => a.localeCompare(b));

  const q = state.tagSearch.trim().toLowerCase();
  const items = Object.keys(counts)
    .map(k => ({ key: k, name: displayNames[k], count: counts[k] }))
    .filter(item => !q || item.key.includes(q));

  if (state.tagSort === 'alpha') {
    items.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  $('tagModeBar').hidden = state.tags.size < 2;
  document.querySelectorAll('#tagModeToggle button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === state.tagMode);
  });

  const box = $('tagList');
  box.textContent = '';
  if (!items.length) {
    box.append(el('div', 'section-hint', q ? '没有匹配的标签' : '暂无标签'));
    return;
  }

  for (const item of items) {
    const row = el('div', 'tag-row' + (state.tags.has(item.key) ? ' on' : ''));
    row.append(
      el('span', 'tag-hash', '#'),
      el('span', 'tag-name', item.name),
      el('span', 'tag-count', String(item.count))
    );
    const gear = el('button', 'tag-gear', '⋯');
    gear.title = '重命名、合并或删除标签';
    gear.onclick = ev => {
      ev.stopPropagation();
      openTagModal(item.name);
    };
    row.append(gear);
    row.onclick = () => toggleTagFilter(item.key);
    box.append(row);
  }
}

function toggleTagFilter(lowerKey) {
  if (state.tags.has(lowerKey)) state.tags.delete(lowerKey);
  else state.tags.add(lowerKey);
  onFilterChanged();
}

// ===== 激活筛选胶囊栏 =====
function renderActiveBar() {
  const bar = $('activeBar');
  bar.textContent = '';
  const pills = [];

  const viewLabels = {
    today: '视图：今日新增',
    week: '视图：本周收藏',
    wx: '视图：公众号文章',
    noted: '视图：含书摘备注',
    untagged: '视图：未打标签',
  };
  if (state.view !== 'all') {
    pills.push({ label: viewLabels[state.view], clear: () => { state.view = 'all'; } });
  }
  if (state.datePreset !== 'all') {
    const labelMap = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', custom: `${$('fs').value || '...'} ~ ${$('fe').value || '...'}` };
    pills.push({
      label: `时间：${labelMap[state.datePreset]}`,
      clear: () => applyDatePreset('all'),
    });
  }
  if (state.q) {
    pills.push({ label: `搜索：“${state.q}”`, clear: () => { state.q = ''; $('q').value = ''; } });
  }
  for (const t of state.tags) {
    pills.push({ label: `#${t}`, clear: () => { state.tags.delete(t); } });
  }

  if (!pills.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.append(el('span', null, '当前筛选：'));
  for (const p of pills) {
    const pill = el('span', 'active-pill');
    pill.append(el('span', null, p.label));
    const btn = el('button', null, '×');
    btn.onclick = () => { p.clear(); onFilterChanged(); };
    pill.append(btn);
    bar.append(pill);
  }
  const clearAll = el('button', 'btn btn-ghost btn-sm', '清除全部');
  clearAll.onclick = () => {
    state.view = 'all';
    state.tags.clear();
    state.q = '';
    $('q').value = '';
    applyDatePreset('all');
    onFilterChanged();
  };
  bar.append(clearAll);
}

// ===== 主列表渲染（按天分组 + 两种密度） =====
// 原地同步勾选样式，避免勾选复选框时全量重建 DOM 与折叠已展开书摘
function syncSelectionUI() {
  document.querySelectorAll('#list .bookmark-card').forEach(card => {
    const isSel = state.selected.has(card.dataset.url);
    card.classList.toggle('selected', isSel);
    const cb = card.querySelector('.card-check input[type="checkbox"]');
    if (cb) cb.checked = isSel;
  });
}

function renderList() {
  const items = filtered();
  $('feedSummaryText').textContent = `显示 ${items.length} 条（共 ${state.entries.length} 条）`;
  const box = $('list');
  box.className = state.density === 'compact' ? 'feed-compact' : '';
  box.textContent = '';

  if (!items.length) {
    const empty = el('div', 'empty-state');
    empty.append(el('h3', null, '没有匹配的收藏'));
    empty.append(el('p', null, '试试调整搜索词、切换智能视图，或直接新建一条书签。'));
    const btn = el('button', 'btn btn-primary btn-sm', '重置筛选');
    btn.onclick = () => {
      state.view = 'all';
      state.tags.clear();
      state.q = '';
      $('q').value = '';
      applyDatePreset('all');
      onFilterChanged();
    };
    empty.append(btn);
    box.append(empty);
    return;
  }

  // 按天分组保持当前排序顺序
  const groups = new Map();
  for (const e of items) {
    const key = fmtDayKey(e.savedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const frag = document.createDocumentFragment();
  for (const [dayKey, dayItems] of groups) {
    const section = el('section', 'day-group');
    const head = el('div', 'day-header');
    head.append(el('span', null, dayLabel(dayKey)), el('span', 'day-count', `${dayItems.length} 条`));
    section.append(head);
    for (const e of dayItems) section.append(bookmarkCard(e, items));
    frag.append(section);
  }
  box.append(frag);
}

function bookmarkCard(e, currentItems) {
  const isSel = state.selected.has(e.url);
  const card = el('article', 'bookmark-card' + (isSel ? ' selected' : ''));
  card.dataset.url = e.url;

  // 复选框（支持 Shift+Click 连选）
  const checkWrap = el('div', 'card-check');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = isSel;
  cb.onclick = ev => {
    ev.stopPropagation();
    if (ev.shiftKey && state.lastAnchorUrl) {
      const urls = currentItems.map(x => x.url);
      const a = urls.indexOf(state.lastAnchorUrl);
      const b = urls.indexOf(e.url);
      if (a >= 0 && b >= 0) {
        const [start, end] = a < b ? [a, b] : [b, a];
        for (let i = start; i <= end; i++) {
          cb.checked ? state.selected.add(urls[i]) : state.selected.delete(urls[i]);
        }
      }
    } else {
      cb.checked ? state.selected.add(e.url) : state.selected.delete(e.url);
    }
    state.lastAnchorUrl = e.url;
    syncSelectionUI();
    renderBatchBar();
    if ($('exportDrawer').classList.contains('open') && state.exportMode === 'selected') {
      generateExport();
    }
  };
  checkWrap.append(cb);

  const body = el('div', 'card-body');
  const top = el('div', 'card-top');
  const { mainTitle, wxName } = Store.splitWxTitle(e.title, e.url);
  let titleNode;
  if (Store.isSafeHref(e.url)) {
    titleNode = el('a', 'card-title', mainTitle);
    titleNode.href = e.url;
    titleNode.target = '_blank';
    titleNode.rel = 'noopener noreferrer';
  } else {
    titleNode = el('span', 'card-title card-title-disabled', mainTitle);
    titleNode.title = `非 http/https 链接，已禁止直接打开：${e.url}`;
  }

  const ops = el('div', 'card-ops');
  const editBtn = el('button', 'op-btn', '编辑');
  editBtn.onclick = () => openEditModal(e);
  const copyMdBtn = el('button', 'op-btn', '复制MD');
  copyMdBtn.onclick = async () => {
    const ok = await copyTextSafe(Digest.formatLine(e));
    showToast(ok ? '已复制 Markdown 条目' : '复制失败，请检查剪贴板权限');
  };
  const delBtn = el('button', 'op-btn danger', '删除');
  delBtn.onclick = async () => {
    const removed = await Store.removeMany([e.url]);
    state.selected.delete(e.url);
    if (state.lastAnchorUrl === e.url) state.lastAnchorUrl = null;
    await reload();
    showToast('已删除书签', async () => {
      await Store.restoreMany(removed);
      await reload();
      showToast('已撤销删除');
    });
  };
  ops.append(editBtn, copyMdBtn, delBtn);
  top.append(titleNode, ops);
  body.append(top);

  // 元信息行：公众号徽标 / 域名 + 时间
  const meta = el('div', 'card-meta');
  if (wxName) meta.append(el('span', 'wx-badge', `公众号 · ${wxName}`));
  meta.append(el('span', 'source-badge', Store.extractHost(e.url)));
  meta.append(el('span', null, `· ${fmtTime(e.savedAt)}`));
  body.append(meta);

  // 书摘引用块
  if (e.note && e.note.trim()) {
    const quote = el('div', 'card-quote', e.note);
    const longNote = e.note.length > 180 || e.note.split('\n').length > 4;
    if (longNote) quote.classList.add('clamped');
    body.append(quote);
    if (longNote) {
      const toggle = el('button', 'quote-toggle', '展开全部书摘');
      toggle.onclick = () => {
        const clamped = quote.classList.toggle('clamped');
        toggle.textContent = clamped ? '展开全部书摘' : '收起书摘';
      };
      body.append(toggle);
    }
  }

  // 标签
  if (e.tags && e.tags.length) {
    const tagBox = el('div', 'card-tags');
    for (const t of e.tags) {
      const k = t.toLowerCase();
      const chip = el('span', 'chip' + (state.tags.has(k) ? ' on' : ''), `#${t}`);
      chip.onclick = () => toggleTagFilter(k);
      tagBox.append(chip);
    }
    body.append(tagBox);
  }

  card.append(checkWrap, body);
  return card;
}

// ===== 批量操作栏 =====
function renderBatchBar() {
  const n = state.selected.size;
  $('batchCount').textContent = `已选 ${n} 项`;
  $('batchBar').classList.toggle('open', n > 0);
}

$('selectAllBtn').addEventListener('click', () => {
  const items = filtered();
  const allSelected = items.length > 0 && items.every(e => state.selected.has(e.url));
  if (allSelected) {
    for (const e of items) state.selected.delete(e.url);
  } else {
    for (const e of items) state.selected.add(e.url);
  }
  syncSelectionUI();
  renderBatchBar();
  if ($('exportDrawer').classList.contains('open') && state.exportMode === 'selected') {
    generateExport();
  }
});

$('batchClearBtn').addEventListener('click', () => {
  state.selected.clear();
  state.lastAnchorUrl = null;
  syncSelectionUI();
  renderBatchBar();
  if ($('exportDrawer').classList.contains('open') && state.exportMode === 'selected') {
    generateExport();
  }
});

$('batchDeleteBtn').addEventListener('click', async () => {
  const urls = [...state.selected];
  if (!urls.length) return;
  const removed = await Store.removeMany(urls);
  state.selected.clear();
  state.lastAnchorUrl = null;
  await reload();
  showToast(`已删除 ${removed.length} 条书签`, async () => {
    await Store.restoreMany(removed);
    await reload();
    showToast(`已恢复 ${removed.length} 条书签`);
  });
});

$('batchExportBtn').addEventListener('click', () => {
  openDrawer('selected');
});

// ===== 批量增删标签弹窗 =====
function openBatchTagModal(action) {
  state.batchTagAction = action;
  $('btTitle').textContent = action === 'add' ? `为 ${state.selected.size} 项批量添加标签` : `从 ${state.selected.size} 项批量移除标签`;
  $('btInput').value = '';
  const box = $('btQuickChips');
  box.textContent = '';
  for (const t of state.quickList) {
    const c = el('span', 'chip', t);
    c.onclick = () => {
      const tokens = Store.normalizeTags($('btInput').value);
      const exists = tokens.some(x => x.toLowerCase() === t.toLowerCase());
      const next = exists ? tokens.filter(x => x.toLowerCase() !== t.toLowerCase()) : [...tokens, t];
      $('btInput').value = next.join(' ') + (next.length ? ' ' : '');
      $('btInput').focus();
    };
    box.append(c);
  }
  openModal('batchTagModal');
  $('btInput').focus();
}
$('batchAddTagBtn').addEventListener('click', () => openBatchTagModal('add'));
$('batchDelTagBtn').addEventListener('click', () => openBatchTagModal('remove'));
$('btConfirmBtn').addEventListener('click', async () => {
  const tags = Store.normalizeTags($('btInput').value);
  if (!tags.length) return;
  const urls = [...state.selected];
  const opts = state.batchTagAction === 'add' ? { add: tags } : { remove: tags };
  const n = await Store.batchUpdateTags(urls, opts);
  closeAllModals();
  await reload();
  showToast(`已更新 ${n} 条书签标签`);
});

// ===== 新建 / 编辑弹窗 =====
let mSugIndex = -1;
function renderModalQuickChips() {
  const cur = new Set(Store.normalizeTags($('mTags').value).map(t => t.toLowerCase()));
  const box = $('mQuickChips');
  box.textContent = '';
  for (const t of state.quickList) {
    const k = t.toLowerCase();
    const c = el('span', 'chip' + (cur.has(k) ? ' on' : ''), t);
    c.onclick = () => {
      const tokens = Store.normalizeTags($('mTags').value);
      const next = cur.has(k) ? tokens.filter(x => x.toLowerCase() !== k) : [...tokens, t];
      $('mTags').value = next.join(' ') + (next.length ? ' ' : '');
      renderModalQuickChips();
      $('mTags').focus();
    };
    box.append(c);
  }
}

function updateModalSug() {
  const m = $('mTags').value.match(/[^\s,，]*$/);
  const tok = m ? m[0].toLowerCase() : '';
  const list = $('mSugList');
  const hits = tok ? state.allTagNames.filter(t => t.toLowerCase().includes(tok) && t.toLowerCase() !== tok).slice(0, 8) : [];
  if (!hits.length) { list.classList.remove('open'); mSugIndex = -1; return; }
  list.textContent = '';
  hits.forEach((t, idx) => {
    const item = el('div', 'sug-item' + (idx === mSugIndex ? ' active' : ''), t);
    item.onmousedown = ev => {
      ev.preventDefault();
      pickModalSug(t);
    };
    list.append(item);
  });
  list.classList.add('open');
}

function pickModalSug(tag) {
  $('mTags').value = $('mTags').value.replace(/[^\s,，]*$/, tag + ' ');
  $('mSugList').classList.remove('open');
  mSugIndex = -1;
  renderModalQuickChips();
  $('mTags').focus();
}

$('mTags').addEventListener('input', () => { renderModalQuickChips(); updateModalSug(); });
$('mTags').addEventListener('blur', () => setTimeout(() => $('mSugList').classList.remove('open'), 150));
$('mTags').addEventListener('keydown', e => {
  const list = $('mSugList');
  if (!list.classList.contains('open')) return;
  const items = [...list.querySelectorAll('.sug-item')];
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    mSugIndex = (mSugIndex + 1) % items.length;
    items.forEach((n, i) => n.classList.toggle('active', i === mSugIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    mSugIndex = (mSugIndex - 1 + items.length) % items.length;
    items.forEach((n, i) => n.classList.toggle('active', i === mSugIndex));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && mSugIndex >= 0) {
    e.preventDefault();
    pickModalSug(items[mSugIndex].textContent);
  }
});

function openEditModal(entry) {
  state.editingOldUrl = entry ? entry.url : null;
  $('editModalTitle').textContent = entry ? '编辑书签' : '新建书签';
  $('mTitle').value = entry ? entry.title : '';
  $('mUrl').value = entry ? entry.url : '';
  $('mTags').value = entry ? (entry.tags || []).join(' ') : '';
  $('mNote').value = entry ? (entry.note || '') : '';
  $('mSugList').classList.remove('open');
  renderModalQuickChips();
  openModal('editModal');
  (entry ? $('mTitle') : $('mUrl')).focus();
}
$('newBookmarkBtn').addEventListener('click', () => openEditModal(null));

async function saveEditModal() {
  let url = $('mUrl').value.trim();
  if (!url) { showToast('网址不能为空'); $('mUrl').focus(); return; }
  // 自动补全无协议的普通网址，防止点击变成相对路径 404
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    url = 'https://' + url;
  }
  if (Store.isForbiddenUrl(url)) {
    showToast('不支持保存该协议的网址');
    $('mUrl').focus();
    return;
  }
  if (state.editingOldUrl && url !== state.editingOldUrl) {
    const conflict = state.entries.some(e => e.url === url);
    if (conflict && !confirm('目标网址已存在于书签库中，继续保存将覆盖原有条目，确定吗？')) {
      return;
    }
  }
  try {
    if (state.editingOldUrl) {
      await Store.update(state.editingOldUrl, {
        url,
        title: $('mTitle').value,
        tags: $('mTags').value,
        note: $('mNote').value,
      });
      if (state.selected.has(state.editingOldUrl) && url !== state.editingOldUrl) {
        state.selected.delete(state.editingOldUrl);
        state.selected.add(url);
      }
      showToast('已更新书签');
    } else {
      await Store.upsert({
        url,
        title: $('mTitle').value,
        tags: $('mTags').value,
        note: $('mNote').value,
      });
      showToast('已添加书签');
    }
  } catch (e) {
    showToast((e && e.message) || '保存失败');
    return;
  }
  closeAllModals();
  await reload();
}
$('mSaveBtn').addEventListener('click', saveEditModal);
$('editModal').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveEditModal();
});

// ===== 标签治理弹窗 =====
function openTagModal(tagName) {
  state.managingTag = tagName;
  $('tmTagName').textContent = `#${tagName}`;
  $('tmNewName').value = tagName;
  $('tmMergeHint').hidden = true;
  const inQuick = state.quickList.some(t => t.toLowerCase() === tagName.toLowerCase());
  $('tmToggleQuickBtn').textContent = inQuick ? '移出快捷标签' : '加入快捷标签';
  openModal('tagModal');
  $('tmNewName').focus();
  $('tmNewName').select();
}

$('tmNewName').addEventListener('input', () => {
  const next = $('tmNewName').value.trim();
  const old = state.managingTag || '';
  const hint = $('tmMergeHint');
  if (!next || next.toLowerCase() === old.toLowerCase()) { hint.hidden = true; return; }
  if (/[\s,，]/.test(next)) {
    hint.textContent = '单个标签名不能包含空格或逗号。';
    hint.hidden = false;
    return;
  }
  const exists = state.allTagNames.find(t => t.toLowerCase() === next.toLowerCase());
  if (exists) {
    hint.textContent = `标签「${exists}」已存在，应用后将把 #${old} 合并至 #${exists}。`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
});

$('tmRenameBtn').addEventListener('click', async () => {
  const next = $('tmNewName').value.trim();
  const old = state.managingTag;
  if (!next || next === old) { closeAllModals(); return; }
  if (/[\s,，]/.test(next)) {
    showToast('标签名不能包含空格或逗号');
    $('tmNewName').focus();
    return;
  }
  try {
    const n = await Store.renameTag(old, next);
    if (state.tags.has(old.toLowerCase())) {
      state.tags.delete(old.toLowerCase());
      state.tags.add(next.toLowerCase());
    }
    closeAllModals();
    await reload();
    showToast(`已将 #${old} 更新为 #${next}（影响 ${n} 条）`);
  } catch (e) {
    showToast((e && e.message) || '重命名失败');
  }
});

$('tmToggleQuickBtn').addEventListener('click', async () => {
  const tag = state.managingTag;
  const inQuick = state.quickList.some(t => t.toLowerCase() === tag.toLowerCase());
  if (inQuick) await Store.removeQuickTag(tag);
  else await Store.addQuickTag(tag);
  state.lastRenderedRev = await Store.getLocalRev();
  await renderQuick();
  $('tmToggleQuickBtn').textContent = inQuick ? '加入快捷标签' : '移出快捷标签';
  showToast(inQuick ? '已移出快捷标签' : '已加入快捷标签');
});

$('tmDeleteBtn').addEventListener('click', async () => {
  const tag = state.managingTag;
  const n = await Store.deleteTag(tag);
  state.tags.delete(tag.toLowerCase());
  closeAllModals();
  await reload();
  showToast(`已从 ${n} 条书签移除 #${tag}`);
});

// ===== 模态框通用控制 =====
function openModal(id) {
  $('modalBackdrop').classList.add('open');
  $(id).classList.add('open');
}
function closeAllModals() {
  $('modalBackdrop').classList.remove('open');
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
}
$('modalBackdrop').addEventListener('click', closeAllModals);
document.querySelectorAll('[data-close-modal]').forEach(btn => btn.addEventListener('click', closeAllModals));

// ===== 右侧滑出式导出抽屉 =====
function openDrawer(mode) {
  if (mode) state.exportMode = mode;
  $('settingsDrawer').classList.remove('open');
  $('drawerBackdrop').classList.add('open');
  $('exportDrawer').classList.add('open');
  generateExport();
}
function closeDrawer() {
  if ($('settingsDrawer').classList.contains('open') &&
      window.EDeliSettings && typeof window.EDeliSettings.resetPasswordMask === 'function') {
    window.EDeliSettings.resetPasswordMask();
  }
  $('drawerBackdrop').classList.remove('open');
  $('exportDrawer').classList.remove('open');
  $('settingsDrawer').classList.remove('open');
  if (location.hash === '#settings') {
    history.replaceState(null, '', location.pathname + location.search);
  }
}
$('openExportBtn').addEventListener('click', () => openDrawer());
$('closeDrawerBtn').addEventListener('click', closeDrawer);
$('drawerBackdrop').addEventListener('click', closeDrawer);

function computeExport() {
  const mode = state.exportMode;
  let base = state.entries;
  if (mode === 'current') base = filtered();
  else if (mode === 'selected') base = state.entries.filter(e => state.selected.has(e.url));
  else if ($('useFilter').checked) base = filtered();

  if ($('onlyWx').checked) base = base.filter(e => Store.isWx(e.url));

  const now = new Date();
  let opts;
  if (mode === 'today') opts = { kind: 'daily', day: now };
  else if (mode === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    opts = { kind: 'daily', day: y };
  } else if (mode === 'week') opts = { kind: 'weekly', day: now };
  else if (mode === 'lastweek') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    opts = { kind: 'weekly', day: d };
  } else if (mode === 'custom') {
    const rs = $('rs').value, re = $('re').value;
    if (!rs || !re) return null;
    opts = { kind: 'range', start: rs, end: re };
  } else {
    opts = { kind: 'selection', title: mode === 'selected' ? 'E-Deli 精选书签汇总' : 'E-Deli 筛选书签汇总' };
  }

  return Digest.render(base, opts);
}

function generateExport() {
  const mode = state.exportMode;
  document.querySelectorAll('#exportRangePills [data-r]').forEach(b => {
    b.classList.toggle('on', b.dataset.r === mode);
  });
  $('drawerCustomRange').hidden = mode !== 'custom';

  const res = computeExport();
  if (!res) {
    $('preview').value = '';
    $('exportMeta').textContent = '请选择起止日期';
    state.lastExport = null;
    return;
  }
  state.lastExport = res;
  $('preview').value = res.markdown;
  $('exportMeta').textContent = `${res.filename} · ${res.count} 条`;
}

$('quickCopyMdBtn').addEventListener('click', async () => {
  const res = computeExport();
  if (!res) {
    openDrawer('custom');
    showToast('请先在导出抽屉中选择自定义起止日期');
    return;
  }
  state.lastExport = res;
  const ok = await copyTextSafe(res.markdown);
  showToast(ok ? `已复制 ${res.filename}（${res.count} 条）` : '复制失败，请检查剪贴板权限');
});

document.querySelectorAll('#exportRangePills [data-r]').forEach(b => {
  b.addEventListener('click', () => {
    state.exportMode = b.dataset.r;
    generateExport();
  });
});
$('useFilter').addEventListener('change', generateExport);
$('onlyWx').addEventListener('change', generateExport);
$('rs').addEventListener('change', generateExport);
$('re').addEventListener('change', generateExport);

$('dl').addEventListener('click', async () => {
  if (!state.lastExport) return;
  const blob = new Blob([state.lastExport.markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: state.lastExport.filename, saveAs: false });
    showToast(`已下载 ${state.lastExport.filename}`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
});

$('copy').addEventListener('click', async () => {
  if (!state.lastExport) return;
  const ok = await copyTextSafe(state.lastExport.markdown);
  showToast(ok ? 'Markdown 已复制到剪贴板' : '复制失败，请检查剪贴板权限');
});

// ===== 顶部日期 Popover 与其他控制 =====
function applyDatePreset(preset) {
  state.datePreset = preset;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  if (preset === 'all') {
    state.fs = 0; state.fe = Infinity;
    $('fs').value = ''; $('fe').value = '';
    $('dateFilterLabel').textContent = '全部时间';
  } else if (preset === 'today') {
    state.fs = new Date(y, m, d).getTime();
    state.fe = new Date(y, m, d + 1).getTime() - 1;
    $('dateFilterLabel').textContent = '今天';
  } else if (preset === '7d') {
    state.fs = new Date(y, m, d - 6).getTime();
    state.fe = Infinity;
    $('dateFilterLabel').textContent = '近 7 天';
  } else if (preset === '30d') {
    state.fs = new Date(y, m, d - 29).getTime();
    state.fe = Infinity;
    $('dateFilterLabel').textContent = '近 30 天';
  } else {
    state.fs = $('fs').value ? new Date($('fs').value + 'T00:00:00').getTime() : 0;
    state.fe = $('fe').value ? new Date($('fe').value + 'T23:59:59.999').getTime() : Infinity;
    if (state.fs && Number.isFinite(state.fe) && state.fs > state.fe) {
      const tmp = state.fs;
      state.fs = new Date($('fe').value + 'T00:00:00').getTime();
      state.fe = new Date($('fs').value + 'T23:59:59.999').getTime();
      void tmp;
    }
    $('dateFilterLabel').textContent = `${$('fs').value || '...'} ~ ${$('fe').value || '...'}`;
  }
}

$('dateFilterBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('datePopover').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!$('datePopover').contains(e.target) && !$('dateFilterBtn').contains(e.target)) {
    $('datePopover').classList.remove('open');
  }
  // 窄屏下点击侧栏外区域自动收起侧栏
  const sidebar = $('sidebar');
  if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !$('mobileMenuBtn').contains(e.target)) {
    sidebar.classList.remove('open');
  }
});
document.querySelectorAll('#datePopover [data-dp]').forEach(btn => {
  btn.addEventListener('click', () => {
    applyDatePreset(btn.dataset.dp);
    $('datePopover').classList.remove('open');
    onFilterChanged();
  });
});
$('fs').addEventListener('change', () => { applyDatePreset('custom'); onFilterChanged(); });
$('fe').addEventListener('change', () => { applyDatePreset('custom'); onFilterChanged(); });

// ===== 侧栏与工具栏事件 =====
document.querySelectorAll('#viewList .view-item').forEach(btn => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    $('sidebar').classList.remove('open');
    onFilterChanged();
  });
});

$('mobileMenuBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('sidebar').classList.toggle('open');
});

// 搜索防抖（兼容中文输入法组合态）
let qTimer = null;
let qComposing = false;
function commitSearch() {
  state.q = $('q').value.trim();
  onFilterChanged();
}
$('q').addEventListener('compositionstart', () => { qComposing = true; });
$('q').addEventListener('compositionend', () => {
  qComposing = false;
  clearTimeout(qTimer);
  commitSearch();
});
$('q').addEventListener('input', () => {
  if (qComposing) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(commitSearch, 120);
});

$('sortSelect').addEventListener('change', () => {
  state.sort = $('sortSelect').value;
  renderList();
});

$('densityBtn').addEventListener('click', () => {
  state.density = state.density === 'comfortable' ? 'compact' : 'comfortable';
  localStorage.setItem('edeli_density', state.density);
  renderList();
  if (window.EDeliSettings && typeof window.EDeliSettings.syncGeneralToggles === 'function') {
    window.EDeliSettings.syncGeneralToggles();
  }
  showToast(state.density === 'compact' ? '已切换至紧凑模式' : '已切换至书摘卡片模式');
});

$('tagSearch').addEventListener('input', () => {
  state.tagSearch = $('tagSearch').value;
  renderTags();
});

document.querySelectorAll('#tagSortToggle button').forEach(b => {
  b.addEventListener('click', () => {
    state.tagSort = b.dataset.tsort;
    document.querySelectorAll('#tagSortToggle button').forEach(x => x.classList.toggle('on', x === b));
    renderTags();
  });
});

document.querySelectorAll('#tagModeToggle button').forEach(b => {
  b.addEventListener('click', () => {
    state.tagMode = b.dataset.mode;
    onFilterChanged();
  });
});

async function addQuick() {
  const v = $('quickAdd').value.trim();
  if (!v) return;
  await Store.addQuickTag(v);
  state.lastRenderedRev = await Store.getLocalRev();
  $('quickAdd').value = '';
  await renderQuick();
}
$('quickAddBtn').addEventListener('click', addQuick);
$('quickAdd').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) addQuick();
});

// ===== JSON 备份 / 导入 =====
$('exportJson').addEventListener('click', async () => {
  const links = await Store.loadAll();
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), links }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: `e-deli-backup-${fmtCompactDay(Date.now())}.json`, saveAs: true });
    showToast('已生成 JSON 备份');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
});

$('importJsonBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async ev => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); }
  catch (e) { showToast('备份文件解析失败：不是合法 JSON'); return; }
  const items = Array.isArray(data) ? data
    : data && data.links && typeof data.links === 'object' ? Object.values(data.links)
    : data && typeof data === 'object' ? Object.values(data) : [];
  const valid = items.filter(e => e && typeof e === 'object' && e.url);
  if (!valid.length) { showToast('备份文件中没有可识别的收藏条目'); return; }

  const { added, overwrote, skipped } = await Store.importEntries(valid);
  if (added + overwrote === 0) {
    showToast('备份文件中没有可导入的合法书签');
    return;
  }
  await reload();
  const skipMsg = skipped ? `，跳过无效 ${skipped} 条` : '';
  showToast(`导入完成：新增 ${added} 条，更新 ${overwrote} 条${skipMsg}`);
});

// ===== 全局键盘流 =====
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    $('q').focus();
    $('q').select();
    return;
  }

  if (e.key === 'Escape') {
    if ($('modalBackdrop').classList.contains('open')) { closeAllModals(); return; }
    if ($('settingsDrawer').classList.contains('open')) { closeDrawer(); return; }
    if ($('exportDrawer').classList.contains('open')) { closeDrawer(); return; }
    if ($('datePopover').classList.contains('open')) { $('datePopover').classList.remove('open'); return; }
    if ($('sidebar').classList.contains('open')) { $('sidebar').classList.remove('open'); return; }
    if (state.selected.size) {
      state.selected.clear();
      state.lastAnchorUrl = null;
      syncSelectionUI();
      renderBatchBar();
    }
  }
});

// ===== 刷新联动 =====
function onFilterChanged() {
  updateViewActiveUI();
  renderQuickChipsDOM();
  renderTags();
  renderActiveBar();
  renderList();
  if ($('exportDrawer').classList.contains('open')) generateExport();
}

let reloadPromise = null;
let reloadQueued = false;

async function reload() {
  if (reloadPromise) {
    reloadQueued = true;
    return reloadPromise;
  }
  reloadPromise = (async () => {
    do {
      reloadQueued = false;
      const [entries, rev] = await Promise.all([Store.list(), Store.getLocalRev()]);
      state.entries = entries;
      state.lastRenderedRev = rev;
      // 清理已不存在的选中项
      const urlSet = new Set(entries.map(e => e.url));
      for (const u of [...state.selected]) {
        if (!urlSet.has(u)) state.selected.delete(u);
      }
      await renderStorageAndCounts();
      await renderQuick();
      renderTags();
      renderActiveBar();
      renderList();
      renderBatchBar();
      if ($('exportDrawer').classList.contains('open')) generateExport();
    } while (reloadQueued);
  })().finally(() => {
    reloadPromise = null;
  });
  return reloadPromise;
}

window.EDeliManage = {
  $,
  pad,
  state,
  applyTheme,
  renderList,
  reload,
  showToast,
  closeDrawer,
};

reload();
