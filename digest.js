// digest.js — Markdown 汇总渲染（纯函数，无 chrome API 依赖）
// render(entries, opts) -> { markdown, filename, count }，内部按时间口径自行过滤
//   opts: { kind:'daily', day } | { kind:'weekly', day } | { kind:'range', start, end }
const Digest = (() => {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const pad = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shortDate = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const weekday = d => WEEKDAYS[d.getDay()];

  // ISO 周数（周一至周日）
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
    return 1 + Math.round((t - firstThu) / 604800000);
  }

  // 所在周周一 00:00（本地时区）
  function weekStart(d) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return t;
  }

  const escapeTitle = s => String(s || '').replace(/([\\\[\]])/g, '\\$1');

  function line(e) {
    const tags = e.tags && e.tags.length ? ' ' + e.tags.map(t => `\`${t}\``).join(' ') : '';
    let s = `- [${escapeTitle(e.title)}](${e.url})${tags}`;
    if (e.note) s += `\n  > ${e.note.replace(/\n/g, '\n  > ')}`;
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

  function renderRange(entries, title) {
    const groups = groupByDay(entries);
    const out = [`# ${title}`, ''];
    const days = [...groups.keys()].sort().reverse();
    if (!days.length) out.push('（本期无收藏）');
    for (const key of days) {
      const d = new Date(key + 'T00:00:00');
      out.push(`## ${shortDate(d)} ${weekday(d)}`, '');
      for (const e of groups.get(key)) out.push(line(e));
      out.push('');
    }
    return out.join('\n').trim() + '\n';
  }

  // 'YYYY-MM-DD' 按本地时区解析（new Date(str) 默认按 UTC，负时区会偏一天）
  const toDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(v + 'T00:00:00') : new Date(v);
  const dayStart = d => { const t = toDate(d); t.setHours(0, 0, 0, 0); return t.getTime(); };
  const inSpan = (items, s, e) => items.filter(i => i.savedAt >= s && i.savedAt <= e);

  function render(entries, opts) {
    const all = entries || [];
    if (opts.kind === 'daily') {
      const d = new Date(opts.day);
      const items = inSpan(all, dayStart(d), dayStart(d) + 86400000 - 1);
      const out = [`# E-Deli 收藏 · ${dateStr(d)} ${weekday(d)}`, ''];
      if (!items.length) out.push('（本期无收藏）');
      for (const e of [...items].sort((a, b) => a.savedAt - b.savedAt)) out.push(line(e));
      out.push('');
      return { markdown: out.join('\n'), filename: `e-deli-${dateStr(d)}.md`, count: items.length };
    }
    if (opts.kind === 'weekly') {
      const s = weekStart(new Date(opts.day)).getTime();
      const e = s + 7 * 86400000 - 1;
      const items = inSpan(all, s, e);
      const start = new Date(s), end = new Date(e);
      const wk = isoWeek(start);
      return {
        markdown: renderRange(items,
          `E-Deli 收藏 · ${start.getFullYear()} 年第 ${wk} 周（${shortDate(start)} ~ ${shortDate(end)}）`),
        filename: `e-deli-${start.getFullYear()}-W${pad(wk)}.md`,
        count: items.length,
      };
    }
    if (opts.kind === 'selection') {
      const label = opts.title || 'E-Deli 精选收藏';
      const items = [...all];
      const suffix = dateStr(new Date());
      return {
        markdown: renderRange(items, label),
        filename: `e-deli-selection-${suffix}.md`,
        count: items.length,
      };
    }
    // range：start/end 含边界当日，内部按整天归一化
    const s = dayStart(opts.start), e = dayStart(opts.end) + 86400000 - 1;
    const items = inSpan(all, s, e);
    return {
      markdown: renderRange(items, `E-Deli 收藏 · ${dateStr(new Date(s))} ~ ${dateStr(new Date(e))}`),
      filename: `e-deli-${dateStr(new Date(s))}_${dateStr(new Date(e))}.md`,
      count: items.length,
    };
  }

  return { render, isoWeek, weekStart, dateStr, weekday };
})();
