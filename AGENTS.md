# E-Deli — del.icio.us 风格 Edge 收藏扩展

MV3 扩展：一键收藏链接（标题 + URL + 标签 + 备注），本机 `storage.local` 存储，
整页管理界面支持标签筛选/搜索/编辑，按天/按周/自定义区间导出 Markdown 汇总。

## 加载与重载

- 加载：edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选本目录
- **改代码后必须「重新加载」扩展**（扩展卡片上的刷新图标）
  - `popup.html/js`、`manage.html/js`、`digest.js` 改动：reload 后重开对应页面即可
  - `background.js`、`content.js`、`manifest.json` 改动：必须 reload，content.js 变更后还需刷新已打开的网页
- 快捷键默认 Alt+D，可在 edge://extensions/shortcuts 修改

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单：storage/contextMenus/downloads/activeTab/clipboardWrite/alarms + optional_host_permissions + options_page + commands |
| `store.js` | 存储层：`links` 对象按 URL 去重；`tombstones` 删除墓碑（90 天 GC）；`upsert`/`update`/`removeMany`/`restoreMany`/标签批量与全局治理 |
| `sync/provider-webdav.js` | WebDAV 同步客户端：支持坚果云预设与自定义 WebDAV、`MKCOL` 建目录、`GET`/`PUT`、`If-Match` 乐观锁与限流/认证错误翻译 |
| `sync/engine.js` | 同步引擎：条目级 LWW + 墓碑表双向合并、防并发冲突重试、强制拉取/推送、配置与状态持久化 |
| `digest.js` | 纯函数 Markdown 渲染：`render(entries, {kind:'daily'|'weekly'|'range'|'selection', ...})` |
| `theme.css` | 暖纸知识库风设计系统（浅色/深色主题变量与基础控件样式） |
| `background.js` | SW：右键菜单（page+selection/link）、快捷键、openPopup→windows.create 兜底、badge、WebDAV 变更防抖推送 + 定时/启动自动同步调度 |
| `content.js` | 记录最近右键的 `<a>` 取链接文字做标题；响应 `edeli:selection` 回传页面选中文本 + 公众号名 |
| `popup.html/js` | 收藏表单；读 `pendingSave`（右键/快捷键写入，含 note）或活动标签页；标签自动补全（支持键盘选词） |
| `manage.html/css/js` | 管理页：智能视图、标签索引与重命名/合并/删除、OR/AND 筛选、时间线分组、书摘卡片/紧凑密度、批量操作与 5 秒撤销、右侧滑出式导出抽屉、JSON 备份导入 |
| `settings.js` | 扩展设置抽屉与顶栏同步状态栏：WebDAV 配置/域名按需授权/连接测试、同步模式与周期、应急覆盖、常规外观设置（支持 `manage.html#settings` 直达） |
| `icons/` | icon.svg 源文件 + 16/32/48/128 PNG（Pillow 生成） |

## 数据模型

```js
chrome.storage.local['links'] = {
  "<url>": { url, title, note, tags: [], savedAt, updatedAt }
}
```

- `savedAt` 首次收藏时间，重复收藏不改动（摘要口径稳定）；`updatedAt` 每次保存刷新
- 标签按空格/中英文逗号切分，去重按小写比较但保留首次写法
- `chrome.storage.local['quickTags']` 为快捷标签数组，缺省 `A股/基金/指数/美股/大模型`
  首次读取自动写入；popup 渲染为点选 chips，管理页侧栏维护（仅影响快捷列表，不动已存数据）

## 导出口径

- daily：`# E-Deli 收藏 · YYYY-MM-DD 周x` + 平铺列表，文件名 `e-deli-YYYY-MM-DD.md`
- weekly：ISO 周（周一~周日）按天分组，文件名 `e-deli-YYYY-Www.md`
- range：`e-deli-起_止.md`
- 条目格式：`- [标题](url) `tag1` `tag2``，备注为缩进 `> ` 引用行；标题中 `[` `]` `\` 转义
- 可叠加「包含当前筛选」（标签/搜索/日期）与「仅公众号链接」（hostname == mp.weixin.qq.com）
- 已生成后勾选「包含当前筛选」时，筛选变化自动按原区间重算（`state.exportMode` 记忆区间）

## 界面与交互规范

- **时间筛选快捷区间一致**：管理页（`manage.html` / `manage.js`）中不同位置的时间筛选功能（如顶部日期筛选浮层 `#datePopover` 与右侧导出抽屉 `#exportRangePills` 等），其时间区间快捷选项的文案、范围定义及计算口径必须保持一致；新增或修改任一处的快捷区间时，需同步检查并更新其余位置。

## 测试

- 运行核心逻辑单元测试（Node 18+ 原生 `node:test`，无外部依赖）：
  ```bash
  node --test tests/run.test.mjs
  ```

## 版本与变更日志（SemVer）

- 版本号以 [manifest.json](manifest.json) 与 [CHANGELOG.md](CHANGELOG.md) 为准：
  - 新增功能升 **MINOR**（如 `0.1.0` → `0.2.0`）
  - Bug 修复 / 安全加固 / 性能优化升 **PATCH**（如 `0.2.0` → `0.2.1`）
  - 破坏性或不兼容变更升 **MAJOR**
- 每次发版或确认功能/修复归档时，同步更新 `manifest.json`、`CHANGELOG.md` 与 `EDGE_PUBLISH_GUIDE.md` 中的打包文件名。

## 已知取舍

- `chrome.action.openPopup()` 需 Chromium 127+ 且须用户手势上下文；失败自动落 `windows.create` 小窗
- 右键存链接的标题取 content.js 记录的链接文字；受限页面（edge:// 等）拿不到则退化为 URL
- 页面选中文本自动填入备注（页面入口支持；上限 1000 字）；已有条目若已有备注则以空行追加选中文本（已包含相同内容时不重复追加）
- 公众号链接（mp.weixin.qq.com）标题自动追加「 ｜ 公众号名」，名取 `#js_name` 首个文本节点；
  链接右键入口不追加（拿不到目标页元数据）；标题已含名称不重复追加
- 默认 `storage.local` 本机存储，支持可选 WebDAV 云同步（条目级 LWW + 90 天墓碑表 + `localRev` 乐观并发防护）；JSON 备份/导入承担迁移与容灾
- 重复收藏为覆盖式更新（含标签），非合并
