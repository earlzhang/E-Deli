// content.js — 记录最近一次右键点击的链接；响应页面选区与公众号元数据查询
let lastLink = null;

document.addEventListener('contextmenu', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  lastLink = a ? { url: a.href, text: (a.innerText || a.textContent || '').trim() } : null;
}, true);

// 公众号名：#js_name 锚点的首个文本节点（后面跟着复制按钮，不能直接取整体 textContent）
function wxAccount() {
  const a = document.querySelector('#js_name');
  if (!a) return '';
  for (const n of a.childNodes) {
    const t = (n.textContent || '').trim();
    if (t) return t.replace(/\s+/g, ' ');
  }
  return '';
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg && msg.type === 'edeli:link-meta') send(lastLink);
  if (msg && msg.type === 'edeli:selection') {
    send({ text: (getSelection().toString() || '').trim(), wxName: wxAccount() });
  }
});
