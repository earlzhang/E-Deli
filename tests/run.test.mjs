// tests/run.test.mjs — E-Deli 核心模块回归测试（Node 原生 node:test，零外部依赖）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plain = v => structuredClone(v);

function createSandbox({ fetchImpl } = {}) {
  const storageData = {};

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return structuredClone(storageData);
          if (typeof keys === 'string') {
            return keys in storageData ? { [keys]: structuredClone(storageData[keys]) } : {};
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
              if (k in storageData) out[k] = structuredClone(storageData[k]);
            }
            return out;
          }
          const out = {};
          for (const [k, defVal] of Object.entries(keys)) {
            out[k] = k in storageData ? structuredClone(storageData[k]) : defVal;
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            storageData[k] = structuredClone(v);
          }
        },
        async remove(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete storageData[k];
        },
      },
    },
    permissions: {
      async contains() { return true; },
    },
  };

  const ctx = vm.createContext({
    chrome,
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    URL,
    TextEncoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    console,
    navigator: {},
  });

  for (const rel of ['store.js', 'digest.js', 'sync/provider-webdav.js', 'sync/engine.js']) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }

  return {
    Store: vm.runInContext('Store', ctx),
    Digest: vm.runInContext('Digest', ctx),
    WebDAVProvider: vm.runInContext('WebDAVProvider', ctx),
    SyncEngine: vm.runInContext('SyncEngine', ctx),
    storageData,
  };
}

// ===== Store 测试 =====
test('Store: normalizeTags 切分并大小写不敏感去重', () => {
  const { Store } = createSandbox();
  assert.deepEqual(
    plain(Store.normalizeTags('A股, a股，大模型  基金')),
    ['A股', '大模型', '基金']
  );
  assert.deepEqual(
    plain(Store.normalizeTags(['AI 大模型', 'ai', '基金,指数'])),
    ['AI', '大模型', '基金', '指数']
  );
});

test('Store: URL 协议安全校验与拦截', async () => {
  const { Store } = createSandbox();
  assert.equal(Store.isSafeHref('https://example.com/a'), true);
  assert.equal(Store.isSafeHref('http://localhost:8080'), true);
  assert.equal(Store.isSafeHref('javascript:alert(1)'), false);
  assert.equal(Store.isSafeHref('data:text/html,hi'), false);
  assert.equal(Store.isSafeHref('example.com'), false);

  await assert.rejects(
    () => Store.upsert({ url: 'javascript:alert(1)', title: 'xss' }),
    /不支持的网址协议/
  );
});

test('Store: importEntries 兼容 ISO 日期、避免 NaN 并清理墓碑', async () => {
  const { Store } = createSandbox();
  await Store.upsert({ url: 'https://a.com', title: 'A', tags: ['t1'] });
  await Store.remove('https://a.com');
  assert.ok('https://a.com' in await Store.loadTombstones());

  const res = await Store.importEntries([
    { url: 'https://a.com', title: 'A restored', savedAt: '2025-05-01T08:00:00Z', tags: ['t2'] },
    { url: 'https://b.com', title: 'Bad date', savedAt: 'not-a-date', tags: null },
    { url: 'javascript:alert(1)', title: 'XSS' },
  ]);

  assert.equal(res.added, 2);
  assert.equal(res.skipped, 1);
  const links = await Store.loadAll();
  const tombs = await Store.loadTombstones();
  assert.equal('https://a.com' in tombs, false);
  assert.equal(Number.isFinite(links['https://a.com'].savedAt), true);
  assert.equal(links['https://a.com'].savedAt, Date.parse('2025-05-01T08:00:00Z'));
  assert.equal(Number.isFinite(links['https://b.com'].savedAt), true);
  assert.deepEqual(links['https://b.com'].tags, []);
});

test('Store: renameTag 拒绝空格并原子更新 links 与 quickTags', async () => {
  const { Store } = createSandbox();
  await Store.upsert({ url: 'https://a.com', title: 'A', tags: ['大模型'] });
  await assert.rejects(() => Store.renameTag('大模型', 'AI 模型'), /不能包含空格或逗号/);

  const changed = await Store.renameTag('大模型', 'LLM');
  assert.equal(changed, 1);
  const links = await Store.loadAll();
  const qTags = await Store.quickTags();
  assert.deepEqual(links['https://a.com'].tags, ['LLM']);
  assert.ok(qTags.includes('LLM'));
  assert.ok(!qTags.includes('大模型'));
});

