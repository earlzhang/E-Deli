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
| `manifest.json` | MV3 清单：storage/contextMenus/downloads/activeTab/clipboardWrite + commands |
| `store.js` | 存储层：`links` 对象按 URL 去重；`upsert`/`update`/`removeMany`/`restoreMany`/标签批量与全局治理 |
| `digest.js` | 纯函数 Markdown 渲染：`render(entries, {kind:'daily'|'weekly'|'range'|'selection', ...})` |
| `theme.css` | 暖纸知识库风设计系统（浅色/深色主题变量与基础控件样式） |
| `background.js` | SW：右键菜单（page+selection/link）、快捷键、openPopup→windows.create 兜底、badge |
| `content.js` | 记录最近右键的 `<a>` 取链接文字做标题；响应 `edeli:selection` 回传页面选中文本 + 公众号名 |
| `popup.html/js` | 收藏表单；读 `pendingSave`（右键/快捷键写入，含 note）或活动标签页；标签自动补全（支持键盘选词） |
| `manage.html/css/js` | 管理页：智能视图、标签索引与重命名/合并/删除、OR/AND 筛选、时间线分组、书摘卡片/紧凑密度、批量操作与 5 秒撤销、右侧滑出式导出抽屉、JSON 备份导入 |
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
- 已生成后勾选「包含当前筛选」时，筛选变化自动按原区间重算（state.exportKey 记忆区间）

## 已知取舍

- `chrome.action.openPopup()` 需 Chromium 127+ 且须用户手势上下文；失败自动落 `windows.create` 小窗
- 右键存链接的标题取 content.js 记录的链接文字；受限页面（edge:// 等）拿不到则退化为 URL
- 页面选中文本自动填入备注（三个入口均支持；上限 1000 字）；已有条目仅当其备注为空时才用选中文本回填
- 公众号链接（mp.weixin.qq.com）标题自动追加「 ｜ 公众号名」，名取 `#js_name` 首个文本节点；
  链接右键入口不追加（拿不到目标页元数据）；标题已含名称不重复追加
- `storage.local` 仅本机，不跨设备；JSON 备份/导入承担迁移与容灾
- 重复收藏为覆盖式更新（含标签），非合并
