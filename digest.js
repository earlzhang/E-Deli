// digest.js — Markdown 汇总渲染（纯函数，无 chrome API 依赖）
// render(entries, opts) -> { markdown, filename, count }，内部按时间口径自行过滤
//   opts: { kind:'24h', now?, titlePrefix?, flat? } | { kind:'daily', day, titlePrefix?, flat? } | { kind:'weekly', day, titlePrefix?, flat? } | { kind:'range', start, end, titlePrefix?, flat? } | { kind:'selection', title?, flat? }
const Digest = (() => {
  const DEFAULT_TITLE_PREFIX = 'E-Deli 收藏';
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const pad = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shortDate = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const weekday = d => WEEKDAYS[d.getDay()];

  // 'YYYY-MM-DD' 按本地时区解析（new Date(str) 默认按 UTC，负时区会偏一天）
  const toDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(v + 'T00:00:00') : new Date(v);

  // 本地日历算术，避免夏令时（23h/25h）导致 86400000 偏移 1 小时
  function dayStart(d) {
    const t = toDate(d);
    return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  }
  function dayEnd(d) {
    const t = toDate(d);
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() - 1;
  }

  // ISO 周年与周数（周一至周日，年份归属以该周周四为准）
  function isoWeekInfo(d) {
    const src = toDate(d);
    const t = new Date(Date.UTC(src.getFullYear(), src.getMonth(), src.getDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const isoYear = t.getUTCFullYear();
    const firstThu = new Date(Date.UTC(isoYear, 0, 4));
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
    const week = 1 + Math.round((t - firstThu) / 604800000);
    return { year: isoYear, week };
  }

  function isoWeek(d) {
    return isoWeekInfo(d).week;
  }

  // 所在周周一 00:00（本地时区）
  function weekStart(d) {
    const src = toDate(d);
    const t = new Date(src.getFullYear(), src.getMonth(), src.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return t;
  }

  const escapeTitle = s => String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\\[\]])/g, '\\$1')
    .trim();

  // 编码会破坏 Markdown [title](url) 语法的空格与括号
  const formatUrl = u => String(u || '')
    .trim()
    .replace(/\s/g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');

  // 兼容标签内可能包含反引号的情况（CommonMark 规范）
  function formatTag(t) {
    const s = String(t || '');
    if (!s.includes('`')) return `\`${s}\``;
    let fence = '``';
    while (s.includes(fence)) fence += '`';
    return `${fence} ${s} ${fence}`;
  }

  function formatLine(e) {
    const tags = e.tags && e.tags.length ? ' ' + e.tags.map(formatTag).join(' ') : '';
    let s = `- [${escapeTitle(e.title)}](${formatUrl(e.url)})${tags}`;
    if (e.note) {
      const normalized = String(e.note).replace(/\r\n?/g, '\n');
      s += `\n  > ${normalized.replace(/\n/g, '\n  > ')}`;
    }
    return s;
  }

  // 按天分组：Map<'YYYY-MM-DD', entries[]>，组内按 savedAt 升序
  function groupByDay(entries) {
    const groups = new Map();
    for (const e of [...entries].sort((a, b) => a.savedAt - b.savedAt)) {
      const key = dateStr(new Date(e.savedAt));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    return groups;
  }

  function renderFlat(entries) {
    const items = [...entries].sort((a, b) => b.savedAt - a.savedAt);
    if (!items.length) return '（本期无收藏）\n';
    return items.map(formatLine).join('\n') + '\n';
  }

  function renderRange(entries, title) {
    const groups = groupByDay(entries);
    const out = title ? [`# ${title}`, ''] : [];
    const days = [...groups.keys()].sort().reverse();
    if (!days.length) out.push('（本期无收藏）');
    for (const key of days) {
      const d = new Date(key + 'T00:00:00');
      out.push(`## ${shortDate(d)} ${weekday(d)}`, '');
      for (const e of groups.get(key)) out.push(formatLine(e));
      out.push('');
    }
    return out.join('\n').trim() + '\n';
  }

  const inSpan = (items, s, e) => items.filter(i => i.savedAt >= s && i.savedAt <= e);

  function render(entries, opts) {
    const all = entries || [];
    const flat = Boolean(opts.flat);
    const rawPrefix = opts.titlePrefix === undefined
      ? DEFAULT_TITLE_PREFIX
      : String(opts.titlePrefix ?? '').replace(/[\r\n]+/g, ' ').trim();
    const prefixHead = rawPrefix ? `${rawPrefix} · ` : '';
    if (opts.kind === '24h') {
      const now = opts.now ? toDate(opts.now) : new Date();
      const endMs = now.getTime();
      const startMs = endMs - 24 * 60 * 60 * 1000;
      const items = inSpan(all, startMs, endMs);
      return {
        markdown: flat ? renderFlat(items) : renderRange(items, `${prefixHead}过去 24 小时`),
        filename: `e-deli-24h-${dateStr(now)}.md`,
        count: items.length,
      };
    }
    if (opts.kind === 'daily') {
      const d = toDate(opts.day);
      const items = inSpan(all, dayStart(d), dayEnd(d));
      if (flat) {
        return { markdown: renderFlat(items), filename: `e-deli-${dateStr(d)}.md`, count: items.length };
      }
      const out = [`# ${prefixHead}${dateStr(d)} ${weekday(d)}`, ''];
      if (!items.length) out.push('（本期无收藏）');
      for (const e of [...items].sort((a, b) => a.savedAt - b.savedAt)) out.push(formatLine(e));
      out.push('');
      return { markdown: out.join('\n'), filename: `e-deli-${dateStr(d)}.md`, count: items.length };
    }
    if (opts.kind === 'weekly') {
      const start = weekStart(toDate(opts.day));
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      const s = start.getTime();
      const e = dayEnd(end);
      const items = inSpan(all, s, e);
      const { year, week } = isoWeekInfo(start);
      return {
        markdown: flat
          ? renderFlat(items)
          : renderRange(items, `${prefixHead}${year} 年第 ${week} 周（${shortDate(start)} ~ ${shortDate(end)}）`),
        filename: `e-deli-${year}-W${pad(week)}.md`,
        count: items.length,
      };
    }
    if (opts.kind === 'selection') {
      const label = opts.title || '';
      const items = [...all];
      const suffix = dateStr(new Date());
      return {
        markdown: flat ? renderFlat(items) : renderRange(items, label),
        filename: `e-deli-selection-${suffix}.md`,
        count: items.length,
      };
    }
    // range：start/end 含边界当日，内部按整天归一化；若起止倒序自动交换
    let startD = toDate(opts.start);
    let endD = toDate(opts.end);
    if (dayStart(startD) > dayStart(endD)) [startD, endD] = [endD, startD];
    const s = dayStart(startD), e = dayEnd(endD);
    const items = inSpan(all, s, e);
    return {
      markdown: flat ? renderFlat(items) : renderRange(items, `${prefixHead}${dateStr(startD)} ~ ${dateStr(endD)}`),
      filename: `e-deli-${dateStr(startD)}_${dateStr(endD)}.md`,
      count: items.length,
    };
  }

  return { render, formatLine, isoWeek, isoWeekInfo, weekStart, dateStr, weekday, DEFAULT_TITLE_PREFIX };
})();
