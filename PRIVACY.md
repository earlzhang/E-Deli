# E-Deli 隐私政策 / Privacy Policy

最后更新 / Last updated: 2026-11-23

---

## 中文声明

**E-Deli** 是一款本地优先（Local-First）的浏览器书签收藏与知识整理扩展。我们高度重视您的隐私：

1. **零开发者数据收集**：本扩展不包含任何开发者后端服务器、第三方统计（Analytics）或广告追踪代码。默认情况下，您收藏的网页标题、网址、标签、书摘备注及快捷标签配置，全部仅保存在当前浏览器的本地存储（`chrome.storage.local`）与本地偏好（`localStorage`）中。
2. **可选的 WebDAV 自主云同步**：本扩展提供**默认关闭**的 WebDAV 云同步功能。仅当您在「设置」中主动开启并填写您自己的 WebDAV 服务地址（如坚果云或个人 NAS）、账户与密码，且在浏览器弹窗中明确授予该特定域名的访问权限后，扩展才会直接与您指定的 WebDAV 服务器通信以同步 `data.json`。您的凭据仅存储在本机 `chrome.storage.local` 中，绝不会发送给开发者或任何其他第三方。
3. **权限使用说明（最小必要原则）**：
   - `storage`：在本地保存与管理您的书签、删除墓碑记录、快捷标签及同步配置。
   - `activeTab`：仅在您主动点击扩展图标、使用快捷键或右键菜单时，读取当前活动标签页的标题与网址。
   - `contextMenus`：提供右键「保存到 E-Deli」与「收藏链接到 E-Deli」菜单入口。
   - `downloads`：用于将您主动导出的 Markdown 汇总（`.md`）与 JSON 备份文件保存到本地下载目录。
   - `clipboardWrite`：用于您点击「复制」时将 Markdown 汇总写入系统剪贴板。
   - `alarms`：仅在您主动启用 WebDAV 自动同步后，用于调度变更防抖推送与定时拉取任务。
   - 可选域名权限（`optional_host_permissions`）：安装时默认不申请任何网站的网络访问权限；仅当您配置并授权自己的 WebDAV 服务器时，按需申请该单一域名的访问权限。
   - 网页内容脚本（`content_scripts`）：仅在您主动触发收藏操作时，响应扩展请求以获取当前页面的选中文本（作为备注）、微信公众号文章号名，或记录您最近一次右键点击的链接文字；不会在后台静默扫描或采集浏览历史。
4. **数据控制权**：您可以随时在管理页导出 JSON 全量备份（不包含 WebDAV 凭据）、关闭同步、或删除单条/批量书签；卸载扩展后本地数据将由浏览器自动清除。

如有任何疑问或反馈，欢迎通过本项目的 GitHub Issues 联系开发者。

---

## English Statement

**E-Deli** is a local-first browser bookmarking and knowledge organization extension. We respect your privacy:

1. **Zero Developer Data Collection**: E-Deli has no developer-operated backend servers, no third-party analytics, and no tracking scripts. By default, all saved bookmarks, URLs, tags, notes, and preferences are stored strictly locally in your browser (`chrome.storage.local` and `localStorage`).
2. **Optional Self-Hosted WebDAV Sync**: E-Deli offers an **opt-in (disabled by default)** WebDAV sync feature. Only when you explicitly enable sync, configure your own WebDAV server (such as Jianguoyun or a personal NAS), and grant host permission for that specific origin will the extension communicate directly with your chosen server to synchronize `data.json`. Your credentials remain strictly in local `chrome.storage.local` and are never transmitted to the developer or any third party.
3. **Permissions Justification**:
   - `storage`: Stores and manages your bookmarks, deletion tombstones, quick tags, and sync settings locally.
   - `activeTab`: Reads the current active tab's title and URL only when you explicitly trigger saving (via toolbar icon, keyboard shortcut, or context menu).
   - `contextMenus`: Adds right-click menu items to save the current page or a link.
   - `downloads`: Saves user-initiated Markdown digests (`.md`) and JSON backups to your local downloads folder.
   - `clipboardWrite`: Copies user-initiated Markdown digests to the system clipboard.
   - `alarms`: Schedules debounced auto-push and periodic auto-pull tasks only when you opt in to WebDAV auto-sync.
   - `optional_host_permissions`: Not granted at install time; requested on demand solely for the specific origin of the WebDAV server you configure.
   - `content_scripts`: Responds only when you trigger a save action to read selected text (as a note), WeChat Official Account author name (`#js_name`), or the text of the link you right-clicked. It never passively monitors or collects browsing history.
4. **Full User Control**: You can export all bookmarks as JSON (excluding WebDAV credentials), disable sync, edit or delete any bookmark at any time, or uninstall the extension to remove all local data.

For questions or feedback, please open an issue on this project's GitHub repository.
