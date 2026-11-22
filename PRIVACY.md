# E-Deli 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-11-22

---

## 中文声明

**E-Deli** 是一款纯本地运行的浏览器书签收藏与知识整理扩展。我们高度重视您的隐私：

1. **零数据收集与零网络上传**：本扩展不包含任何远程服务器接口、第三方统计（Analytics）或广告追踪代码。您收藏的网页标题、网址、标签、书摘备注及快捷标签配置，全部仅保存在您当前浏览器的本地存储（`chrome.storage.local`）与本地偏好（`localStorage`）中，绝不会离开您的设备。
2. **权限使用说明（最小必要原则）**：
   - `storage`：在本地保存与管理您的书签、标签及快捷标签列表。
   - `activeTab`：仅在您主动点击扩展图标、使用快捷键或右键菜单时，读取当前活动标签页的标题与网址。
   - `contextMenus`：提供右键「保存到 E-Deli」与「收藏链接到 E-Deli」菜单入口。
   - `downloads`：用于将您主动导出的 Markdown 汇总（`.md`）与 JSON 备份文件保存到本地下载目录。
   - `clipboardWrite`：用于您点击「复制」时将 Markdown 汇总写入系统剪贴板。
   - 网页内容脚本（`content_scripts`）：仅在您主动触发收藏操作时，响应扩展请求以获取当前页面的选中文本（作为备注）、微信公众号文章号名，或记录您最近一次右键点击的链接文字；不会在后台静默扫描或采集浏览历史。
3. **数据控制权**：您可以随时在管理页导出 JSON 全量备份，或删除单条、批量书签；卸载扩展后本地数据将由浏览器自动清除。

如有任何疑问或反馈，欢迎通过本项目的 GitHub Issues 联系开发者。

---

## English Statement

**E-Deli** is a purely local-first browser bookmarking and knowledge organization extension. We respect your privacy:

1. **No Data Collection & No Network Transmission**: E-Deli has no backend servers, no third-party analytics, and no tracking scripts. All saved bookmarks, URLs, tags, notes, and preferences are stored strictly locally in your browser (`chrome.storage.local` and `localStorage`) and never leave your device.
2. **Permissions Justification**:
   - `storage`: Stores and manages your bookmarks, tags, and quick tags locally.
   - `activeTab`: Reads the current active tab's title and URL only when you explicitly trigger saving (via toolbar icon, keyboard shortcut, or context menu).
   - `contextMenus`: Adds right-click menu items to save the current page or a link.
   - `downloads`: Saves user-initiated Markdown digests (`.md`) and JSON backups to your local downloads folder.
   - `clipboardWrite`: Copies user-initiated Markdown digests to the system clipboard.
   - `content_scripts`: Responds only when you trigger a save action to read selected text (as a note), WeChat Official Account author name (`#js_name`), or the text of the link you right-clicked. It never passively monitors or collects browsing history.
3. **Full User Control**: You can export all data as JSON, edit or delete any bookmark at any time, or uninstall the extension to remove all local data.

For questions or feedback, please open an issue on this project's GitHub repository.
