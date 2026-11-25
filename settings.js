// settings.js — E-Deli 扩展设置抽屉与 WebDAV 同步状态交互
(() => {
  const M = window.EDeliManage;
  const { $, pad, state, applyTheme, renderList, reload, showToast, closeDrawer } = M;
  const JIANGUOYUN_URL = 'https://dav.jianguoyun.com/dav/';
  let activeTab = 'sync';
  let currentPreset = 'jianguoyun';

  function fmtSyncTime(ts) {
    if (!ts) return '从未同步';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (sameDay) return `今天 ${hm}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  }

  function readFormConfig() {
    return {
      enabled: $('sEnabled').checked,
      provider: 'webdav',
      preset: currentPreset,
      url: $('sUrl').value.trim(),
      remoteDir: $('sRemoteDir').value.trim() || 'E-Deli',
      username: $('sUsername').value.trim(),
      password: $('sPassword').value,
      mode: $('sMode').value,
      pullIntervalMin: Number($('sPullInterval').value),
      pushDebounceSec: Number($('sPushDebounce').value),
    };
  }

  function applyPresetUI(preset, fillDefaultUrl = false) {
    currentPreset = preset === 'custom' ? 'custom' : 'jianguoyun';
    document.querySelectorAll('#sPresetSwitch [data-preset]').forEach(b => {
      b.classList.toggle('on', b.dataset.preset === currentPreset);
    });
    $('sJianguoyunHint').hidden = currentPreset !== 'jianguoyun';
    if (fillDefaultUrl && currentPreset === 'jianguoyun') {
      $('sUrl').value = JIANGUOYUN_URL;
    }
  }

  function updateAutoFieldsVisibility() {
    $('sAutoScheduleFields').style.display = $('sMode').value === 'auto' ? '' : 'none';
  }

  function syncGeneralToggles() {
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    document.querySelectorAll('#sThemeToggle button').forEach(b => {
      b.classList.toggle('on', b.dataset.val === theme);
    });
    document.querySelectorAll('#sDensityToggle button').forEach(b => {
      b.classList.toggle('on', b.dataset.val === state.density);
    });
    const prefixInput = $('sExportPrefix');
    if (prefixInput) {
      prefixInput.value = state.exportPrefix || '';
    }
  }

  function resetPasswordMask() {
    $('sPassword').type = 'password';
    $('sPwdToggle').textContent = '显示';
  }

  async function fillSettingsForm() {
    const cfg = await SyncEngine.getConfig();
    $('sEnabled').checked = Boolean(cfg.enabled);
    applyPresetUI(cfg.preset || (cfg.url && cfg.url.includes('jianguoyun.com') ? 'jianguoyun' : 'custom'), false);
    $('sUrl').value = cfg.url || JIANGUOYUN_URL;
    $('sRemoteDir').value = cfg.remoteDir || 'E-Deli';
    $('sUsername').value = cfg.username || '';
    $('sPassword').value = cfg.password || '';
    resetPasswordMask();
    $('sMode').value = cfg.mode || 'auto';
    $('sPullInterval').value = String(cfg.pullIntervalMin ?? 30);
    $('sPushDebounce').value = String(cfg.pushDebounceSec ?? 30);
    $('sTestMsg').textContent = '';
    $('sTestMsg').className = 'sync-test-msg';
    updateAutoFieldsVisibility();
    syncGeneralToggles();
  }

  // 渲染顶栏同步状态按钮与抽屉内状态卡片
  async function renderSyncStatus() {
    const [cfg, st] = await Promise.all([SyncEngine.getConfig(), SyncEngine.getState()]);
    const pill = $('syncStatusBtn');
    const dot = $('syncDot');
    const text = $('syncBtnText');
    const cardDot = $('syncCardDot');
    const cardState = $('syncCardState');
    const cardMeta = $('syncCardMeta');
    const cardErr = $('syncCardErr');
    const nowBtn = $('syncNowBtn');

    pill.classList.remove('syncing');
    dot.className = 'sync-dot';
    cardDot.className = 'sync-dot';
    cardErr.hidden = true;
    nowBtn.disabled = false;

    if (!cfg.enabled) {
      text.textContent = '云同步';
      pill.title = '未启用 WebDAV 云同步，点击打开设置';
      cardState.textContent = '尚未启用云同步';
      cardMeta.textContent = '开启并配置 WebDAV 后，可在多台电脑间自动合并书签与快捷标签';
      return;
    }

    if (st.status === 'syncing') {
      if (SyncEngine.isStaleSyncing(st)) {
        dot.classList.add('error');
        cardDot.classList.add('error');
        text.textContent = '同步中断';
        pill.title = '上次同步超时或被中断，点击重试';
        cardState.textContent = '上次同步已中断';
        cardMeta.textContent = '点击右侧「立即同步」重新同步';
        return;
      }
      pill.classList.add('syncing');
      dot.classList.add('syncing');
      cardDot.classList.add('syncing');
      text.textContent = '同步中';
      pill.title = '正在与 WebDAV 同步...';
      cardState.textContent = '正在同步...';
      cardMeta.textContent = '正在拉取并合并远端数据';
      nowBtn.disabled = true;
      return;
    }

    if (st.status === 'error') {
      dot.classList.add('error');
      cardDot.classList.add('error');
      text.textContent = '同步失败';
      pill.title = `同步失败：${st.lastError || '未知错误'}（点击重试）`;
      cardState.textContent = '同步失败';
      cardMeta.textContent = `上次尝试：${fmtSyncTime(st.lastSyncAt)}`;
      cardErr.hidden = false;
      cardErr.textContent = st.lastError || '未知错误';
      return;
    }

    if (st.dirty) {
      dot.classList.add('dirty');
      cardDot.classList.add('dirty');
      text.textContent = '待同步';
      pill.title = `本地有未推送变更（上次同步：${fmtSyncTime(st.lastSuccessAt)}），点击立即同步`;
      cardState.textContent = '有待推送变更';
      cardMeta.textContent = `上次成功：${fmtSyncTime(st.lastSuccessAt)}${st.lastSummary ? ' · ' + st.lastSummary : ''}`;
      return;
    }

    if (st.lastSuccessAt) {
      dot.classList.add('ok');
      cardDot.classList.add('ok');
      text.textContent = '已同步';
      pill.title = `上次同步：${fmtSyncTime(st.lastSuccessAt)}（${st.lastSummary || '已是最新'}），点击立即同步`;
      cardState.textContent = '已同步';
      cardMeta.textContent = `上次同步：${fmtSyncTime(st.lastSuccessAt)}${st.lastSummary ? ' · ' + st.lastSummary : ''}`;
    } else {
      text.textContent = '未同步';
      pill.title = '已启用 WebDAV，点击立即同步';
      cardState.textContent = '已启用，等待首次同步';
      cardMeta.textContent = '点击右侧「立即同步」开始与远端合并';
    }
  }

  function switchSettingsTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#settingsTabs .settings-tab').forEach(b => {
      b.classList.toggle('on', b.dataset.stab === tab);
    });
    $('stab-sync').hidden = tab !== 'sync';
    $('stab-general').hidden = tab !== 'general';
    $('settingsFoot').style.display = tab === 'sync' ? '' : 'none';
    if (tab === 'general') syncGeneralToggles();
  }

  async function openSettingsDrawer(tab = 'sync') {
    $('exportDrawer').classList.remove('open');
    await fillSettingsForm();
    await renderSyncStatus();
    switchSettingsTab(tab);
    $('drawerBackdrop').classList.add('open');
    $('settingsDrawer').classList.add('open');
  }

  function closeSettingsDrawer() {
    resetPasswordMask();
    closeDrawer();
  }

  // 须在用户点击事件中同步触发，不能先 await contains() 或 confirm()，否则可能丢失用户手势导致授权失败
  function requestOriginPermission(cfg) {
    const { originPattern } = WebDAVProvider.buildUrls(cfg);
    if (!chrome.permissions || !chrome.permissions.request) return Promise.resolve(true);
    return chrome.permissions.request({ origins: [originPattern] });
  }

  async function triggerSync(direction = 'merge', reason = 'manual') {
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'edeli:sync-now',
        direction,
        reason,
      });
    } catch (e) {
      // 若 Service Worker 消息通道异常，自动在当前扩展页直接执行同步（共享 Web Locks 互斥）
      res = await SyncEngine.syncNow({ direction, reason });
    }
    await renderSyncStatus();
    if (res && res.ok) {
      const curRev = await Store.getLocalRev();
      if (curRev !== state.lastRenderedRev) await reload();
      if (reason === 'manual') showToast(`同步完成：${res.summary || '已是最新'}`);
    } else if (reason === 'manual') {
      showToast((res && res.error) || '同步失败，请检查同步设置');
    }
    return res;
  }

  function setSyncButtonsDisabled(disabled) {
    $('syncNowBtn').disabled = disabled;
    $('sForcePullBtn').disabled = disabled;
    $('sForcePushBtn').disabled = disabled;
  }

  // ===== 事件绑定 =====
  $('openSettingsBtn').addEventListener('click', () => openSettingsDrawer('sync'));
  $('closeSettingsBtn').addEventListener('click', closeSettingsDrawer);
  $('sCancelBtn').addEventListener('click', closeSettingsDrawer);

  document.querySelectorAll('#settingsTabs .settings-tab').forEach(btn => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.stab));
  });

  document.querySelectorAll('#sPresetSwitch [data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPresetUI(btn.dataset.preset, true));
  });

  $('sMode').addEventListener('change', updateAutoFieldsVisibility);

  $('sPwdToggle').addEventListener('click', () => {
    const inp = $('sPassword');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('sPwdToggle').textContent = show ? '隐藏' : '显示';
  });

  // 顶栏同步状态按钮：未启用则打开设置；缺少权限引导设置；已启用且空闲则立即同步
  $('syncStatusBtn').addEventListener('click', async () => {
    const [cfg, st] = await Promise.all([SyncEngine.getConfig(), SyncEngine.getState()]);
    if (!cfg.enabled || !cfg.url || !cfg.username || !cfg.password) {
      openSettingsDrawer('sync');
      return;
    }
    if (st.status === 'syncing' && !SyncEngine.isStaleSyncing(st)) return;
    if (chrome.permissions && chrome.permissions.contains) {
      try {
        const { originPattern } = WebDAVProvider.buildUrls(cfg);
        const hasPerm = await chrome.permissions.contains({ origins: [originPattern] });
        if (!hasPerm) {
          showToast('请先在同步设置中点击「测试连接并授权」授予域名权限');
          openSettingsDrawer('sync');
          return;
        }
      } catch (e) {
        openSettingsDrawer('sync');
        return;
      }
    }
    await triggerSync('merge', 'manual');
  });

  $('syncNowBtn').addEventListener('click', async () => {
    const cfg = readFormConfig();
    if (!cfg.url || !cfg.username || !cfg.password) {
      showToast('请先填写完整的 WebDAV 服务器地址、账户与密码');
      return;
    }
    try {
      const granted = await requestOriginPermission(cfg);
      if (!granted) {
        showToast('需要授予该 WebDAV 域名的访问权限才能同步');
        return;
      }
      if (WebDAVProvider.isInsecureHttp(cfg.url) &&
          !confirm('当前使用的是公网明文 http:// 地址，账号密码将以非加密方式传输，建议改用 https://。确定仍要继续吗？')) {
        return;
      }
      setSyncButtonsDisabled(true);
      await SyncEngine.saveConfig(Object.assign({}, cfg, { enabled: true }));
      $('sEnabled').checked = true;
      await triggerSync('merge', 'manual');
    } catch (e) {
      showToast((e && e.message) || '同步失败');
    } finally {
      setSyncButtonsDisabled(false);
      await renderSyncStatus();
    }
  });

  $('sTestBtn').addEventListener('click', async () => {
    const msgEl = $('sTestMsg');
    const cfg = readFormConfig();
    if (!cfg.url || !cfg.username || !cfg.password) {
      msgEl.className = 'sync-test-msg err';
      msgEl.textContent = '请先填写服务器地址、账户名与密码';
      return;
    }
    try {
      const granted = await requestOriginPermission(cfg);
      if (!granted) {
        msgEl.className = 'sync-test-msg err';
        msgEl.textContent = '未获得该域名访问授权';
        return;
      }
    } catch (e) {
      msgEl.className = 'sync-test-msg err';
      msgEl.textContent = (e && e.message) || '服务器地址或目录格式有误';
      return;
    }

    $('sTestBtn').disabled = true;
    msgEl.className = 'sync-test-msg';
    msgEl.textContent = '正在连接测试...';
    try {
      const res = await WebDAVProvider.testConnection(cfg);
      if (res && res.ok) {
        const httpWarn = WebDAVProvider.isInsecureHttp(cfg.url) ? '（警告：公网 HTTP 传输不加密，建议改用 HTTPS）' : '';
        msgEl.className = 'sync-test-msg ok';
        msgEl.textContent = (res.remoteExists
          ? `连接成功！远端已有 ${res.remoteCount} 条书签`
          : '连接成功！目录已就绪（远端暂无数据）') + httpWarn;
      } else {
        msgEl.className = 'sync-test-msg err';
        msgEl.textContent = (res && res.error) || '连接失败';
      }
    } catch (e) {
      msgEl.className = 'sync-test-msg err';
      msgEl.textContent = (e && e.message) || '连接测试失败，请检查配置与网络';
    } finally {
      $('sTestBtn').disabled = false;
    }
  });

  $('sSaveBtn').addEventListener('click', async () => {
    const cfg = readFormConfig();
    if (cfg.enabled) {
      if (!cfg.url || !cfg.username || !cfg.password) {
        showToast('启用同步前，请填写完整的服务器地址、账户与密码');
        return;
      }
      try {
        const granted = await requestOriginPermission(cfg);
        if (!granted) {
          showToast('未授予域名访问权限，请允许授权后再保存');
          return;
        }
      } catch (e) {
        showToast((e && e.message) || '服务器地址或目录无效');
        return;
      }
      if (WebDAVProvider.isInsecureHttp(cfg.url) &&
          !confirm('当前使用的是公网明文 http:// 地址，账号密码将以非加密方式传输，建议改用 https://。确定仍要保存吗？')) {
        return;
      }
    }
    await SyncEngine.saveConfig(cfg);
    try {
      await chrome.runtime.sendMessage({ type: 'edeli:sync-reschedule' });
    } catch (e) { /* background 会通过 storage.onChanged 自动重算定时器 */ }
    await renderSyncStatus();
    closeSettingsDrawer();
    showToast(cfg.enabled ? '同步设置已保存' : '已关闭云同步');
  });

  // 强制拉取/推送：先校验字段并在同步用户手势中申请域名权限，再弹 confirm 二次确认，避免 confirm 消耗手势
  async function handleForceSync(direction, confirmText) {
    const cfg = readFormConfig();
    if (!cfg.url || !cfg.username || !cfg.password) {
      showToast('请先填写完整的 WebDAV 服务器地址、账户与密码');
      return;
    }
    try {
      const granted = await requestOriginPermission(cfg);
      if (!granted) { showToast('未授予域名访问权限'); return; }
    } catch (e) {
      showToast((e && e.message) || '服务器地址或目录无效');
      return;
    }
    if (!confirm(confirmText)) return;

    setSyncButtonsDisabled(true);
    try {
      await SyncEngine.saveConfig(Object.assign({}, cfg, { enabled: true }));
      $('sEnabled').checked = true;
      await triggerSync(direction, 'manual');
    } catch (e) {
      showToast((e && e.message) || '覆盖失败');
    } finally {
      setSyncButtonsDisabled(false);
      await renderSyncStatus();
    }
  }

  $('sForcePullBtn').addEventListener('click', () => {
    handleForceSync(
      'force-pull',
      '确定要用远端 WebDAV 数据完全覆盖当前电脑的本地数据吗？本地未上传的修改将丢失。'
    );
  });

  $('sForcePushBtn').addEventListener('click', () => {
    handleForceSync(
      'force-push',
      '确定要用当前电脑的本地数据完全覆盖远端 WebDAV 上的 data.json 吗？'
    );
  });

  // 常规设置 Tab 事件
  document.querySelectorAll('#sThemeToggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.val);
      syncGeneralToggles();
    });
  });

  document.querySelectorAll('#sDensityToggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.density = btn.dataset.val;
      localStorage.setItem('edeli_density', state.density);
      renderList();
      syncGeneralToggles();
    });
  });

  $('sExportPrefix').addEventListener('input', e => {
    const val = e.target.value.replace(/[\r\n]+/g, ' ').trim();
    state.exportPrefix = val;
    if (val) localStorage.setItem('edeli_export_prefix', val);
    else localStorage.removeItem('edeli_export_prefix');
  });

  $('sExportPrefix').addEventListener('change', e => {
    e.target.value = state.exportPrefix || '';
  });

  $('sExportPrefixReset').addEventListener('click', () => {
    state.exportPrefix = '';
    localStorage.removeItem('edeli_export_prefix');
    $('sExportPrefix').value = '';
    showToast('已恢复默认导出前缀');
  });

  $('sExportJsonBtn').addEventListener('click', () => $('exportJson').click());
  $('sImportJsonBtn').addEventListener('click', () => $('importJsonBtn').click());

  // 监听外部（popup / 其他标签页 / 后台同步）引起的数据与状态变化；通过 localRev 去重避免双倍 reload
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.syncState || changes.syncConfig || changes.syncDirty) {
      renderSyncStatus();
    }
    if (changes.links || changes.quickTags) {
      const nextRev = changes.localRev ? changes.localRev.newValue : undefined;
      if (nextRev !== undefined && nextRev === state.lastRenderedRev) return;
      reload();
    }
  });

  window.EDeliSettings = {
    openSettingsDrawer,
    closeSettingsDrawer,
    resetPasswordMask,
    syncGeneralToggles,
    renderSyncStatus,
  };

  // 初始化：渲染同步状态；若 URL 带 #settings 则打开设置抽屉；若已开启自动同步且距上次超过 5 分钟则静默拉取
  (async function initSyncUI() {
    await renderSyncStatus();
    if (location.hash === '#settings') {
      openSettingsDrawer('sync');
    }
    const [cfg, st] = await Promise.all([SyncEngine.getConfig(), SyncEngine.getState()]);
    const fiveMin = 5 * 60 * 1000;
    if (cfg.enabled && cfg.mode === 'auto' && (!st.lastSuccessAt || Date.now() - st.lastSuccessAt > fiveMin)) {
      triggerSync('merge', 'manage-open');
    }
  })();
})();