test('Store: applySyncedSnapshot 保留 quickTagsUpdatedAt=0 且校验 expectedRev', async () => {
  const { Store } = createSandbox();
  const rev0 = await Store.getLocalRev();
  const ok = await Store.applySyncedSnapshot({
    links: {},
    tombstones: {},
    quickTags: ['A股'],
    quickTagsUpdatedAt: 0,
    expectedRev: rev0,
  });
  assert.equal(ok.applied, true);
  const qt = await Store.quickTagsState();
  assert.equal(qt.updatedAt, 0);

  // 模拟并发写入推进 rev
  await Store.upsert({ url: 'https://new.com', title: 'New' });
  const conflict = await Store.applySyncedSnapshot({
    links: {},
    tombstones: {},
    expectedRev: ok.rev,
  });
  assert.equal(conflict.applied, false);
  assert.ok('https://new.com' in await Store.loadAll());
});

// ===== Digest 测试 =====
test('Digest: ISO 周跨年年份正确（2024-12-30 归属 2025-W01，2020-12-31 归属 2020-W53）', () => {
  const { Digest } = createSandbox();
  const w1 = Digest.render([], { kind: 'weekly', day: '2024-12-30' });
  assert.equal(w1.filename, 'e-deli-2025-W01.md');
  assert.match(w1.markdown, /2025 年第 1 周/);

  const w53 = Digest.render([], { kind: 'weekly', day: '2020-12-31' });
  assert.equal(w53.filename, 'e-deli-2020-W53.md');
  assert.match(w53.markdown, /2020 年第 53 周/);
});

test('Digest: range 倒序自动交换 & formatLine 正确转义标题/URL括号/标签反引号', () => {
  const { Digest } = createSandbox();
  const ts = new Date('2026-06-15T12:00:00').getTime();
  const entry = {
    url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
    title: 'Rust [lang]\nIntro\\1',
    tags: ['rust', 'a`b'],
    note: 'line1\r\nline2',
    savedAt: ts,
  };
  const line = Digest.formatLine(entry);
  assert.equal(
    line,
    '- [Rust \\[lang\\] Intro\\\\1](https://en.wikipedia.org/wiki/Rust_%28programming_language%29) `rust` `` a`b ``\n  > line1\n  > line2'
  );

  const rangeRes = Digest.render([entry], { kind: 'range', start: '2026-06-20', end: '2026-06-10' });
  assert.equal(rangeRes.count, 1);
  assert.equal(rangeRes.filename, 'e-deli-2026-06-10_2026-06-20.md');
});

test('Digest: flat 模式不显示日期标题直接输出列表 & selection 无标题时不输出 H1', () => {
  const { Digest } = createSandbox();
  const e1 = {
    url: 'https://a.com',
    title: 'Article A',
    tags: ['t1'],
    note: '',
    savedAt: new Date('2026-06-10T10:00:00').getTime(),
  };
  const e2 = {
    url: 'https://b.com',
    title: 'Article B',
    tags: [],
    note: 'memo',
    savedAt: new Date('2026-06-12T15:00:00').getTime(),
  };

  // selection 无 title，默认按天分组但不含 H1
  const selDated = Digest.render([e1, e2], { kind: 'selection', title: '' });
  assert.equal(selDated.markdown.startsWith('## '), true);
  assert.equal(selDated.markdown.includes('# E-Deli'), false);

  // selection + flat：直接平铺列表，按 savedAt 降序，无任何标题和日期
  const selFlat = Digest.render([e1, e2], { kind: 'selection', title: '', flat: true });
  assert.equal(
    selFlat.markdown,
    '- [Article B](https://b.com)\n  > memo\n- [Article A](https://a.com) `t1`\n'
  );

  // daily / weekly / range + flat 均无标题和日期
  const dailyFlat = Digest.render([e1], { kind: 'daily', day: '2026-06-10', flat: true });
  assert.equal(dailyFlat.markdown, '- [Article A](https://a.com) `t1`\n');

  const weeklyFlat = Digest.render([e1, e2], { kind: 'weekly', day: '2026-06-10', flat: true });
  assert.equal(weeklyFlat.count, 2);
  assert.equal(weeklyFlat.markdown.includes('#'), false);

  const rangeFlat = Digest.render([e1, e2], { kind: 'range', start: '2026-06-10', end: '2026-06-12', flat: true });
  assert.equal(rangeFlat.count, 2);
  assert.equal(rangeFlat.markdown.includes('#'), false);

  // 空数据
  const emptyFlat = Digest.render([], { kind: 'selection', flat: true });
  assert.equal(emptyFlat.markdown, '（本期无收藏）\n');
});

