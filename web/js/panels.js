// Slide-over drawer panels: Apps, APK Installer, File Manager, Mock GPS, Clipboard, System & Logs

const GPS_PRESETS = [
  { name: '美国 · 洛杉矶', lon: -118.2437, lat: 34.0522 },
  { name: '美国 · 纽约', lon: -74.006, lat: 40.7128 },
  { name: '日本 · 东京', lon: 139.6917, lat: 35.6895 },
  { name: '新加坡', lon: 103.8198, lat: 1.3521 },
  { name: '英国 · 伦敦', lon: -0.1276, lat: 51.5072 },
  { name: '中国 · 香港', lon: 114.1694, lat: 22.3193 },
];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export class DrawerController {
  constructor({ drawerEl, titleEl, bodyEl, closeBtn, api, sendJson, toast, getState }) {
    this.drawerEl = drawerEl;
    this.titleEl = titleEl;
    this.bodyEl = bodyEl;
    this.api = api;
    this.sendJson = sendJson;
    this.toast = toast;
    this.getState = getState;

    this.activeTab = null;
    this.currentDir = '/sdcard/Download';

    closeBtn.addEventListener('click', () => this.close());
  }

  toggle(tab) {
    if (this.activeTab === tab && !this.drawerEl.classList.contains('hidden')) {
      this.close();
      return;
    }
    this.open(tab);
  }

  open(tab) {
    this.activeTab = tab;
    this.drawerEl.classList.remove('hidden');
    document.querySelectorAll('.nav-tool-btn[data-drawer]').forEach((b) => {
      b.classList.toggle('active', b.dataset.drawer === tab);
    });
    this.render();
  }

  close() {
    this.activeTab = null;
    this.drawerEl.classList.add('hidden');
    document.querySelectorAll('.nav-tool-btn[data-drawer]').forEach((b) => b.classList.remove('active'));
  }

  refreshIfOpen(tab) {
    if (this.activeTab === tab && !this.drawerEl.classList.contains('hidden')) {
      this.render();
    }
  }

  async render() {
    const titles = {
      apps: '应用管理 & Google 生态',
      apk: '安装 APK 安装包',
      files: '手机文件传输',
      location: '虚拟 GPS 定位',
      clipboard: '双向剪贴板',
      system: '系统状态 & 日志',
    };
    this.titleEl.textContent = titles[this.activeTab] || '工具';

    switch (this.activeTab) {
      case 'apps':
        return this._renderApps();
      case 'apk':
        return this._renderApk();
      case 'files':
        return this._renderFiles();
      case 'location':
        return this._renderLocation();
      case 'clipboard':
        return this._renderClipboard();
      case 'system':
        return this._renderSystem();
      default:
        return;
    }
  }

  async _renderApps() {
    this.bodyEl.innerHTML = '<div class="muted">正在读取已安装应用…</div>';
    try {
      const data = await this.api('/api/apps');
      const featuredHtml = (data.featured || [])
        .map(
          (a) => `
          <button class="app-tile" data-launch="${escapeHtml(a.packageName)}">
            <span class="app-icon-pill">${escapeHtml(a.label[0] || 'A')}</span>
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(a.label)}</div>
              <div class="list-item-sub">${escapeHtml(a.packageName)}</div>
            </div>
          </button>`
        )
        .join('');

      const userHtml =
        (data.userApps || []).length === 0
          ? '<div class="muted small">暂未安装第三方应用，可通过 Google Play 商店或顶部「装包」安装。</div>'
          : data.userApps
              .map(
                (a) => `
              <div class="list-item">
                <div class="list-item-main">
                  <div class="list-item-title">${escapeHtml(a.label)}</div>
                  <div class="list-item-sub">${escapeHtml(a.packageName)}</div>
                </div>
                <div class="btn-group">
                  <button class="btn btn-subtle btn-sm" data-launch="${escapeHtml(a.packageName)}">打开</button>
                  <button class="btn btn-danger btn-sm" data-uninstall="${escapeHtml(a.packageName)}">卸载</button>
                </div>
              </div>`
              )
              .join('');

      this.bodyEl.innerHTML = `
        <div>
          <div class="section-label">Google 生态与常用系统应用</div>
          <div class="apps-grid">${featuredHtml || '<div class="muted small">暂无</div>'}</div>
        </div>
        <div>
          <div class="section-label">已安装第三方应用 (${(data.userApps || []).length})</div>
          <div class="list-stack">${userHtml}</div>
        </div>
      `;

      this.bodyEl.querySelectorAll('[data-launch]').forEach((el) => {
        el.addEventListener('click', async () => {
          const pkg = el.dataset.launch;
          try {
            await this.api('/api/apps/launch', { method: 'POST', body: { packageName: pkg } });
            this.toast(`已启动 ${pkg}`, 'success');
          } catch (err) {
            this.toast(err.message, 'error');
          }
        });
      });

      this.bodyEl.querySelectorAll('[data-uninstall]').forEach((el) => {
        el.addEventListener('click', async () => {
          const pkg = el.dataset.uninstall;
          if (!confirm(`确定要卸载 ${pkg} 吗？`)) return;
          try {
            await this.api('/api/apps/uninstall', { method: 'POST', body: { packageName: pkg } });
            this.toast(`已卸载 ${pkg}`, 'success');
            this._renderApps();
          } catch (err) {
            this.toast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      this.bodyEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  }

  _renderApk() {
    this.bodyEl.innerHTML = `
      <div class="upload-zone" id="apk-drop-zone">
        <p style="font-weight:600;margin-bottom:4px">点击选择或拖拽 .apk 文件</p>
        <p class="muted small">支持覆盖安装，最大 512 MB</p>
        <input type="file" id="apk-file-input" accept=".apk" class="hidden" />
      </div>
      <div id="apk-status" class="muted small">提示：你也可以直接把 .apk 文件拖到浏览器窗口任意位置快速安装。</div>
    `;
    const zone = this.bodyEl.querySelector('#apk-drop-zone');
    const input = this.bodyEl.querySelector('#apk-file-input');
    const statusEl = this.bodyEl.querySelector('#apk-status');

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files?.[0]) {
        this.installApkFile(input.files[0], statusEl);
        input.value = '';
      }
    });
  }

  async installApkFile(file, statusEl = null) {
    if (!file.name.toLowerCase().endsWith('.apk')) {
      this.toast('请选择 .apk 格式的安装包', 'error');
      return;
    }
    const setMsg = (m) => {
      if (statusEl) statusEl.textContent = m;
    };
    setMsg(`正在上传并安装 ${file.name} (${formatBytes(file.size)})…`);
    this.toast(`正在上传并安装 ${file.name}…`);

    try {
      const resp = await fetch('/api/apk/install', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '安装失败');
      setMsg(`安装成功：${file.name}`);
      this.toast(`${file.name} 安装成功`, 'success');
    } catch (err) {
      setMsg(`安装失败：${err.message}`);
      this.toast(`安装失败：${err.message}`, 'error');
    }
  }

  async _renderFiles() {
    this.bodyEl.innerHTML = '<div class="muted">正在加载文件列表…</div>';
    try {
      const data = await this.api(`/api/files?path=${encodeURIComponent(this.currentDir)}`);
      this.currentDir = data.path;
      const parentDir =
        this.currentDir === '/sdcard'
          ? null
          : this.currentDir.split('/').slice(0, -1).join('/') || '/sdcard';

      const rows = (data.entries || [])
        .map((f) => {
          const actions = f.isDir
            ? `<button class="btn btn-subtle btn-sm" data-open-dir="${escapeHtml(f.path)}">打开</button>`
            : `<a class="btn btn-subtle btn-sm" href="/api/files/download?path=${encodeURIComponent(f.path)}" download>下载</a>`;
          return `
            <div class="list-item">
              <div class="list-item-main">
                <div class="list-item-title">${f.isDir ? '📁' : '📄'} ${escapeHtml(f.name)}</div>
                <div class="list-item-sub">${f.isDir ? '文件夹' : formatBytes(f.size)} · ${escapeHtml(f.mtime)}</div>
              </div>
              <div class="btn-group">
                ${actions}
                <button class="btn btn-danger btn-sm" data-del-file="${escapeHtml(f.path)}">删</button>
              </div>
            </div>`;
        })
        .join('');

      this.bodyEl.innerHTML = `
        <div class="btn-group" style="justify-content:space-between">
          <div class="muted small" style="font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis">${escapeHtml(this.currentDir)}</div>
          <div class="btn-group">
            ${parentDir ? `<button class="btn btn-ghost btn-sm" id="file-up-btn">上级</button>` : ''}
            <button class="btn btn-primary btn-sm" id="file-upload-btn">上传文件</button>
            <input type="file" id="file-upload-input" class="hidden" />
          </div>
        </div>
        <div class="list-stack">${rows || '<div class="muted small">当前目录为空</div>'}</div>
      `;

      this.bodyEl.querySelector('#file-up-btn')?.addEventListener('click', () => {
        this.currentDir = parentDir;
        this._renderFiles();
      });

      const upBtn = this.bodyEl.querySelector('#file-upload-btn');
      const upInput = this.bodyEl.querySelector('#file-upload-input');
      upBtn.addEventListener('click', () => upInput.click());
      upInput.addEventListener('change', async () => {
        const f = upInput.files?.[0];
        if (!f) return;
        await this.uploadFileToPhone(f, this.currentDir);
        this._renderFiles();
      });

      this.bodyEl.querySelectorAll('[data-open-dir]').forEach((el) => {
        el.addEventListener('click', () => {
          this.currentDir = el.dataset.openDir;
          this._renderFiles();
        });
      });

      this.bodyEl.querySelectorAll('[data-del-file]').forEach((el) => {
        el.addEventListener('click', async () => {
          const p = el.dataset.delFile;
          if (!confirm(`确定删除 ${p} 吗？`)) return;
          try {
            await this.api(`/api/files?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
            this.toast('已删除', 'success');
            this._renderFiles();
          } catch (err) {
            this.toast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      this.bodyEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  }

  async uploadFileToPhone(file, targetDir = '/sdcard/Download') {
    this.toast(`正在上传 ${file.name} 到手机…`);
    try {
      const resp = await fetch(`/api/files/upload?path=${encodeURIComponent(targetDir)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '上传失败');
      this.toast(`已保存到 ${data.remotePath}`, 'success');
    } catch (err) {
      this.toast(`上传失败：${err.message}`, 'error');
    }
  }

  _renderLocation() {
    const presetButtons = GPS_PRESETS.map(
      (p) =>
        `<button class="app-tile" data-lon="${p.lon}" data-lat="${p.lat}">
          <div class="list-item-main">
            <div class="list-item-title">${escapeHtml(p.name)}</div>
            <div class="list-item-sub">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
          </div>
        </button>`
    ).join('');

    this.bodyEl.innerHTML = `
      <div>
        <div class="section-label">常用地区一键定位</div>
        <div class="apps-grid">${presetButtons}</div>
      </div>
      <div>
        <div class="section-label">自定义经纬度</div>
        <div class="list-stack">
          <input type="number" step="any" id="gps-lat" placeholder="纬度 Latitude (如 34.0522)" />
          <input type="number" step="any" id="gps-lon" placeholder="经度 Longitude (如 -118.2437)" />
          <button id="gps-apply-btn" class="btn btn-primary btn-sm">应用模拟定位</button>
        </div>
      </div>
    `;

    const applyGps = async (lon, lat, label = '') => {
      try {
        await this.api('/api/device/location', { method: 'POST', body: { lon, lat } });
        this.toast(`GPS 已更新${label ? `：${label}` : ''}`, 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };

    this.bodyEl.querySelectorAll('[data-lon]').forEach((el) => {
      el.addEventListener('click', () => {
        applyGps(Number(el.dataset.lon), Number(el.dataset.lat), el.querySelector('.list-item-title').textContent);
      });
    });

    this.bodyEl.querySelector('#gps-apply-btn').addEventListener('click', () => {
      const lat = Number(this.bodyEl.querySelector('#gps-lat').value);
      const lon = Number(this.bodyEl.querySelector('#gps-lon').value);
      applyGps(lon, lat);
    });
  }

  _renderClipboard() {
    const st = this.getState();
    this.bodyEl.innerHTML = `
      <div>
        <div class="section-label">手机最新剪贴板</div>
        <textarea id="clip-from-phone" rows="4" readonly placeholder="在手机上复制内容后会自动同步到这里…">${escapeHtml(st.lastClipboard || '')}</textarea>
        <div class="btn-group" style="margin-top:8px">
          <button id="clip-copy-local" class="btn btn-subtle btn-sm">复制到本机</button>
        </div>
      </div>
      <div>
        <div class="section-label">推送到手机剪贴板</div>
        <textarea id="clip-to-phone" rows="4" placeholder="输入文本或验证码…"></textarea>
        <div class="btn-group" style="margin-top:8px">
          <button id="clip-send-only" class="btn btn-subtle btn-sm">写入剪贴板</button>
          <button id="clip-send-paste" class="btn btn-primary btn-sm">写入并直接粘贴</button>
        </div>
      </div>
    `;

    this.bodyEl.querySelector('#clip-copy-local').addEventListener('click', async () => {
      const val = this.bodyEl.querySelector('#clip-from-phone').value;
      if (!val) return;
      try {
        await navigator.clipboard.writeText(val);
        this.toast('已复制到本机剪贴板', 'success');
      } catch {
        this.toast('浏览器拒绝读取剪贴板，请手动选中复制', 'error');
      }
    });

    const pushClip = (paste) => {
      const val = this.bodyEl.querySelector('#clip-to-phone').value;
      if (!val) return;
      this.sendJson({ type: 'clipboard_set', text: val, paste });
      this.toast(paste ? '已发送到手机并粘贴' : '已写入手机剪贴板', 'success');
    };

    this.bodyEl.querySelector('#clip-send-only').addEventListener('click', () => pushClip(false));
    this.bodyEl.querySelector('#clip-send-paste').addEventListener('click', () => pushClip(true));
  }

  async _renderSystem() {
    const st = this.getState();
    const m = st.metrics || {};
    const info = st.deviceInfo || {};

    this.bodyEl.innerHTML = `
      <div class="metrics-grid">
        <div class="metric-box"><div class="metric-label">CPU 占用</div><div class="metric-val">${m.cpuPercent ?? '--'}%</div></div>
        <div class="metric-box"><div class="metric-label">内存使用</div><div class="metric-val">${m.memUsedMb ? `${(m.memUsedMb / 1024).toFixed(1)}G` : '--'}</div></div>
        <div class="metric-box"><div class="metric-label">视频码率</div><div class="metric-val">${m.streamBitrateKbps ? `${(m.streamBitrateKbps / 1000).toFixed(1)} Mbps` : '--'}</div></div>
        <div class="metric-box"><div class="metric-label">解码引擎</div><div class="metric-val">${escapeHtml(st.decoderEngine || '--')}</div></div>
      </div>

      <div>
        <div class="section-label">设备信息</div>
        <div class="kv-list">
          <div class="kv-row"><span>设备型号</span><span>${escapeHtml(info.model || st.videoMeta?.deviceName || 'Pixel Cloud')}</span></div>
          <div class="kv-row"><span>Android 版本</span><span>Android ${escapeHtml(info.androidRelease || st.androidVersion || '16')}</span></div>
          <div class="kv-row"><span>视频流分辨率</span><span>${st.videoMeta?.width || 0} × ${st.videoMeta?.height || 0}</span></div>
          <div class="kv-row"><span>磁盘占用</span><span>${m.diskUsedGb ?? '--'} / ${m.diskTotalGb ?? '--'} GB</span></div>
        </div>
      </div>

      <div class="btn-group">
        <button id="sys-reconnect-btn" class="btn btn-subtle btn-sm" style="flex:1">重连视频流</button>
        <button id="sys-reboot-btn" class="btn btn-danger btn-sm" style="flex:1">重启 Android</button>
      </div>

      <div class="terminal-box">
        <div class="terminal-header"><span>运行日志</span></div>
        <pre class="terminal-body" style="height:200px">${escapeHtml((st.logs || []).slice(-60).join('\n'))}</pre>
      </div>
    `;

    this.bodyEl.querySelector('#sys-reconnect-btn').addEventListener('click', async () => {
      try {
        await this.api('/api/device/reconnect-stream', { method: 'POST' });
        this.toast('正在重新建立视频流…');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });

    this.bodyEl.querySelector('#sys-reboot-btn').addEventListener('click', async () => {
      if (!confirm('确定要重启 Android 系统吗？')) return;
      try {
        await this.api('/api/device/reboot', { method: 'POST' });
        this.toast('已发送重启指令');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  }
}
