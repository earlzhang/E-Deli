// store.js — E-Deli 存储层（service worker 与页面共用）
// 数据结构：chrome.storage.local['links'] = { [url]: {url,title,note,tags,savedAt,updatedAt} }
const Store = (() => {
  const KEY = 'links';

  async function loadAll() {
    const { [KEY]: links = {} } = await chrome.storage.local.get(KEY);
    return links;
  }

  async function saveAll(links) {
    await chrome.storage.local.set({ [KEY]: links });
  }

  // 接受数组或字符串；按空格/半角逗号/中文逗号切分，
  // 去重按小写比较但保留首次写法（如 "A股" 不变成 "a股"）
  function normalizeTags(input) {
    const parts = Array.isArray(input) ? input : String(input).split(/[\s,，]+/);
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const t = String(p).trim();
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  // 重复收藏同一 URL = 更新，保留原 savedAt
  async function upsert({ url, title, note, tags }) {
    url = (url || '').trim();
    if (!url) throw new Error('empty url');
    const links = await loadAll();
    const now = Date.now();
    const existed = url in links;
    const prev = existed ? links[url] : {};
    links[url] = {
      url,
      title: (title || '').trim() || url,
      note: (note || '').trim(),
      tags: normalizeTags(tags),
      savedAt: prev.savedAt || now,
      updatedAt: now,
    };
    await saveAll(links);
    return { entry: links[url], existed };
  }

  async function remove(url) {
    const links = await loadAll();
    if (!(url in links)) return false;
    delete links[url];
    await saveAll(links);
    return true;
  }

  // 编辑时支持修改 URL：若新旧 URL 不同则迁移条目并保留原 savedAt
  async function update(oldUrl, { url, title, note, tags }) {
    const prevKey = (oldUrl || '').trim();
    const nextUrl = (url || '').trim();
    if (!nextUrl) throw new Error('empty url');
    const links = await loadAll();
    const prev = links[prevKey] || links[nextUrl] || {};
    const now = Date.now();
    if (prevKey && prevKey !== nextUrl) delete links[prevKey];
    links[nextUrl] = {
      url: nextUrl,
      title: (title || '').trim() || nextUrl,
      note: (note || '').trim(),
      tags: normalizeTags(tags),
      savedAt: prev.savedAt || now,
      updatedAt: now,
    };
    await saveAll(links);
    return links[nextUrl];
  }

  // 批量删除，返回被删除的完整条目数组（用于撤销恢复）
  async function removeMany(urls) {
    const links = await loadAll();
    const removed = [];
    for (const u of urls) {
      if (u in links) {
        removed.push(links[u]);
        delete links[u];
      }
    }
    if (removed.length) await saveAll(links);
    return removed;
  }

  // 批量恢复条目（撤销删除）
  async function restoreMany(entries) {
    if (!entries || !entries.length) return 0;
    const links = await loadAll();
    for (const e of entries) {
      if (e && e.url) links[e.url] = e;
    }
    await saveAll(links);
    return entries.length;
  }

  // 批量增删标签
  async function batchUpdateTags(urls, { add = [], remove: del = [] } = {}) {
    const addTags = normalizeTags(add);
    const delSet = new Set(normalizeTags(del).map(t => t.toLowerCase()));
    if (!addTags.length && !delSet.size) return 0;
    const links = await loadAll();
    const now = Date.now();
    let changed = 0;
    for (const u of urls) {
      const entry = links[u];
      if (!entry) continue;
      const filtered = (entry.tags || []).filter(t => !delSet.has(t.toLowerCase()));
      const merged = normalizeTags([...filtered, ...addTags]);
      entry.tags = merged;
      entry.updatedAt = now;
      changed++;
    }
    if (changed) await saveAll(links);
    return changed;
  }

  // 全局重命名或合并标签（大小写不敏感匹配，自动去重，并同步更新 quickTags）
  async function renameTag(oldTag, newTag) {
    const oldKey = String(oldTag || '').trim().toLowerCase();
    const target = String(newTag || '').trim();
    if (!oldKey || !target) return 0;
    const links = await loadAll();
    const now = Date.now();
    let changed = 0;
    for (const entry of Object.values(links)) {
      const tags = entry.tags || [];
      if (!tags.some(t => t.toLowerCase() === oldKey)) continue;
      const replaced = tags.map(t => (t.toLowerCase() === oldKey ? target : t));
      entry.tags = normalizeTags(replaced);
      entry.updatedAt = now;
      changed++;
    }
    if (changed) await saveAll(links);

    const qTags = await quickTags();
    if (qTags.some(t => t.toLowerCase() === oldKey)) {
      const nextQ = qTags.map(t => (t.toLowerCase() === oldKey ? target : t));
      await setQuickTags(nextQ);
    }
    return changed;
  }

  // 全局删除指定标签（同时从 quickTags 移除）
  async function deleteTag(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return 0;
    const links = await loadAll();
    const now = Date.now();
    let changed = 0;
    for (const entry of Object.values(links)) {
      const tags = entry.tags || [];
      const next = tags.filter(t => t.toLowerCase() !== key);
      if (next.length !== tags.length) {
        entry.tags = next;
        entry.updatedAt = now;
        changed++;
      }
    }
    if (changed) await saveAll(links);

    const qTags = await quickTags();
    if (qTags.some(t => t.toLowerCase() === key)) {
      await setQuickTags(qTags.filter(t => t.toLowerCase() !== key));
    }
    return changed;
  }

  // 按收藏时间倒序的数组
  async function list() {
    return Object.values(await loadAll()).sort((a, b) => b.savedAt - a.savedAt);
  }

  async function tagCounts() {
    const counts = {};
    for (const e of Object.values(await loadAll())) {
      for (const t of e.tags) counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }

  async function countSince(ts) {
    let n = 0;
    for (const e of Object.values(await loadAll())) if (e.savedAt >= ts) n++;
    return n;
  }

  // ===== 快捷标签：popup 点选用，缺省值首次自动写入 =====
  const QKEY = 'quickTags';
  const DEFAULT_QUICK_TAGS = ['A股', '基金', '指数', '美股', '大模型'];

  async function quickTags() {
    const { [QKEY]: tags } = await chrome.storage.local.get(QKEY);
    if (Array.isArray(tags)) return tags;
    await chrome.storage.local.set({ [QKEY]: [...DEFAULT_QUICK_TAGS] });
    return [...DEFAULT_QUICK_TAGS];
  }

  async function setQuickTags(tags) {
    await chrome.storage.local.set({ [QKEY]: normalizeTags(tags) });
  }

  async function addQuickTag(tag) {
    const tags = await quickTags();
    const have = new Set(tags.map(t => t.toLowerCase()));
    for (const t of normalizeTags(tag)) {
      if (!have.has(t.toLowerCase())) tags.push(t);
    }
    await chrome.storage.local.set({ [QKEY]: tags });
  }

  async function removeQuickTag(tag) {
    const tags = await quickTags();
    const k = String(tag).toLowerCase();
    await chrome.storage.local.set({ [QKEY]: tags.filter(t => t.toLowerCase() !== k) });
  }

  // ===== 微信公众号 =====
  function isWx(url) {
    try { return new URL(url).hostname === 'mp.weixin.qq.com'; }
    catch (e) { return false; }
  }

  // 公众号链接标题合成「标题 ｜ 公众号名」；标题已含名称则不动
  function wxTitle(title, url, wxName) {
    const name = (wxName || '').trim();
    if (!name || !isWx(url)) return title;
    return title.includes(name) ? title : `${title} ｜ ${name}`;
  }

  // UI 展示辅助：提取纯净域名
  function extractHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return String(url || '');
    }
  }

  // UI 展示辅助：拆分公众号标题中的「 ｜ 公众号名」
  function splitWxTitle(title, url) {
    const raw = String(title || '');
    if (!isWx(url)) return { mainTitle: raw, wxName: '' };
    const idx = raw.lastIndexOf(' ｜ ');
    if (idx <= 0) return { mainTitle: raw, wxName: '' };
    return {
      mainTitle: raw.slice(0, idx),
      wxName: raw.slice(idx + 3).trim(),
    };
  }

  return {
    loadAll, saveAll, upsert, update, remove, removeMany, restoreMany,
    batchUpdateTags, renameTag, deleteTag,
    list, tagCounts, countSince, normalizeTags,
    quickTags, setQuickTags, addQuickTag, removeQuickTag,
    isWx, wxTitle, extractHost, splitWxTitle,
  };
})();
