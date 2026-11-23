// sync/provider-webdav.js — WebDAV 同步客户端（兼容坚果云与标准 WebDAV 服务）
const WebDAVProvider = (() => {
  const DATA_FILE = 'data.json';
  const PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

  function normalizeBaseUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) throw new Error('请填写 WebDAV 服务器地址');
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      throw new Error('服务器地址格式不正确，须以 https:// 或 http:// 开头');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('仅支持 http:// 或 https:// 协议');
    }
    let href = u.href;
    if (!href.endsWith('/')) href += '/';
    return href;
  }

  // 检测是否为公网明文 HTTP（排除本机与常见局域网地址）
  function isInsecureHttp(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); }
    catch (e) { return false; }
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local')) {
      return false;
    }
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) {
      return false;
    }
    return true;
  }

  function normalizeRemoteDir(raw) {
    const cleaned = String(raw ?? 'E-Deli')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    if (!cleaned) return [];
    const segments = cleaned.split('/').map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
      if (seg === '.' || seg === '..') {
        throw new Error('远端目录路径不能包含 . 或 ..');
      }
    }
    return segments;
  }

  function buildUrls(cfg) {
    const baseUrl = normalizeBaseUrl(cfg.url);
    const segments = normalizeRemoteDir(cfg.remoteDir);
    const encodedPath = segments.map(s => encodeURIComponent(s)).join('/');
    const dirUrl = encodedPath ? `${baseUrl}${encodedPath}/` : baseUrl;
    const fileUrl = `${dirUrl}${DATA_FILE}`;
    const u = new URL(baseUrl);
    const originPattern = `${u.origin}/*`;
    return { baseUrl, segments, dirUrl, fileUrl, originPattern };
  }

  function authHeader(username, password) {
    const raw = `${username || ''}:${password || ''}`;
    const bytes = new TextEncoder().encode(raw);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'Basic ' + btoa(bin);
  }

  function httpError(status, action) {
    const map = {
      401: '认证失败（401）：请检查账户名或应用密码（坚果云须使用第三方应用密码）',
      403: '无访问权限（403）：请检查账号权限或目录设置',
      404: '远端路径不存在（404）：请检查服务器地址是否正确',
      405: '服务器不支持当前 WebDAV 方法（405）',
      409: '远端父目录不存在（409）',
      412: '远端文件已被其他设备更新（412）',
      429: '请求过于频繁（429 限流），请稍后再试',
      500: 'WebDAV 服务器内部错误（500）',
      502: 'WebDAV 网关错误（502）',
      503: 'WebDAV 服务暂时不可用（503），请稍后再试',
    };
    const err = new Error(map[status] || `${action}失败（HTTP ${status}）`);
    err.status = status;
    if (status === 412) err.code = 'CONFLICT';
    if (status === 429 || status === 503) err.code = 'RATE_LIMIT';
    return err;
  }

  async function davFetch(url, cfg, options = {}) {
    const headers = Object.assign(
      { Authorization: authHeader(cfg.username, cfg.password) },
      options.headers || {}
    );
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 15000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const err = new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或代理设置`);
        err.code = 'TIMEOUT';
        throw err;
      }
      const err = new Error('网络请求失败：请检查网络连接、服务器地址或域名访问权限');
      err.cause = e;
      err.code = 'NETWORK';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 逐级确保远端目录存在（坚果云已存在目录返回 201，标准 WebDAV 返回 405）
  async function ensureDirectory(cfg) {
    const { baseUrl, segments } = buildUrls(cfg);
    let cur = baseUrl;
    for (const seg of segments) {
      cur += encodeURIComponent(seg) + '/';
      const resp = await davFetch(cur, cfg, { method: 'MKCOL' });
      if (resp.status === 201 || resp.status === 200 || resp.status === 204 || resp.status === 405 || resp.status === 301) {
        continue;
      }
      throw httpError(resp.status, '创建远端目录');
    }
  }

  async function pull(cfg) {
    const { fileUrl } = buildUrls(cfg);
    const resp = await davFetch(fileUrl, cfg, { method: 'GET' });
    if (resp.status === 404) {
      return { exists: false, data: null, etag: null };
    }
    if (!resp.ok) {
      throw httpError(resp.status, '拉取远端数据');
    }
    const text = await resp.text();
    let data = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('远端 data.json 解析失败：文件内容不是合法 JSON');
      }
    }
    return {
      exists: true,
      data,
      etag: resp.headers.get('etag') || null,
    };
  }

  async function push(cfg, payload, { etag = null } = {}) {
    const { fileUrl } = buildUrls(cfg);
    const body = JSON.stringify(payload, null, 2);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;

    let resp = await davFetch(fileUrl, cfg, { method: 'PUT', headers, body });
    // 若目录尚未创建，常见返回 404 或 409；补建目录后重试时须移除旧 If-Match
    if (resp.status === 404 || resp.status === 409) {
      await ensureDirectory(cfg);
      const retryHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
      resp = await davFetch(fileUrl, cfg, { method: 'PUT', headers: retryHeaders, body });
    }
    if (!resp.ok) {
      throw httpError(resp.status, '上传数据');
    }
    return {
      etag: resp.headers.get('etag') || null,
    };
  }

  async function testConnection(cfg) {
    const { baseUrl } = buildUrls(cfg);
    // 1. 验证根地址与凭据（带极简 RFC 4918 propfind body，兼顾兼容性与速度）
    const probe = await davFetch(baseUrl, cfg, {
      method: 'PROPFIND',
      headers: {
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    });
    if (probe.status !== 207 && !probe.ok) {
      throw httpError(probe.status, '连接验证');
    }
    // 2. 确保目标目录存在
    await ensureDirectory(cfg);
    // 3. 探查是否已有同步文件
    const remote = await pull(cfg);
    const remoteCount = remote.exists && remote.data && remote.data.links && typeof remote.data.links === 'object'
      ? Object.keys(remote.data.links).length
      : 0;
    return {
      ok: true,
      remoteExists: remote.exists,
      remoteCount,
      etag: remote.etag,
    };
  }

  return {
    DATA_FILE,
    normalizeBaseUrl,
    isInsecureHttp,
    normalizeRemoteDir,
    buildUrls,
    ensureDirectory,
    pull,
    push,
    testConnection,
  };
})();
