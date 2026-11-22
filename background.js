importScripts('store.js');

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
  let url = '', title = '';
  if (info.menuItemId === 'edeli-link' && info.linkUrl) {
    url = info.linkUrl;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'edeli:link-meta' });
      if (r && r.url === url) title = r.text || '';
    } catch (e) { /* 受限页面无 content script，忽略 */ }
    title = title || url;
  } else if (info.menuItemId === 'edeli-page') {
    url = info.pageUrl || (tab && tab.url) || '';
    title = (tab && tab.title) || url;
  }
  if (!url) return;
  // 页面选中文本自动作为备注；当前页是公众号文章时标题追加「｜ 公众号名」
  // （链接入口不追加——目标是它页，拿不到目标页的公众号名）
  const meta = tab ? await pageMetaOf(tab.id) : { text: '', wxName: '' };
  const note = (info.selectionText || '').trim() || meta.text;
  if (info.menuItemId === 'edeli-page') title = Store.wxTitle(title, url, meta.wxName);
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.links) refreshBadge();
});
chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
refreshBadge();
