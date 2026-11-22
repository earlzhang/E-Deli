# E-Deli 上架 Edge Add-ons 接力指南

项目已迁移至独立目录：`/Users/earlzhang/pycharm/addons/E-Deli`

---

## 第 0 步：无损迁移你本地原有的 Edge 书签（重要）

因为目录路径变化，在 Edge 重新加载新路径会产生新的扩展 ID：
1. **如果旧路径扩展还在 Edge 里**：先打开它的管理页，点左下角 **「导出备份」** 保存 `e-deli-backup-xxx.json`。
2. 打开 `edge://extensions`，移除旧路径的 `E-Deli`，点击 **「加载解压缩的扩展」** 选择 `/Users/earlzhang/pycharm/addons/E-Deli`。
3. 打开新管理页，点左下角 **「导入备份」** 选回刚才的 `.json` 文件即可完整恢复数据。

---

## 第 1 步：初始化独立 Git 仓库并推到 GitHub 公有仓库

1. 在 GitHub 上新建一个**公开（Public）**空仓库，例如 `E-Deli`（不要勾选添加 README / .gitignore）。
2. 在本目录执行：
   ```bash
   cd /Users/earlzhang/pycharm/addons/E-Deli
   git init -b main
   git add .
   git commit -m "feat: initial public release of E-Deli v0.1.0"
   git remote add origin https://github.com/<你的用户名>/E-Deli.git
   git push -u origin main
   ```
3. 推送完成后，你的隐私政策公开 URL 即为：
   `https://github.com/<你的用户名>/E-Deli/blob/main/PRIVACY.md`

---

## 第 2 步：准备商店视觉素材

- **Store Logo（`300×300` PNG）**：已为你提前生成在 `store-assets/logo-300.png`。
- **功能截图（至少 1 张，推荐 3 张，`1280×800` 或 `1280×720`）**：
  1. 管理页主界面（暖纸时间线 + 智能视图 + 书摘卡片）
  2. 右侧滑出式 Markdown 导出抽屉预览
  3. 网页上按 `Alt+D` 呼出收藏弹窗的画面

---

## 第 3 步：打包纯净的扩展 `.zip`

在 `/Users/earlzhang/pycharm/addons/E-Deli` 目录下执行以下命令，只打包扩展运行所需文件（自动剔除 `.md`、`store-assets/`、`.git/`、`.DS_Store`），且确保 `manifest.json` 位于压缩包根目录：

```bash
cd /Users/earlzhang/pycharm/addons/E-Deli
mkdir -p dist
zip -r dist/e-deli-0.1.0.zip \
  manifest.json background.js content.js store.js digest.js \
  theme.css popup.html popup.js manage.html manage.css manage.js \
  icons/ _locales/ -x "*.DS_Store"
```

---

## 第 4 步：注册并提交到 Microsoft Edge Add-ons

1. 登录 [Microsoft Partner Center - Edge](https://partner.microsoft.com/dashboard/microsoftedge/overview)（免费注册个人开发者账号）。
2. 点击 **Create new extension**，在 **Packages** 上传 `dist/e-deli-0.1.0.zip`。
3. 在 **Properties / Store listings** 填写信息：
   - **Category（分类）**：`Productivity`（效率工具）
   - **Privacy Policy URL**：填第 1 步得到的 GitHub `PRIVACY.md` 链接
   - **Website / Support URL**：填你的 GitHub 仓库首页链接
   - **Store Logo**：上传 `store-assets/logo-300.png`
   - **Screenshots**：上传第 2 步截取的界面图

### 可直接复制的商店文案参考

- **简短描述（Short description）**：
  > 致敬 del.icio.us 的极简本地书签收藏与暖纸知识库工具：一键加标签与书摘备注，支持按日/周/筛选结果导出 Markdown 汇总。

- **详细描述（Long description）**：
  > E-Deli 是一款纯本地运行、致敬经典 del.icio.us 的轻量化书签收藏与知识整理扩展。
  >
  > 核心功能：
  > - 多种快捷收藏入口：工具栏弹窗、快捷键 Alt+D、页面/链接右键菜单；划词文本自动填入书摘备注，微信公众号文章自动附带公众号名称。
  > - 标签体系与快捷标签：支持空格/逗号快速打标签、历史标签自动补全与自定义快捷标签点选。
  > - 暖纸知识库管理页：提供智能视图（今日/本周/公众号/含书摘/未打标签）、多标签 OR/AND 组合筛选、标签重命名/合并/删除、Shift+Click 多选批量操作与 5 秒撤销删除。
  > - Markdown 汇总导出：支持按今日、昨日、本周、上周、自定义区间或当前筛选结果一键生成并复制/下载 Markdown 摘要。
  > - 纯本地隐私安全：所有数据仅存于本地浏览器，支持 JSON 一键备份与恢复。

### 审核备注参考（Notes for certification — 必填，加速过审）

可直接复制以下英文说明填入 Edge 后台的审核备注框：

> E-Deli is a purely offline/local-first bookmarking extension with zero network requests and zero analytics.
>
> Permission usage:
> - `storage`: Stores bookmarks, tags, and user preferences locally in `chrome.storage.local`.
> - `activeTab`: Reads the active tab's title and URL only when the user clicks the extension icon, presses the shortcut (Alt+D), or uses the context menu.
> - `contextMenus`: Provides "Save page to E-Deli" and "Save link to E-Deli" right-click actions.
> - `downloads`: Saves user-exported Markdown digests (.md) and JSON backups.
> - `clipboardWrite`: Copies user-generated Markdown digests to the clipboard on button click.
> - `content_scripts` (`http://*/*`, `https://*/*`): Only responds to user-triggered save actions to retrieve currently selected text (as bookmark note), the text of the right-clicked `<a>` element, or the author name (`#js_name`) on WeChat Official Account pages. No background tracking or passive data collection occurs.

---

## 第 5 步：提交审核
检查无误后点击 **Publish**，通常 **2～7 个工作日**完成审核并上线 Edge 外接程序商店。
