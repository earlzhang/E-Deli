importScripts('store.js', 'sync/provider-webdav.js', 'sync/engine.js');

// ===== 右键菜单 =====
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'edeli-page', title: '保存到 E-Deli', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'edeli-link', title: '收藏链接到 E-Deli', contexts: ['link'] });
  });
}
chrome.runtime.onInstalled.addListener(setupMenus); // 菜单注册持久，无需顶层重复调用

// 打开收藏弹窗：优先 action popup，失败则开小窗（pendingSave 走 storage，不依赖 URL 参数）
async function openSavePopup() {
  try {
    await chrome.action.openPopup();
  } catch (e) {
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup', width: 420, height: 540, focused: true,
    });
  }
}

// 向 content script 询问选中文本与公众号名（受限页面无 content script 时返回空）
async function pageMetaOf(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'edeli:selection' });
    return { text: (r && r.text) || '', wxName: (r && r.wxName) || '' };
  } catch (e) { return { text: '', wxName: '' }; }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url = '', title = '', note = '';
  if (info.menuItemId === 'edeli-link' && info.linkUrl) {
    url = info.linkUrl;
    if (tab && typeof tab.id === 'number') {
      try {
        const msgOpts = typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined;
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'edeli:link-meta' }, msgOpts);
        if (r && r.url === url) title = r.text || '';
      } catch (e) { /* 受限页面无 content script，忽略 */ }
    }
    title = title || url;
    // 收藏链接入口仅使用右键附带的显式选区，不读取当前页其他无关划词
    note = (info.selectionText || '').trim();
  } else if (info.menuItemId === 'edeli-page') {
    url = info.pageUrl || (tab && tab.url) || '';
    title = (tab && tab.title) || url;
    if (!url) return;
    // 页面选中文本自动作为备注；当前页是公众号文章时标题追加「｜ 公众号名」
    const meta = tab && typeof tab.id === 'number' ? await pageMetaOf(tab.id) : { text: '', wxName: '' };
    note = (info.selectionText || '').trim() || meta.text;
    title = Store.wxTitle(title, url, meta.wxName);
  }
  if (!url) return;
  await chrome.storage.local.set({ pendingSave: { url, title, note, at: Date.now() } });
  openSavePopup();
});

// ===== 快捷键 =====
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'save-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  const meta = await pageMetaOf(tab.id);
  await chrome.storage.local.set({
    pendingSave: {
      url: tab.url,
      title: Store.wxTitle(tab.title || tab.url, tab.url, meta.wxName),
      note: meta.text,
      at: Date.now(),
    },
  });
  openSavePopup();
});

// ===== 图标 badge：今日收藏数 =====
async function refreshBadge() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const n = await Store.countSince(today.getTime());
  await chrome.action.setBadgeBackgroundColor({ color: '#0b57d0' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// ===== WebDAV 自动同步调度（防抖推送 + 定时拉取 + 启动同步） =====
const ALARM_PULL = 'edeli-sync-pull';
const ALARM_PUSH = 'edeli-sync-push';

// 仅在配置变动或闹钟不存在/周期不一致时重建，避免 Service Worker 唤醒重置定时拉取倒计时
async function schedulePullAlarm({ force = false } = {}) {
  const cfg = await SyncEngine.getConfig();
  const enabled = Boolean(cfg.enabled && cfg.mode === 'auto' && Number(cfg.pullIntervalMin) > 0);
  if (!enabled) {
    await chrome.alarms.clear(ALARM_PULL);
    return;
  }
  const period = Math.max(1, Number(cfg.pullIntervalMin));
  if (!force) {
    const existing = await chrome.alarms.get(ALARM_PULL);
    if (existing && existing.periodInMinutes === period) return;
  }
  await chrome.alarms.clear(ALARM_PULL);
  chrome.alarms.create(ALARM_PULL, { periodInMinutes: period });
}

async function scheduleDebouncedPush() {
  const cfg = await SyncEngine.getConfig();
  if (!cfg.enabled || cfg.mode !== 'auto') return;
  const sec = Number(cfg.pushDebounceSec);
  if (!sec || sec <= 0) return;
  await chrome.alarms.clear(ALARM_PUSH);
  // Chromium 120+ 支持 30 秒（0.5 分钟）alarm
  chrome.alarms.create(ALARM_PUSH, { delayInMinutes: Math.max(0.5, sec / 60) });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_PULL) {
    refreshBadge();
    await SyncEngine.syncNow({ direction: 'merge', reason: 'alarm-pull' });
  } else if (alarm.name === ALARM_PUSH) {
    const st = await SyncEngine.getState();
    if (st.dirty) {
      await SyncEngine.syncNow({ direction: 'merge', reason: 'alarm-push' });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 纵深防御：仅接受来自扩展自身特权页面的同步控制指令，拒绝网页 content script 上下文
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return;
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'edeli:sync-now') {
    SyncEngine.syncNow({
      direction: msg.direction || 'merge',
      reason: msg.reason || 'manual',
    }).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'edeli:sync-reschedule') {
    schedulePullAlarm({ force: true })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.links) refreshBadge();
  if (changes.syncConfig) schedulePullAlarm({ force: true });
  if (changes.syncDirty && changes.syncDirty.newValue === true) {
    scheduleDebouncedPush();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
  schedulePullAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  refreshBadge();
  await schedulePullAlarm();
  const cfg = await SyncEngine.getConfig();
  if (cfg.enabled && cfg.mode === 'auto') {
    SyncEngine.syncNow({ direction: 'merge', reason: 'startup' });
  }
});