// ===== WebDAVProvider 测试 =====
test('WebDAVProvider: 目录穿越防护、HTTP 安全性判断、404 建目录去 If-Match、PROPFIND 带 body', async () => {
  const calls = [];
  let putAttempt = 0;
  const { WebDAVProvider } = createSandbox({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (init.method === 'PROPFIND') {
        return { status: 207, ok: true, headers: new Map() };
      }
      if (init.method === 'MKCOL') {
        return { status: 201, ok: true, headers: new Map() };
      }
      if (init.method === 'GET') {
        return { status: 404, ok: false, headers: new Map() };
      }
      if (init.method === 'PUT') {
        putAttempt++;
        if (putAttempt === 1) return { status: 404, ok: false, headers: new Map() };
        return { status: 201, ok: true, headers: new Map([['etag', '"e2"']]) };
      }
      return { status: 500, ok: false, headers: new Map() };
    },
  });

  assert.throws(() => WebDAVProvider.normalizeRemoteDir('../secret'), /不能包含 \. 或 \.\./);
  assert.throws(() => WebDAVProvider.normalizeRemoteDir('a/./b'), /不能包含 \. 或 \.\./);

  assert.equal(WebDAVProvider.isInsecureHttp('http://dav.example.com/dav/'), true);
  assert.equal(WebDAVProvider.isInsecureHttp('https://dav.example.com/dav/'), false);
  assert.equal(WebDAVProvider.isInsecureHttp('http://192.168.1.10:5005/dav/'), false);
  assert.equal(WebDAVProvider.isInsecureHttp('http://localhost:8080/dav/'), false);

  const cfg = { url: 'https://dav.example.com/dav/', remoteDir: 'E-Deli', username: 'u', password: 'p' };
  const testRes = await WebDAVProvider.testConnection(cfg);
  assert.equal(testRes.ok, true);
  assert.match(calls[0].body, /resourcetype/);

  calls.length = 0;
  await WebDAVProvider.push(cfg, { links: {} }, { etag: '"old-etag"' });
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[0].headers['If-Match'], '"old-etag"');
  assert.equal(puts[1].headers['If-Match'], undefined);
});

// ===== SyncEngine 测试 =====
test('SyncEngine: pull/push 耗时期间并发本地写入不丢失、不误清 syncDirty', async () => {
  let remoteDoc = {
    schemaVersion: 2,
    links: {
      'https://remote.com': {
        url: 'https://remote.com',
        title: 'Remote',
        note: '',
        tags: ['r'],
        savedAt: 1000,
        updatedAt: 1000,
      },
    },
    tombstones: {},
    quickTags: { items: ['A股'], updatedAt: 100 },
  };
  let hooks = {};

  const { Store, SyncEngine, storageData } = createSandbox({
    fetchImpl: async (_url, init) => {
      if (init.method === 'GET') {
        if (hooks.onPull) await hooks.onPull();
        return {
          status: 200,
          ok: true,
          headers: new Map([['etag', '"e1"']]),
          async text() { return JSON.stringify(remoteDoc); },
        };
      }
      if (init.method === 'PUT') {
        if (hooks.onPush) await hooks.onPush();
        remoteDoc = JSON.parse(init.body);
        return { status: 200, ok: true, headers: new Map([['etag', '"e2"']]) };
      }
      return { status: 201, ok: true, headers: new Map() };
    },
  });

  await SyncEngine.saveConfig({
    enabled: true,
    url: 'https://dav.example.com/dav/',
    remoteDir: 'E-Deli',
    username: 'u',
    password: 'p',
  });

  // 场景 1：pull 期间本地写入 B，不应被覆盖，且应出现在最终合并与远端结果中
  hooks.onPull = async () => {
    await Store.upsert({ url: 'https://during-pull.com', title: 'During Pull' });
  };
  // 场景 2：push 期间本地写入 C，syncDirty 必须保持 true
  hooks.onPush = async () => {
    await Store.upsert({ url: 'https://during-push.com', title: 'During Push' });
  };

  const res = await SyncEngine.syncNow({ direction: 'merge', reason: 'manual' });
  assert.equal(res.ok, true);

  const localLinks = await Store.loadAll();
  assert.ok('https://remote.com' in localLinks);
  assert.ok('https://during-pull.com' in localLinks);
  assert.ok('https://during-push.com' in localLinks);
  assert.ok('https://during-pull.com' in remoteDoc.links);
  assert.equal(storageData.syncDirty, true);
});

