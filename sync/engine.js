// sync/engine.js — E-Deli 同步引擎（配置管理、条目级 LWW + 墓碑合并、冲突重试、防丢写入）
const SyncEngine = (() => {
  const CONFIG_KEY = 'syncConfig';
  const STATE_KEY = 'syncState';
  const DIRTY_KEY = 'syncDirty';
  const SCHEMA_VERSION = 2;
  const STALE_SYNC_MS = 60 * 1000;
  const LOCK_NAME = 'edeli-webdav-sync';

  const DEFAULT_CONFIG = {
    enabled: false,
    provider: 'webdav',
    preset: 'jianguoyun', // 'jianguoyun' | 'custom'
    url: 'https://dav.jianguoyun.com/dav/',
    remoteDir: 'E-Deli',
    username: '',
    password: '',
    mode: 'auto',         // 'auto' | 'manual'
    pullIntervalMin: 30,  // 0 | 15 | 30 | 60
    pushDebounceSec: 30,  // 0 | 30 | 60
  };

  const DEFAULT_STATE = {
    status: 'idle',       // 'idle' | 'syncing' | 'ok' | 'error'
    syncStartedAt: 0,
    lastSyncAt: 0,
    lastSuccessAt: 0,
    lastEtag: null,
    lastError: '',
    lastSummary: '',
    deviceId: '',
  };

  let inFlight = null;

  function genDeviceId() {
    const rand = Math.random().toString(36).slice(2, 8);
    return `edeli-${Date.now().toString(36)}-${rand}`;
  }

  function isPlainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  }

  // 检测因 Service Worker 强杀导致的僵尸 syncing 状态
  function isStaleSyncing(st, now = Date.now()) {
    if (!st || st.status !== 'syncing') return false;
    const started = Number(st.syncStartedAt) || 0;
    return !started || now - started > STALE_SYNC_MS;
  }

  async function getConfig() {
    const { [CONFIG_KEY]: saved } = await chrome.storage.local.get(CONFIG_KEY);
    return Object.assign({}, DEFAULT_CONFIG, saved || {});
  }

  async function saveConfig(partial) {
    const cur = await getConfig();
    const next = Object.assign({}, cur, partial || {});
    const endpointChanged =
      cur.url !== next.url ||
      cur.remoteDir !== next.remoteDir ||
      cur.username !== next.username;

    await chrome.storage.local.set({ [CONFIG_KEY]: next });
    // 切换服务器、目录或账号时重置远端状态，避免旧 ETag/时间污染新配置
    if (endpointChanged) {
      await patchState({
        status: 'idle',
        syncStartedAt: 0,
        lastEtag: null,
        lastSuccessAt: 0,
        lastError: '',
        lastSummary: '',
      });
    }
    return next;
  }

  async function getState() {
    const data = await chrome.storage.local.get([STATE_KEY, DIRTY_KEY]);
    const st = Object.assign({}, DEFAULT_STATE, data[STATE_KEY] || {});
    if (!st.deviceId) {
      st.deviceId = genDeviceId();
      await chrome.storage.local.set({ [STATE_KEY]: st });
    }
    return Object.assign({}, st, { dirty: Boolean(data[DIRTY_KEY]) });
  }

  async function patchState(partial) {
    const cur = await getState();
    const { dirty: _omit, ...rest } = cur;
    const next = Object.assign({}, rest, partial || {});
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }

  // 规范化条目字段，防止远端或历史数据缺字段
  function sanitizeEntry(raw, fallbackUrl) {
    return Store.sanitizeEntry(raw, fallbackUrl);
  }

  // 清洗整个 links 映射（供 force-pull 使用，防止损坏远端 JSON 导致扩展崩溃）
  function sanitizeLinksMap(rawLinks) {
    const out = {};
    if (!isPlainObject(rawLinks)) return out;
    for (const [key, val] of Object.entries(rawLinks)) {
      const clean = sanitizeEntry(val, key);
      if (clean) out[clean.url] = clean;
    }
    return out;
  }

  function entryEqual(a, b) {
    if (!a || !b) return false;
    if (a.url !== b.url || a.title !== b.title || a.note !== b.note) return false;
    if (a.savedAt !== b.savedAt || a.updatedAt !== b.updatedAt) return false;
    const ta = a.tags || [], tb = b.tags || [];
    if (ta.length !== tb.length) return false;
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
    return true;
  }

  // 严格全序平局比较器（满足交换律与传递性，确保两端合并结果一致）
  function compareEntriesTie(a, b) {
    if (a.note.length !== b.note.length) return a.note.length - b.note.length;
    if (a.tags.length !== b.tags.length) return a.tags.length - b.tags.length;
    const sa = `${a.title}\0${a.note}\0${a.tags.join('\0')}`;
    const sb = `${b.title}\0${b.note}\0${b.tags.join('\0')}`;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function arrayEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function mapEqualNumbers(a, b) {
    const ka = Object.keys(a || {});
    const kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
  }

  // 纯函数：合并本地与远端快照（条目级 LWW + 墓碑表）
  function mergeSnapshots(local, remote) {
    const now = Date.now();
    const localLinks = isPlainObject(local && local.links) ? local.links : {};
    const localTombs = Store.pruneTombstones((local && local.tombstones) || {}, now);
    const localQT = (local && local.quickTags) || { items: [], updatedAt: 0 };

    const validRemote = isPlainObject(remote);
    const remoteLinks = validRemote && isPlainObject(remote.links) ? remote.links : {};
    const remoteTombs = Store.pruneTombstones(validRemote ? (remote.tombstones || {}) : {}, now);
    const remoteQT = (validRemote && isPlainObject(remote.quickTags) && Array.isArray(remote.quickTags.items))
      ? { items: Store.normalizeTags(remote.quickTags.items), updatedAt: Number(remote.quickTags.updatedAt) || 0 }
      : { items: null, updatedAt: 0 };

    const allUrls = new Set([
      ...Object.keys(localLinks),
      ...Object.keys(remoteLinks),
      ...Object.keys(localTombs),
      ...Object.keys(remoteTombs),
    ]);

    const mergedLinks = {};
    const mergedTombs = {};
    let pulledAdded = 0;
    let pulledUpdated = 0;
    let pulledDeleted = 0;
    let pushedChanges = 0;
    let localChanged = false;
    let remoteChanged = !validRemote;

    for (const url of allUrls) {
      const l = sanitizeEntry(localLinks[url], url);
      const r = sanitizeEntry(remoteLinks[url], url);
      const lt = Number(localTombs[url]) || 0;
      const rt = Number(remoteTombs[url]) || 0;
      const deletedAt = Math.max(lt, rt);

      let winner = null;
      if (l && r) {
        if (l.updatedAt > r.updatedAt) winner = { ...l };
        else if (r.updatedAt > l.updatedAt) winner = { ...r };
        else winner = compareEntriesTie(r, l) > 0 ? { ...r } : { ...l };
        // 保留更早的首次收藏时间，保证日报/周报口径稳定
        winner.savedAt = Math.min(l.savedAt, r.savedAt);
      } else if (l) {
        winner = { ...l };
      } else if (r) {
        winner = { ...r };
      }

      const alive = winner && winner.updatedAt > deletedAt;
      if (alive) {
        mergedLinks[url] = winner;
        if (!l) {
          localChanged = true;
          pulledAdded++;
        } else if (!entryEqual(l, winner)) {
          localChanged = true;
          pulledUpdated++;
        }
        if (!r || !entryEqual(r, winner)) {
          remoteChanged = true;
          pushedChanges++;
        }
        if (lt > 0) localChanged = true;
        if (rt > 0) remoteChanged = true;
      } else if (deletedAt > 0) {
        mergedTombs[url] = deletedAt;
        if (l) {
          localChanged = true;
          pulledDeleted++;
        } else if (lt !== deletedAt) {
          localChanged = true;
        }
        if (r) {
          remoteChanged = true;
          pushedChanges++;
        } else if (rt !== deletedAt) {
          remoteChanged = true;
        }
      }
    }

    // 合并快捷标签
    let mergedQT = { items: Store.normalizeTags(localQT.items || []), updatedAt: Number(localQT.updatedAt) || 0 };
    if (remoteQT.items) {
      if (remoteQT.updatedAt > mergedQT.updatedAt) {
        mergedQT = { items: remoteQT.items, updatedAt: remoteQT.updatedAt };
        if (!arrayEqual(localQT.items || [], mergedQT.items) || localQT.updatedAt !== mergedQT.updatedAt) {
          localChanged = true;
        }
      } else if (mergedQT.updatedAt > remoteQT.updatedAt) {
        remoteChanged = true;
      } else if (!arrayEqual(remoteQT.items, mergedQT.items)) {
        // 两者 updatedAt 相等但内容不同：用确定性字典序裁决，避免双端震荡
        const rk = remoteQT.items.join('\0');
        const lk = mergedQT.items.join('\0');
        if (rk > lk) {
          mergedQT = { items: remoteQT.items, updatedAt: remoteQT.updatedAt };
          localChanged = true;
        } else {
          remoteChanged = true;
        }
      }
    } else if (mergedQT.items.length) {
      remoteChanged = true;
    }

    if (!mapEqualNumbers(localTombs, mergedTombs)) localChanged = true;
    if (!mapEqualNumbers(remoteTombs, mergedTombs)) remoteChanged = true;

    return {
      merged: {
        links: mergedLinks,
        tombstones: mergedTombs,
        quickTags: mergedQT,
      },
      localChanged,
      remoteChanged,
      stats: { pulledAdded, pulledUpdated, pulledDeleted, pushedChanges },
    };
  }

  function buildRemotePayload(snapshot, deviceId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(),
      lastDeviceId: deviceId,
      links: snapshot.links || {},
      tombstones: snapshot.tombstones || {},
      quickTags: {
        items: (snapshot.quickTags && snapshot.quickTags.items) || [],
        updatedAt: (snapshot.quickTags && snapshot.quickTags.updatedAt) || 0,
      },
    };
  }

  async function readLocalSnapshot() {
    const [links, tombstones, qt, rev, st] = await Promise.all([
      Store.loadAll(),
      Store.loadTombstones(),
      Store.quickTagsState(),
      Store.getLocalRev(),
      chrome.storage.local.get(DIRTY_KEY),
    ]);
    return {
      links,
      tombstones,
      quickTags: qt,
      rev,
      dirty: Boolean(st[DIRTY_KEY]),
    };
  }

  function formatSummary({ pulledAdded, pulledUpdated, pulledDeleted, pushedChanges }, direction) {
    if (direction === 'force-pull') return '已用远端数据覆盖本地';
    if (direction === 'force-push') return '已用本地数据覆盖远端';
    const parts = [];
    if (pulledAdded) parts.push(`新增 ${pulledAdded}`);
    if (pulledUpdated) parts.push(`更新 ${pulledUpdated}`);
    if (pulledDeleted) parts.push(`删除 ${pulledDeleted}`);
    if (pushedChanges) parts.push(`上传 ${pushedChanges}`);
    return parts.length ? parts.join('，') : '已是最新';
  }

  async function hasOriginPermission(cfg) {
    if (!chrome.permissions || !chrome.permissions.contains) return true;
    const { originPattern } = WebDAVProvider.buildUrls(cfg);
    return chrome.permissions.contains({ origins: [originPattern] });
  }

  // 跨上下文互斥锁：优先使用浏览器原生 Web Locks API（SW 与管理页共享）
  function withSyncLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request(LOCK_NAME, fn);
    }
    return fn();
  }

  async function runSyncOnce(cfg, st, direction) {
    if (direction === 'force-push') {
      const local = await readLocalSnapshot();
      const payload = buildRemotePayload(local, st.deviceId);
      const res = await WebDAVProvider.push(cfg, payload);
      // 仅当推送期间没有产生新的本地写入时才清脏标记
      await Store.clearDirtyIfRev(local.rev);
      return { etag: res.etag, summary: formatSummary({}, direction) };
    }

    const remoteRes = await WebDAVProvider.pull(cfg);

    if (direction === 'force-pull') {
      if (!remoteRes.exists || !isPlainObject(remoteRes.data)) {
        throw new Error('远端尚无有效的 data.json，无法从远端覆盖');
      }
      const r = remoteRes.data;
      if (r.links !== undefined && !isPlainObject(r.links)) {
        throw new Error('远端 data.json 格式异常：links 字段无效');
      }
      const cleanLinks = sanitizeLinksMap(r.links || {});
      const cleanTombs = Store.pruneTombstones(r.tombstones || {});
      const hasQT = isPlainObject(r.quickTags) && Array.isArray(r.quickTags.items);
      const qtUpdated = hasQT && Number.isFinite(Number(r.quickTags.updatedAt))
        ? Number(r.quickTags.updatedAt)
        : 0;
      await Store.applySyncedSnapshot({
        links: cleanLinks,
        tombstones: cleanTombs,
        quickTags: hasQT ? r.quickTags.items : undefined,
        quickTagsUpdatedAt: qtUpdated,
        clearDirty: true,
      });
      return { etag: remoteRes.etag, summary: formatSummary({}, direction) };
    }

    // 标准双向合并：在网络 pull 完成后再读取最新本地快照，彻底规避 pull 期间的本地写入被覆盖
    let mergedResult = null;
    let appliedRev = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      const local = await readLocalSnapshot();

      // 若 ETag 未变且最新本地状态无变更，直接短路返回
      if (remoteRes.exists && remoteRes.etag && remoteRes.etag === st.lastEtag && !local.dirty) {
        return { etag: remoteRes.etag, summary: '已是最新' };
      }

      const m = mergeSnapshots(local, remoteRes.data);
      if (m.localChanged) {
        const res = await Store.applySyncedSnapshot({
          links: m.merged.links,
          tombstones: m.merged.tombstones,
          quickTags: m.merged.quickTags.items,
          quickTagsUpdatedAt: m.merged.quickTags.updatedAt,
          expectedRev: local.rev,
          clearDirty: !m.remoteChanged,
        });
        if (!res.applied) {
          // 写回瞬间发生了本地写入，重读最新快照再合并
          continue;
        }
        appliedRev = res.rev;
      } else {
        appliedRev = local.rev;
        if (local.dirty && !m.remoteChanged) {
          await Store.clearDirtyIfRev(local.rev);
        }
      }

      mergedResult = m;
      break;
    }

    if (!mergedResult) {
      throw new Error('本地数据正在频繁变更，请稍后重试同步');
    }

    let nextEtag = remoteRes.etag;
    if (mergedResult.remoteChanged) {
      const payload = buildRemotePayload(mergedResult.merged, st.deviceId);
      const pushRes = await WebDAVProvider.push(cfg, payload, {
        etag: remoteRes.exists ? remoteRes.etag : null,
      });
      // 坚果云 PUT 可能不回传 ETag，清空 lastEtag 让下次拉取刷新即可
      nextEtag = pushRes.etag || null;
      // 仅当 push 耗时期间无新的本地修改时才清 syncDirty
      await Store.clearDirtyIfRev(appliedRev);
    }

    return { etag: nextEtag, summary: formatSummary(mergedResult.stats, direction) };
  }

  async function syncNow({ direction = 'merge', reason = 'manual' } = {}) {
    if (inFlight) return inFlight;

    inFlight = withSyncLock(async () => {
      const cfg = await getConfig();
      if (!cfg.enabled && direction === 'merge' && reason !== 'manual') {
        return { ok: false, skipped: true, reason: 'disabled' };
      }
      if (!cfg.url || !cfg.username || !cfg.password) {
        const msg = '请先在设置中填写完整的 WebDAV 服务器地址、账户与密码';
        await patchState({ status: 'error', syncStartedAt: 0, lastSyncAt: Date.now(), lastError: msg });
        return { ok: false, error: msg };
      }

      const granted = await hasOriginPermission(cfg);
      if (!granted) {
        const msg = '尚未授予该 WebDAV 域名的访问权限，请在同步设置中点击「测试连接并授权」';
        await patchState({ status: 'error', syncStartedAt: 0, lastSyncAt: Date.now(), lastError: msg });
        return { ok: false, error: msg };
      }

      const st = await getState();
      await patchState({ status: 'syncing', syncStartedAt: Date.now(), lastError: '' });

      try {
        let result;
        try {
          result = await runSyncOnce(cfg, st, direction);
        } catch (err) {
          // 若遇并发写入 412 冲突，自动重新拉取合并再推一次
          if (err && err.code === 'CONFLICT' && direction === 'merge') {
            result = await runSyncOnce(cfg, Object.assign({}, st, { lastEtag: null }), direction);
          } else {
            throw err;
          }
        }
        const now = Date.now();
        await patchState({
          status: 'ok',
          syncStartedAt: 0,
          lastSyncAt: now,
          lastSuccessAt: now,
          lastEtag: result.etag,
          lastError: '',
          lastSummary: result.summary,
        });
        return { ok: true, summary: result.summary };
      } catch (err) {
        const msg = (err && err.message) || String(err);
        await patchState({
          status: 'error',
          syncStartedAt: 0,
          lastSyncAt: Date.now(),
          lastError: msg,
        });
        return { ok: false, error: msg };
      }
    }).finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return {
    DEFAULT_CONFIG,
    DEFAULT_STATE,
    STALE_SYNC_MS,
    isStaleSyncing,
    getConfig,
    saveConfig,
    getState,
    patchState,
    mergeSnapshots,
    syncNow,
  };
})();
