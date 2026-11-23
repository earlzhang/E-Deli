const $ = id => document.getElementById(id);
let allTags = [], quickList = [], sugIdx = -1, saving = false;

// 同步管理页的主题偏好
const savedTheme = localStorage.getItem('edeli_theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function setStatus(msg, err) {
  const el = $('status');
  el.textContent = msg;
  el.className = err ? 'err' : '';
}

async function updateToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const n = await Store.countSince(d.getTime());
  $('today').textContent = n ? `今日已存 ${n} 条` : '';
}

function fillEntry(e) {
  $('title').value = e.title || '';
  $('tags').value = (e.tags || []).join(' ');
  $('note').value = e.note || '';
  $('existed').textContent = '已收藏 · 将更新';
  $('save').textContent = '更新';
}

// ===== 快捷标签：点选加入/移除，不用输入 =====
function tagTokens() {
  return $('tags').value.split(/[\s,，]+/).filter(Boolean);
}
function renderQuick() {
  const cur = new Set(tagTokens().map(t => t.toLowerCase()));
  const box = $('quick');
  box.textContent = '';
  for (const t of quickList) {
    const c = document.createElement('span');
    c.className = 'chip' + (cur.has(t.toLowerCase()) ? ' on' : '');
    c.textContent = t;
    c.onclick = () => {
      const tokens = tagTokens();
      const i = tokens.findIndex(x => x.toLowerCase() === t.toLowerCase());
      i >= 0 ? tokens.splice(i, 1) : tokens.push(t);
      $('tags').value = tokens.join(' ') + (tokens.length ? ' ' : '');
      renderQuick();
      $('tags').focus();
    };
    box.append(c);
  }
}

// ===== 标签自动补全：对最后一个 token 给建议，支持 ↑↓/Enter/Tab =====
function lastToken() {
  const m = $('tags').value.match(/[^\s,，]*$/);
  return m ? m[0].toLowerCase() : '';
}
function hideSug() {
  $('sugList').style.display = 'none';
  sugIdx = -1;
}
function pickSug(tag) {
  $('tags').value = $('tags').value.replace(/[^\s,，]*$/, tag + ' ');
  hideSug();
  renderQuick();
  $('tags').focus();
}
function showSug() {
  const tok = lastToken();
  const hits = tok ? allTags.filter(t => t.toLowerCase().includes(tok) && t.toLowerCase() !== tok).slice(0, 8) : [];
  if (!hits.length) return hideSug();
  const box = $('sugList');
  box.textContent = '';
  sugIdx = -1;
  for (const t of hits) {
    const item = document.createElement('div');
    item.dataset.t = t;
    item.textContent = t;
    box.append(item);
  }
  box.style.display = 'block';
}

$('tags').addEventListener('input', () => { showSug(); renderQuick(); });
$('tags').addEventListener('blur', () => setTimeout(hideSug, 150));
$('sugList').addEventListener('mousedown', e => {
  const t = e.target.dataset && e.target.dataset.t;
  if (!t) return;
  e.preventDefault();
  pickSug(t);
});
$('tags').addEventListener('keydown', e => {
  const box = $('sugList');
  if (box.style.display !== 'block') return;
  const items = [...box.children];
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    sugIdx = (sugIdx + 1) % items.length;
    items.forEach((n, i) => n.classList.toggle('active', i === sugIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    sugIdx = (sugIdx - 1 + items.length) % items.length;
    items.forEach((n, i) => n.classList.toggle('active', i === sugIdx));
  } else if ((e.key === 'Enter' || e.key === 'Tab') && sugIdx >= 0) {
    e.preventDefault();
    e.stopPropagation();
    pickSug(items[sugIdx].dataset.t);
  }
});

// ===== 初始化：pendingSave（右键/快捷键）优先，否则取活动标签页 =====
const NOTE_MAX = 1000;

async function init() {
  const { pendingSave } = await chrome.storage.local.get('pendingSave');
  let url = '', title = '', note = '';
  if (pendingSave && pendingSave.url && Date.now() - pendingSave.at < 60000) {
    url = pendingSave.url;
    title = pendingSave.title || '';
    note = pendingSave.note || '';
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      url = tab.url || '';
      title = tab.title || '';
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'edeli:selection' });
        note = (r && r.text) || '';
        title = Store.wxTitle(title, url, r && r.wxName);
      } catch (e) { /* 受限页面无 content script */ }
    }
  }
  await chrome.storage.local.remove('pendingSave');
  if (note.length > NOTE_MAX) note = note.slice(0, NOTE_MAX) + '…';

  $('url').value = url;
  $('title').value = title;

  const links = await Store.loadAll();
  const existing = links[url];
  if (existing) {
    fillEntry(existing);
    if (note && !existing.note) $('note').value = note;
  } else if (note) {
    $('note').value = note;
  }

  quickList = await Store.quickTags();
  const seen = new Set();
  allTags = [...Object.keys(await Store.tagCounts()), ...quickList]
    .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.localeCompare(b));
  renderQuick();
  updateToday();
  $('title').focus();
  $('title').select();
}

$('save').addEventListener('click', async () => {
  if (saving) return;
  const rawUrl = $('url').value.trim();
  if (!rawUrl) { setStatus('网址不能为空', true); return; }
  if (Store.isForbiddenUrl(rawUrl)) { setStatus('不支持保存该协议的网址', true); return; }
  saving = true;
  $('save').disabled = true;
  try {
    const { existed } = await Store.upsert({
      url: rawUrl,
      title: $('title').value,
      tags: $('tags').value,
      note: $('note').value,
    });
    setStatus(existed ? '已更新（该网址之前已收藏）' : '已收藏');
    $('existed').textContent = '已收藏 · 将更新';
    $('save').textContent = '更新';
    updateToday();
  } catch (e) {
    setStatus((e && e.message) || '保存失败', true);
  } finally {
    saving = false;
    $('save').disabled = false;
  }
});

$('manage').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
});

document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  // 仅在单行输入框内按 Enter 提交，防止在按钮/链接上双次提交或误保存
  if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
    e.preventDefault();
    $('save').click();
  }
  if (e.key === 'Escape') hideSug();
});

init();
