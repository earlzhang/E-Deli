// store.js — E-Deli 存储层（service worker 与页面共用）
// 数据结构：chrome.storage.local['links'] = { [url]: {url,title,note,tags,savedAt,updatedAt} }
//           chrome.storage.local['tombstones'] = { [url]: deletedAt }
//           chrome.storage.local['localRev'] = number（单调递增本地写入版本号，用于防同步覆盖竞态）
const Store = (() => {
  const KEY = 'links';
  const TOMB_KEY = 'tombstones';
  const QKEY = 'quickTags';
  const Q_UPDATED_KEY = 'quickTagsUpdatedAt';
  const DIRTY_KEY = 'syncDirty';
  const REV_KEY = 'localRev';
  const TOMB_TTL_MS = 90 * 24 * 3600 * 1000;
  const DEFAULT_QUICK_TAGS = ['A股', '基金', '指数', '美股', '大模型'];

  // 上下文内写操作串行队列，避免连续 RMW 互相覆盖
  let writeChain = Promise.resolve();
  function enqueueWrite(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
  }

  async function loadAll() {
    const { [KEY]: links = {} } = await chrome.storage.local.get(KEY);
    return links && typeof links === 'object' && !Array.isArray(links) ? links : {};
  }

  async function loadTombstones() {
    const { [TOMB_KEY]: tombstones = {} } = await chrome.storage.local.get(TOMB_KEY);
    return tombstones && typeof tombstones === 'object' && !Array.isArray(tombstones) ? tombstones : {};
  }

  async function getLocalRev() {
    const { [REV_KEY]: rev = 0 } = await chrome.storage.local.get(REV_KEY);
    return Number.isFinite(Number(rev)) ? Number(rev) : 0;
  }

  function pruneTombstones(tombstones, now = Date.now()) {
    const out = {};
    const cutoff = now - TOMB_TTL_MS;
    if (!tombstones || typeof tombstones !== 'object' || Array.isArray(tombstones)) return out;
    for (const [u, ts] of Object.entries(tombstones)) {
      if (typeof ts === 'number' && Number.isFinite(ts) && ts >= cutoff) out[u] = ts;
    }
    return out;
  }

  // 安全外链协议白名单（仅允许 http / https 直接作为页面可点击 href）
  function isSafeHref(url) {
    try {
      const p = new URL(String(url || '').trim()).protocol;
      return p === 'http:' || p === 'https:';
    } catch (e) {
      return false;
    }
  }

  // 显式危险协议拦截（禁止主动新建/保存/导入可执行或内联脚本协议）
  function isForbiddenUrl(url) {
    const s = String(url || '').trim();
    if (!s) return true;
    return /^(javascript|vbscript|data):/i.test(s);
  }

  // 接受数组或字符串；按空格/半角逗号/中文逗号切分，
  // 去重按小写比较但保留首次写法（如 "A股" 不变成 "a股"）
  function normalizeTags(input) {
    const parts = Array.isArray(input)
      ? input.flatMap(item => String(item ?? '').split(/[\s,，]+/))
      : String(input ?? '').split(/[\s,，]+/);
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

  function parseTimestamp(val, fallback) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
    if (typeof val === 'string' && val.trim()) {
      const asNum = Number(val);
      if (Number.isFinite(asNum) && asNum > 0) return asNum;
      const parsed = Date.parse(val);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return fallback;
  }

  // 规范化单条书签记录（同步、导入与恢复共用，防止脏数据导致下游崩溃）
  function sanitizeEntry(raw, fallbackUrl, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const url = String(raw.url || fallbackUrl || '').trim();
    if (!url || isForbiddenUrl(url)) return null;
    const updatedCandidate = parseTimestamp(raw.updatedAt, 0);
    const savedAt = parseTimestamp(raw.savedAt, updatedCandidate || now);
    const updatedAt = updatedCandidate || savedAt;
    const title = String(raw.title ?? '').trim() || url;
    const note = String(raw.note ?? '');
    return {
      url,
      title,
      note,
      tags: normalizeTags(raw.tags || []),
      savedAt,
      updatedAt,
    };
  }

  async function saveAllRaw(links, tombstones, extra = {}) {
    const nextRev = (await getLocalRev()) + 1;
    const payload = Object.assign({
      [KEY]: links,
      [DIRTY_KEY]: true,
      [REV_KEY]: nextRev,
    }, extra);
    if (tombstones !== undefined) payload[TOMB_KEY] = pruneTombstones(tombstones);
    await chrome.storage.local.set(payload);
    return nextRev;
  }

  async function saveAll(links, tombstones) {
    return enqueueWrite(() => saveAllRaw(links, tombstones));
  }

  // 同步引擎写回合并结果专用：一次性原子写入，按 expectedRev 乐观校验防止覆盖同步期间的新本地修改
  async function applySyncedSnapshot({
    links,
    tombstones,
    quickTags: qItems,
    quickTagsUpdatedAt,
    expectedRev,
    clearDirty = true,
  }) {
    return enqueueWrite(async () => {
      const currentRev = await getLocalRev();
      if (expectedRev !== undefined && currentRev !== expectedRev) {
        return { applied: false, currentRev };
      }
      const nextRev = currentRev + 1;
      const payload = {
        [KEY]: links || {},
        [TOMB_KEY]: pruneTombstones(tombstones || {}),
        [REV_KEY]: nextRev,
      };
      if (clearDirty) payload[DIRTY_KEY] = false;
      if (Array.isArray(qItems)) {
        payload[QKEY] = normalizeTags(qItems);
        payload[Q_UPDATED_KEY] =
          typeof quickTagsUpdatedAt === 'number' && Number.isFinite(quickTagsUpdatedAt)
            ? quickTagsUpdatedAt
            : 0;
      }
      await chrome.storage.local.set(payload);
      return { applied: true, rev: nextRev };
    });
  }

  // 仅当 localRev 未发生变化时清除 syncDirty，防止推送耗时期间的本地新修改被错误清脏
  async function clearDirtyIfRev(expectedRev) {
    return enqueueWrite(async () => {
      const currentRev = await getLocalRev();
      if (currentRev !== expectedRev) return false;
      await chrome.storage.local.set({ [DIRTY_KEY]: false });
      return true;
    });
  }

  // 重复收藏同一 URL = 更新，保留原 savedAt
  async function upsert({ url, title, note, tags }) {
    url = (url || '').trim();
    if (!url) throw new Error('empty url');
    if (isForbiddenUrl(url)) throw new Error('不支持的网址协议');
    return enqueueWrite(async () => {
      const [links, tombstones] = await Promise.all([loadAll(), loadTombstones()]);
      const now = Date.now();
      const existed = url in links;
      const prev = existed ? links[url] : {};
      links[url] = {
        url,
        title: (title || '').trim() || url,
        note: (note || '').trim(),
        tags: normalizeTags(tags),
        savedAt: parseTimestamp(prev.savedAt, now),
        updatedAt: now,
      };
      if (url in tombstones) delete tombstones[url];
      await saveAllRaw(links, tombstones);
      return { entry: links[url], existed };
    });
  }

  async function remove(url) {
    return enqueueWrite(async () => {
      const [links, tombstones] = await Promise.all([loadAll(), loadTombstones()]);
      if (!(url in links)) return false;
      delete links[url];
      tombstones[url] = Date.now();
      await saveAllRaw(links, tombstones);
      return true;
    });
  }

  // 编辑时支持修改 URL：若新旧 URL 不同则迁移条目并保留原 savedAt
  async function update(oldUrl, { url, title, note, tags }) {
    const prevKey = (oldUrl || '').trim();
    const nextUrl = (url || '').trim();
    if (!nextUrl) throw new Error('empty url');
    if (isForbiddenUrl(nextUrl)) throw new Error('不支持的网址协议');
    return enqueueWrite(async () => {
      const [links, tombstones] = await Promise.all([loadAll(), loadTombstones()]);
      const prev = links[prevKey] || links[nextUrl] || {};
      const now = Date.now();
      if (prevKey && prevKey !== nextUrl) {
        delete links[prevKey];
        tombstones[prevKey] = now;
      }
      delete tombstones[nextUrl];
      links[nextUrl] = {
        url: nextUrl,
        title: (title || '').trim() || nextUrl,
        note: (note || '').trim(),
        tags: normalizeTags(tags),
        savedAt: parseTimestamp(prev.savedAt, now),
        updatedAt: now,
      };
      await saveAllRaw(links, tombstones);
      return links[nextUrl];
    });
  }

  // 批量删除，返回被删除的完整条目数组（用于撤销恢复）
  async function removeMany(urls) {
    return enqueueWrite(async () => {
      const [links, tombstones] = await Promise.all([loadAll(), loadTombstones()]);
      const removed = [];
      const now = Date.now();
      for (const u of urls) {
        if (u in links) {
          removed.push(links[u]);
          delete links[u];
          tombstones[u] = now;
        }
      }
      if (removed.length) await saveAllRaw(links, tombstones);
      return removed;
    });
  }

  // 批量恢复条目（撤销删除）
  async function restoreMany(entries) {
    if (!entries || !entries.length) return 0;
    return enqueueWrite(async () => {
      const [links, tombstones] = await Promise.all([loadAll(), loadTombstones()]);
      const now = Date.now();
      let restored = 0;
      for (const raw of entries) {
        const clean = sanitizeEntry(raw, raw && raw.url, now);
        if (clean) {
          links[clean.url] = { ...clean, updatedAt: now };
          delete tombstones[clean.url];
          restored++;
        }
      }
      if (restored) await saveAllRaw(links, tombstones);
      return restored;
    });
  }

  // JSON 备份导入：统一字段清洗、时间戳校验（防 NaN）并清理对应墓碑
  async function importEntries(items) {
    return enqueueWrite(async () => {
      const [links, tombstones] = await Promise.all([loadAll(), loadTombstones()]);
      const now = Date.now();
      let added = 0;
      let overwrote = 0;
      let skipped = 0;
      for (const raw of items || []) {
        const clean = sanitizeEntry(raw, raw && raw.url, now);
        if (!clean) { skipped++; continue; }
        const prev = links[clean.url];
        if (prev) overwrote++;
        else added++;
        const prevSavedAt = prev ? parseTimestamp(prev.savedAt, Infinity) : Infinity;
        links[clean.url] = {
          url: clean.url,
          title: clean.title,
          note: clean.note,
          tags: clean.tags,
          savedAt: Math.min(prevSavedAt, clean.savedAt),
          updatedAt: now,
        };
        if (clean.url in tombstones) delete tombstones[clean.url];
      }
      if (added + overwrote > 0) {
        await saveAllRaw(links, tombstones);
      }
      return { added, overwrote, skipped };
    });
  }

  // 批量增删标签
  async function batchUpdateTags(urls, { add = [], remove: del = [] } = {}) {
    const addTags = normalizeTags(add);
    const delSet = new Set(normalizeTags(del).map(t => t.toLowerCase()));
    if (!addTags.length && !delSet.size) return 0;
    return enqueueWrite(async () => {
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
      if (changed) await saveAllRaw(links);
      return changed;
    });
  }

  // 全局重命名或合并标签（大小写不敏感匹配，自动去重，并原子同步更新 quickTags）
  async function renameTag(oldTag, newTag) {
    const oldKey = String(oldTag || '').trim().toLowerCase();
    const rawTarget = String(newTag || '').trim();
    if (!oldKey || !rawTarget) return 0;
    if (/[\s,，]/.test(rawTarget)) {
      throw new Error('标签名不能包含空格或逗号');
    }
    return enqueueWrite(async () => {
      const [links, qTags] = await Promise.all([loadAll(), quickTagsReadOnly()]);
      const now = Date.now();
      let changed = 0;
      for (const entry of Object.values(links)) {
        const tags = entry.tags || [];
        if (!tags.some(t => t.toLowerCase() === oldKey)) continue;
        const replaced = tags.map(t => (t.toLowerCase() === oldKey ? rawTarget : t));
        entry.tags = normalizeTags(replaced);
        entry.updatedAt = now;
        changed++;
      }

      const qChanged = qTags.some(t => t.toLowerCase() === oldKey);
      const extra = {};
      if (qChanged) {
        extra[QKEY] = normalizeTags(qTags.map(t => (t.toLowerCase() === oldKey ? rawTarget : t)));
        extra[Q_UPDATED_KEY] = now;
      }
      if (changed || qChanged) {
        await saveAllRaw(links, undefined, extra);
      }
      return changed;
    });
  }

  // 全局删除指定标签（原子同步从 quickTags 移除）
  async function deleteTag(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return 0;
    return enqueueWrite(async () => {
      const [links, qTags] = await Promise.all([loadAll(), quickTagsReadOnly()]);
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

      const nextQ = qTags.filter(t => t.toLowerCase() !== key);
      const qChanged = nextQ.length !== qTags.length;
      const extra = {};
      if (qChanged) {
        extra[QKEY] = nextQ;
        extra[Q_UPDATED_KEY] = now;
      }
      if (changed || qChanged) {
        await saveAllRaw(links, undefined, extra);
      }
      return changed;
    });
  }

  // 按收藏时间倒序的数组
  async function list() {
    return Object.values(await loadAll())
      .filter(e => e && typeof e === 'object' && e.url)
      .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
  }

  async function tagCounts() {
    const counts = {};
    for (const e of Object.values(await loadAll())) {
      for (const t of (e && Array.isArray(e.tags) ? e.tags : [])) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    return counts;
  }

  async function countSince(ts) {
    let n = 0;
    for (const e of Object.values(await loadAll())) {
      if (e && Number(e.savedAt) >= ts) n++;
    }
    return n;
  }

  // ===== 快捷标签：popup 点选用，缺省值首次自动写入 =====
  async function quickTagsReadOnly() {
    const { [QKEY]: tags } = await chrome.storage.local.get(QKEY);
    return Array.isArray(tags) ? tags : [...DEFAULT_QUICK_TAGS];
  }

  async function quickTags() {
    const { [QKEY]: tags } = await chrome.storage.local.get(QKEY);
    if (Array.isArray(tags)) return tags;
    await chrome.storage.local.set({ [QKEY]: [...DEFAULT_QUICK_TAGS] });
    return [...DEFAULT_QUICK_TAGS];
  }

  async function quickTagsState() {
    const data = await chrome.storage.local.get([QKEY, Q_UPDATED_KEY]);
    const items = Array.isArray(data[QKEY]) ? data[QKEY] : await quickTags();
    const updatedAt = Number(data[Q_UPDATED_KEY]);
    return { items, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
  }

  async function setQuickTags(tags) {
    return enqueueWrite(async () => {
      const nextRev = (await getLocalRev()) + 1;
      await chrome.storage.local.set({
        [QKEY]: normalizeTags(tags),
        [Q_UPDATED_KEY]: Date.now(),
        [DIRTY_KEY]: true,
        [REV_KEY]: nextRev,
      });
    });
  }

  async function addQuickTag(tag) {
    return enqueueWrite(async () => {
      const tags = [...await quickTagsReadOnly()];
      const have = new Set(tags.map(t => t.toLowerCase()));
      let added = false;
      for (const t of normalizeTags(tag)) {
        if (!have.has(t.toLowerCase())) {
          have.add(t.toLowerCase());
          tags.push(t);
          added = true;
        }
      }
      if (added) {
        const nextRev = (await getLocalRev()) + 1;
        await chrome.storage.local.set({
          [QKEY]: tags,
          [Q_UPDATED_KEY]: Date.now(),
          [DIRTY_KEY]: true,
          [REV_KEY]: nextRev,
        });
      }
    });
  }

  async function removeQuickTag(tag) {
    return enqueueWrite(async () => {
      const tags = await quickTagsReadOnly();
      const k = String(tag).toLowerCase();
      const next = tags.filter(t => t.toLowerCase() !== k);
      if (next.length !== tags.length) {
        const nextRev = (await getLocalRev()) + 1;
        await chrome.storage.local.set({
          [QKEY]: next,
          [Q_UPDATED_KEY]: Date.now(),
          [DIRTY_KEY]: true,
          [REV_KEY]: nextRev,
        });
      }
    });
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
    loadAll, loadTombstones, getLocalRev, pruneTombstones, saveAll,
    applySyncedSnapshot, clearDirtyIfRev,
    sanitizeEntry, parseTimestamp, isSafeHref, isForbiddenUrl,
    upsert, update, remove, removeMany, restoreMany, importEntries,
    batchUpdateTags, renameTag, deleteTag,
    list, tagCounts, countSince, normalizeTags,
    quickTags, quickTagsState, setQuickTags, addQuickTag, removeQuickTag,
    isWx, wxTitle, extractHost, splitWxTitle,
  };
})();