test('SyncEngine: force-pull 清洗脏数据且 mergeSnapshots 平局严格对称', async () => {
  const dirtyRemote = {
    schemaVersion: 2,
    links: {
      'https://ok.com': { url: 'https://ok.com', title: 'OK' }, // 缺 tags / savedAt
      'https://bad.com': null,
      'javascript:alert(1)': { url: 'javascript:alert(1)', title: 'XSS' },
    },
    tombstones: { 'https://old.com': 'bad', 'https://t.com': Date.now() },
    quickTags: { items: ['A股', 'a股'], updatedAt: 0 },
  };

  const { Store, SyncEngine } = createSandbox({
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: new Map([['etag', '"e9"']]),
      async text() { return JSON.stringify(dirtyRemote); },
    }),
  });

  await SyncEngine.saveConfig({
    enabled: true,
    url: 'https://dav.example.com/dav/',
    remoteDir: 'E-Deli',
    username: 'u',
    password: 'p',
  });

  const res = await SyncEngine.syncNow({ direction: 'force-pull', reason: 'manual' });
  assert.equal(res.ok, true);
  const links = await Store.loadAll();
  assert.deepEqual(plain(Object.keys(links)), ['https://ok.com']);
  assert.deepEqual(plain(links['https://ok.com'].tags), []);
  assert.deepEqual(plain(await Store.tagCounts()), {});
  assert.equal((await Store.quickTagsState()).updatedAt, 0);

  // 平局对称性：l.note 更长，r.tags 更多，updatedAt 相等
  const entryA = { url: 'https://x.com', title: 'A', note: 'longer note', tags: ['t1'], savedAt: 100, updatedAt: 500 };
  const entryB = { url: 'https://x.com', title: 'B', note: 'hi', tags: ['t1', 't2', 't3'], savedAt: 200, updatedAt: 500 };
  const m1 = SyncEngine.mergeSnapshots({ links: { 'https://x.com': entryA } }, { links: { 'https://x.com': entryB } });
  const m2 = SyncEngine.mergeSnapshots({ links: { 'https://x.com': entryB } }, { links: { 'https://x.com': entryA } });
  assert.deepEqual(plain(m1.merged.links['https://x.com']), plain(m2.merged.links['https://x.com']));
  assert.equal(m1.merged.links['https://x.com'].savedAt, 100);
});

test('SyncEngine: 变更端点重置状态 & 僵尸 syncing 检测', async () => {
  const { SyncEngine } = createSandbox();
  await SyncEngine.saveConfig({ url: 'https://dav1.example.com/dav/', remoteDir: 'E-Deli', username: 'a' });
  await SyncEngine.patchState({ status: 'ok', lastEtag: '"e1"', lastSuccessAt: 123456 });

  await SyncEngine.saveConfig({ url: 'https://dav2.example.com/dav/' });
  const st = await SyncEngine.getState();
  assert.equal(st.lastEtag, null);
  assert.equal(st.lastSuccessAt, 0);
  assert.equal(st.status, 'idle');

  const now = Date.now();
  assert.equal(SyncEngine.isStaleSyncing({ status: 'syncing', syncStartedAt: now - 10_000 }, now), false);
  assert.equal(SyncEngine.isStaleSyncing({ status: 'syncing', syncStartedAt: now - 120_000 }, now), true);
  assert.equal(SyncEngine.isStaleSyncing({ status: 'syncing', syncStartedAt: 0 }, now), true);
});
