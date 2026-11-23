import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

import { AdbClient } from './adb.mjs';
import { ScrcpyManager, QUALITY_PRESETS } from './scrcpy.mjs';
import { detectIpGeo, resolvePhoneLocale } from './geo.mjs';

const execFileAsync = promisify(execFile);

const MAX_LOGS_PER_PHONE = 200;

export const ANDROID_VERSIONS = [
  { version: '16', api: 'android-36', label: 'Android 16 (最新)' },
  { version: '15', api: 'android-35', label: 'Android 15 (稳定)' },
  { version: '14', api: 'android-34', label: 'Android 14 (主流)' },
  { version: '13', api: 'android-33', label: 'Android 13 (经典)' },
  { version: '11', api: 'android-30', label: 'Android 11 (轻量兼容)' },
  { version: '10', api: 'android-29', label: 'Android 10 (怀旧轻量)' },
  { version: '9', api: 'android-28', label: 'Android 9 Pie (极简低占用)' },
];

export const REDROID_PRESETS = [
  { id: 'redroid-14', version: '14', image: 'redroid/redroid:14.0.0-latest', label: 'Redroid Android 14 (官方)' },
  { id: 'redroid-13', version: '13', image: 'redroid/redroid:13.0.0-latest', label: 'Redroid Android 13 (官方)' },
  { id: 'redroid-12', version: '12', image: 'redroid/redroid:12.0.0-latest', label: 'Redroid Android 12 (官方)' },
  { id: 'redroid-11', version: '11', image: 'redroid/redroid:11.0.0-latest', label: 'Redroid Android 11 (官方轻量)' },
  { id: 'redroid-9', version: '9', image: 'redroid/redroid:9.0.0-latest', label: 'Redroid Android 9 (极简)' },
  { id: 'redroid-11-gapps', version: '11', image: 'teddysun/redroid:11.0.0-gapps', label: 'Redroid Android 11 + GApps (社区)' },
  { id: 'redroid-12-gapps', version: '12', image: 'teddysun/redroid:12.0.0-gapps', label: 'Redroid Android 12 + GApps (社区)' },
  { id: 'redroid-13-gapps', version: '13', image: 'teddysun/redroid:13.0.0-gapps', label: 'Redroid Android 13 + GApps (社区)' },
  { id: 'custom-adb', version: '14', image: '', label: '自定义 Redroid / 外部 ADB 设备' },
];

const ADB_ADDRESS_RE = /^[a-zA-Z0-9._-]+:\d{1,5}$/;

export function normalizeAdbAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!ADB_ADDRESS_RE.test(s)) {
    throw Object.assign(new Error('无效的 ADB 地址，格式应为 host:port（例如 redroid:5555 或 127.0.0.1:5555）'), {
      statusCode: 400,
    });
  }
  const port = Number(s.split(':')[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('ADB 端口号必须在 1-65535 之间'), { statusCode: 400 });
  }
  return s;
}

export const DEVICE_PROFILES = [
  { id: 'pixel_8', label: 'Google Pixel 8', desc: '均衡旗舰 6.2"' },
  { id: 'pixel_9', label: 'Google Pixel 9', desc: '新款旗舰 6.3"' },
  { id: 'pixel_7', label: 'Google Pixel 7', desc: '经典稳定 6.3"' },
  { id: 'pixel_7_pro', label: 'Google Pixel 7 Pro', desc: '大屏旗舰 6.7"' },
  { id: 'pixel_6a', label: 'Google Pixel 6a', desc: '轻巧紧凑 6.1"' },
  { id: 'pixel_5', label: 'Google Pixel 5', desc: '轻量省资源 6.0"' },
  { id: 'pixel_tablet', label: 'Google Pixel Tablet', desc: '横屏平板' },
];

export const SCREEN_PRESETS = {
  smooth: { label: '流畅 (540×1200)', width: 540, height: 1200, density: 240 },
  balanced: { label: '均衡 (720×1600)', width: 720, height: 1600, density: 320 },
  hd: { label: '原画 (1080×2400)', width: 1080, height: 2400, density: 420 },
};

export const LOCALE_OPTIONS = [
  { id: 'zh-CN', label: '简体中文 (zh-CN · 默认)' },
  { id: 'auto_ip', label: '跟随出口 IP 当地语言 (推荐注册 Google)' },
  { id: 'en-US', label: 'English (en-US)' },
  { id: 'zh-TW', label: '繁體中文 (zh-TW)' },
  { id: 'ja-JP', label: '日本語 (ja-JP)' },
];

function apiForVersion(version) {
  const found = ANDROID_VERSIONS.find((v) => v.version === String(version));
  return found ? found.api : 'android-36';
}

function sanitizePhoneConfig(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '我的云手机').trim().slice(0, 40) || '我的云手机';
  const engineRaw = String(input.engine ?? existing?.engine ?? 'emulator').trim().toLowerCase();
  const engine = engineRaw === 'redroid' ? 'redroid' : 'emulator';

  const redroidPresetRaw = String(input.redroidPreset ?? existing?.redroidPreset ?? 'redroid-11-gapps').trim();
  const presetObj = REDROID_PRESETS.find((p) => p.id === redroidPresetRaw) || REDROID_PRESETS[0];
  const redroidPreset = engine === 'redroid' ? presetObj.id : '';
  const redroidImage =
    engine === 'redroid'
      ? String(input.redroidImage ?? existing?.redroidImage ?? presetObj.image ?? '').trim()
      : '';
  const adbAddress =
    engine === 'redroid'
      ? normalizeAdbAddress(input.adbAddress ?? existing?.adbAddress ?? '')
      : '';
  if (engine === 'redroid' && !adbAddress) {
    throw Object.assign(new Error('Redroid / 外部 ADB 模式必须填写 ADB 连接地址（例如 redroid:5555）'), {
      statusCode: 400,
    });
  }

  const versionFallback = engine === 'redroid' ? presetObj.version : process.env.ANDROID_VERSION ?? '16';
  const versionRaw = String(input.androidVersion ?? existing?.androidVersion ?? versionFallback);
  const androidVersion =
    engine === 'redroid'
      ? (versionRaw.replace(/[^0-9.]/g, '') || presetObj.version)
      : ANDROID_VERSIONS.some((v) => v.version === versionRaw)
        ? versionRaw
        : '16';
  const deviceRaw = String(input.device ?? existing?.device ?? process.env.DEVICE ?? 'pixel_8');
  const device = DEVICE_PROFILES.some((d) => d.id === deviceRaw) ? deviceRaw : 'pixel_7';
  const screenRaw = String(input.screenPreset ?? existing?.screenPreset ?? process.env.SCREEN_PRESET ?? 'balanced');
  const screenPreset = SCREEN_PRESETS[screenRaw] ? screenRaw : 'balanced';
  const streamRaw = String(input.streamPreset ?? existing?.streamPreset ?? process.env.STREAM_PRESET ?? 'balanced');
  const streamPreset = QUALITY_PRESETS[streamRaw] ? streamRaw : 'balanced';

  const ramMb = Math.max(2048, Math.min(8192, Number(input.ramMb ?? existing?.ramMb ?? process.env.RAM_MB ?? 3072) || 3072));
  const cores = Math.max(1, Math.min(8, Number(input.cores ?? existing?.cores ?? process.env.CORES ?? 3) || 3));
  const dataSizeRaw = String(input.dataSize ?? existing?.dataSize ?? process.env.DATA_SIZE ?? '16G').trim();
  const dataSize = /^\d+[GM]$/i.test(dataSizeRaw) ? dataSizeRaw.toUpperCase() : '16G';

  const localeMode = String(input.localeMode ?? existing?.localeMode ?? 'zh-CN');
  const customLocale = String(input.customLocale ?? existing?.customLocale ?? '').trim();
  const autoIpEnv = input.autoIpEnv !== undefined ? Boolean(input.autoIpEnv) : (existing?.autoIpEnv ?? true);
  const ecoMode = input.ecoMode !== undefined ? Boolean(input.ecoMode) : (existing?.ecoMode ?? true);
  const httpProxy = String(input.httpProxy ?? existing?.httpProxy ?? process.env.HTTP_PROXY_URL ?? '').trim();
  const rawDns = String(input.dnsServers ?? existing?.dnsServers ?? process.env.DNS_SERVERS ?? 'auto').trim();
  // Default 'auto' uses Docker's native DNS (127.0.0.11), which is required for SLIRP/netsimd inside containers
  const dnsServers = !rawDns || rawDns.toLowerCase() === 'auto' ? 'auto' : rawDns.split(',')[0].trim();
  const idleStopMinutes = Math.max(0, Math.min(1440, Number(input.idleStopMinutes ?? existing?.idleStopMinutes ?? 30) || 0));

  return {
    name,
    engine,
    adbAddress,
    redroidPreset,
    redroidImage,
    androidVersion,
    imgTag: engine === 'redroid' ? 'redroid' : 'google_apis_playstore',
    abi: 'x86_64',
    device,
    screenPreset,
    streamPreset,
    ramMb,
    cores,
    dataSize,
    localeMode,
    customLocale,
    autoIpEnv,
    ecoMode,
    httpProxy,
    dnsServers,
    idleStopMinutes,
  };
}

export class PhoneManager extends EventEmitter {
  constructor({
    sdkRoot = process.env.ANDROID_SDK_ROOT || '/opt/android-sdk',
    avdHome = process.env.ANDROID_AVD_HOME_PARENT || '/root/.android',
    cmdlineVer = process.env.CMDLINE_VER || '16111833',
    gpu = process.env.GPU || 'swiftshader_indirect',
    animationScale = process.env.ANIMATION_SCALE || '0.5',
    scrcpyServerPath = process.env.SCRCPY_SERVER_PATH || '/opt/scrcpy/scrcpy-server',
    geoDetector = detectIpGeo,
  } = {}) {
    super();
    this.sdkRoot = sdkRoot;
    this.avdHome = avdHome;
    this.avdDirRoot = path.join(avdHome, 'avd');
    this.storePath = path.join(avdHome, 'droidcloud-phones.json');
    this.cmdlineVer = cmdlineVer;
    this.gpu = gpu;
    this.animationScale = animationScale;
    this.scrcpyServerPath = scrcpyServerPath;
    this.geoDetector = geoDetector;

    this.phones = new Map(); // id -> phone config record
    this.runtimes = new Map(); // id -> live runtime state
    this._sdkLock = Promise.resolve();
    this._idleTimer = null;
    this._shuttingDown = false;

    this._loadStore();
    this._importExistingAvds();
    this._importRedroidTargets();
    this._ensureAtLeastOneDefault();
  }

  startBackgroundWatchers() {
    if (this._idleTimer) return;
    this._idleTimer = setInterval(() => this._checkIdleAndEco(), 15_000);
    this._idleTimer.unref?.();
  }

  stopBackgroundWatchers() {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _loadStore() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        const list = Array.isArray(raw) ? raw : Array.isArray(raw.phones) ? raw.phones : [];
        for (const p of list) {
          if (!p?.id || !p?.avdName) continue;
          const clean = {
            id: String(p.id),
            avdName: String(p.avdName),
            createdAt: p.createdAt || Date.now(),
            lastGeo: p.lastGeo || null,
            ...sanitizePhoneConfig(p),
          };
          this.phones.set(clean.id, clean);
          this._initRuntime(clean.id);
        }
      }
    } catch {
      // ignore corrupted store
    }
  }

  _saveStore() {
    try {
      fs.mkdirSync(this.avdHome, { recursive: true });
      const data = {
        version: 2,
        phones: Array.from(this.phones.values()),
      };
      const tmp = `${this.storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.storePath);
    } catch {
      // ignore in read-only test envs
    }
  }

  _importExistingAvds() {
    try {
      if (!fs.existsSync(this.avdDirRoot)) return;
      const existingAvdNames = new Set(Array.from(this.phones.values()).map((p) => p.avdName));
      const files = fs.readdirSync(this.avdDirRoot);
      let imported = false;
      for (const f of files) {
        if (!f.endsWith('.ini')) continue;
        const avdName = f.slice(0, -4);
        if (existingAvdNames.has(avdName)) continue;
        const avdDir = path.join(this.avdDirRoot, `${avdName}.avd`);
        if (!fs.existsSync(avdDir)) continue;

        const verMatch = avdName.match(/a(9|1[0-7])/);
        const androidVersion = verMatch ? verMatch[1] : process.env.ANDROID_VERSION || '16';
        const id = `phone-${crypto.createHash('md5').update(avdName).digest('hex').slice(0, 8)}`;
        const record = {
          id,
          avdName,
          createdAt: Date.now(),
          lastGeo: null,
          ...sanitizePhoneConfig({
            name: `已迁移云手机 (Android ${androidVersion})`,
            androidVersion,
            device: 'pixel_7',
            localeMode: 'zh-CN',
            autoIpEnv: true,
          }),
        };
        this.phones.set(id, record);
        this._initRuntime(id);
        imported = true;
      }
      if (imported) this._saveStore();
    } catch {
      // ignore
    }
  }

  _importRedroidTargets() {
    const raw = String(process.env.REDROID_TARGETS || '').trim();
    if (!raw) return;
    const existingAddrs = new Set(
      Array.from(this.phones.values())
        .filter((p) => p.engine === 'redroid')
        .map((p) => p.adbAddress)
    );
    let added = false;
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      const name = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim() : `Redroid (${trimmed})`;
      const addrRaw = eqIdx > 0 ? trimmed.slice(eqIdx + 1).trim() : trimmed;
      try {
        const adbAddress = normalizeAdbAddress(addrRaw);
        if (!adbAddress || existingAddrs.has(adbAddress)) continue;
        const id = `redroid-${crypto.createHash('md5').update(adbAddress).digest('hex').slice(0, 8)}`;
        const record = {
          id,
          avdName: id,
          createdAt: Date.now(),
          lastGeo: null,
          ...sanitizePhoneConfig({
            name,
            engine: 'redroid',
            adbAddress,
            redroidPreset: 'custom-adb',
            redroidImage: process.env.REDROID_IMAGE || '',
            androidVersion: '11',
          }),
        };
        this.phones.set(id, record);
        this._initRuntime(id);
        existingAddrs.add(adbAddress);
        added = true;
      } catch {
        // skip invalid entries
      }
    }
    if (added) this._saveStore();
  }

  _ensureAtLeastOneDefault() {
    if (this.phones.size > 0) return;
    const id = 'phone-main';
    const androidVersion = process.env.ANDROID_VERSION || '16';
    const record = {
      id,
      avdName: `phone-a${androidVersion}-google_apis_playstore`,
      createdAt: Date.now(),
      lastGeo: null,
      ...sanitizePhoneConfig({
        name: '主力云手机',
        androidVersion,
        device: process.env.DEVICE || 'pixel_8',
        screenPreset: process.env.SCREEN_PRESET || 'balanced',
        streamPreset: process.env.STREAM_PRESET || 'balanced',
        localeMode: 'zh-CN',
        autoIpEnv: true,
        idleStopMinutes: 30,
      }),
    };
    this.phones.set(id, record);
    this._initRuntime(id);
    this._saveStore();
  }

  _initRuntime(id) {
    if (!this.runtimes.has(id)) {
      this.runtimes.set(id, {
        status: 'stopped', // stopped | starting | running | stopping | error
        stage: 'stopped',
        progress: 0,
        message: '已关机，按需启动以节省 CPU 和内存',
        error: null,
        emuPort: null,
        scrcpyPort: null,
        proc: null,
        adb: null,
        scrcpy: null,
        viewers: new Set(),
        lastActiveAt: Date.now(),
        screenAsleep: false,
        resolvedTz: null,
        resolvedLocale: null,
        geo: this.phones.get(id)?.lastGeo || null,
        logs: [],
      });
    }
    return this.runtimes.get(id);
  }

  getCatalog() {
    const versions = ANDROID_VERSIONS.map((v) => {
      const imgDir = path.join(this.sdkRoot, 'system-images', v.api, 'google_apis_playstore', 'x86_64');
      return { ...v, downloaded: fs.existsSync(imgDir) };
    });
    return {
      androidVersions: versions,
      redroidPresets: REDROID_PRESETS,
      devices: DEVICE_PROFILES,
      screenPresets: SCREEN_PRESETS,
      qualityPresets: QUALITY_PRESETS,
      localeOptions: LOCALE_OPTIONS,
    };
  }

  getPhoneSummary(id) {
    const cfg = this.phones.get(id);
    if (!cfg) return null;
    const rt = this._initRuntime(id);
    return {
      ...cfg,
      status: rt.status,
      stage: rt.stage,
      progress: rt.progress,
      message: rt.message,
      error: rt.error,
      emuPort: rt.emuPort,
      streamConnected: Boolean(rt.scrcpy?.isConnected),
      videoMeta: rt.scrcpy?.meta || null,
      bitrateKbps: rt.scrcpy?.bitrateKbps || 0,
      viewerCount: rt.viewers.size,
      resolvedTz: rt.resolvedTz,
      resolvedLocale: rt.resolvedLocale,
      geo: rt.geo || cfg.lastGeo || null,
      idleSeconds:
        rt.status === 'running' && rt.viewers.size === 0
          ? Math.floor((Date.now() - rt.lastActiveAt) / 1000)
          : 0,
    };
  }

  listPhones() {
    return Array.from(this.phones.keys())
      .map((id) => this.getPhoneSummary(id))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getPhoneLogs(id) {
    const rt = this.runtimes.get(id);
    return rt ? rt.logs.slice(-150) : [];
  }

  getRuntime(id) {
    if (!this.phones.has(id)) return null;
    return this._initRuntime(id);
  }

  createPhone(input = {}) {
    const clean = sanitizePhoneConfig(input);
    const id = `${clean.engine === 'redroid' ? 'redroid' : 'phone'}-${crypto.randomBytes(4).toString('hex')}`;
    const avdName = clean.engine === 'redroid' ? id : `dc-${id}-a${clean.androidVersion}`;
    const record = {
      id,
      avdName,
      createdAt: Date.now(),
      lastGeo: null,
      ...clean,
    };
    this.phones.set(id, record);
    this._initRuntime(id);
    this._saveStore();
    this._emitPhonesChanged();
    return this.getPhoneSummary(id);
  }

  updatePhone(id, patch = {}) {
    const existing = this.phones.get(id);
    if (!existing) {
      throw Object.assign(new Error('找不到指定的云手机'), { statusCode: 404 });
    }
    const rt = this._initRuntime(id);
    const updatedCfg = sanitizePhoneConfig({ ...patch, engine: existing.engine || 'emulator' }, existing);
    // Do not change Android version of an already-created AVD in-place
    if (existing.engine !== 'redroid' && fs.existsSync(path.join(this.avdDirRoot, `${existing.avdName}.avd`))) {
      updatedCfg.androidVersion = existing.androidVersion;
    }
    const next = { ...existing, ...updatedCfg };
    this.phones.set(id, next);
    this._saveStore();

    if (rt.scrcpy && patch.streamPreset && QUALITY_PRESETS[patch.streamPreset]) {
      rt.scrcpy.setQualityPreset(patch.streamPreset).catch(() => {});
    }

    this._emitPhonesChanged();
    return this.getPhoneSummary(id);
  }

  async deletePhone(id) {
    const cfg = this.phones.get(id);
    if (!cfg) {
      throw Object.assign(new Error('找不到指定的云手机'), { statusCode: 404 });
    }
    await this.stopPhone(id);
    if (cfg.engine !== 'redroid') {
      // Remove AVD files to free disk space
      const avdIni = path.join(this.avdDirRoot, `${cfg.avdName}.ini`);
      const avdDir = path.join(this.avdDirRoot, `${cfg.avdName}.avd`);
      await fs.promises.rm(avdIni, { force: true }).catch(() => {});
      await fs.promises.rm(avdDir, { recursive: true, force: true }).catch(() => {});
    }

    this.phones.delete(id);
    this.runtimes.delete(id);
    this._saveStore();
    this._emitPhonesChanged();
  }

  attachViewer(id, wsClient) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.viewers.add(wsClient);
    rt.lastActiveAt = Date.now();
    if (rt.status === 'running') {
      this.ensureAwake(id).catch(() => {});
      this._ensureScrcpyStarted(id);
    }
    this._emitPhonesChanged();
  }

  detachViewer(id, wsClient) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.viewers.delete(wsClient);
    rt.lastActiveAt = Date.now();
    this._emitPhonesChanged();
  }

  async ensureAwake(id) {
    const rt = this.runtimes.get(id);
    if (!rt || rt.status !== 'running' || !rt.adb) return;
    rt.lastActiveAt = Date.now();
    if (rt.screenAsleep) {
      rt.screenAsleep = false;
      await rt.adb.wakeScreen();
      this._log(id, '[节能] 已唤醒屏幕');
    }
  }

  _ensureScrcpyStarted(id) {
    const cfg = this.phones.get(id);
    const rt = this.runtimes.get(id);
    if (!cfg || !rt || rt.status !== 'running' || !rt.adb) return null;
    if (rt.scrcpy) {
      if (!rt.scrcpy.isConnected) rt.scrcpy.start();
      return rt.scrcpy;
    }
    const scrcpy = new ScrcpyManager({
      adb: rt.adb,
      serverJarPath: this.scrcpyServerPath,
      localPort: rt.scrcpyPort,
      preset: cfg.streamPreset,
    });
    rt.scrcpy = scrcpy;

    scrcpy.on('meta', (meta) => this.emit('phone_video_meta', { id, meta }));
    scrcpy.on('frame', (payload) => this.emit('phone_video_frame', { id, ...payload }));
    scrcpy.on('clipboard', (text) => this.emit('phone_clipboard', { id, text }));
    scrcpy.on('log', (line) => this._log(id, line));
    scrcpy.on('connected', () => this._emitPhonesChanged());
    scrcpy.on('disconnected', () => this._emitPhonesChanged());

    scrcpy.start();
    return scrcpy;
  }

  _pauseScrcpy(id) {
    const rt = this.runtimes.get(id);
    if (!rt || !rt.scrcpy) return;
    rt.scrcpy.stop();
    rt.scrcpy = null;
    this._emitPhonesChanged();
  }

  _log(id, line) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const ts = new Date().toTimeString().slice(0, 8);
    const formatted = `[${ts}] ${String(line).replace(/\r/g, '').trimEnd()}`;
    if (!formatted.trim()) return;
    rt.logs.push(formatted);
    if (rt.logs.length > MAX_LOGS_PER_PHONE) {
      rt.logs.splice(0, rt.logs.length - MAX_LOGS_PER_PHONE);
    }
    this.emit('phone_log', { id, line: formatted });
  }

  _setProgress(id, patch) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    Object.assign(rt, patch);
    this.emit('phone_status', this.getPhoneSummary(id));
    this._emitPhonesChanged();
  }

  _emitPhonesChanged() {
    this.emit('phones_changed', this.listPhones());
  }

  _allocatePorts() {
    const usedEmu = new Set();
    const usedScrcpy = new Set();
    for (const rt of this.runtimes.values()) {
      if (rt.emuPort) usedEmu.add(rt.emuPort);
      if (rt.scrcpyPort) usedScrcpy.add(rt.scrcpyPort);
    }
    let emuPort = 5560;
    while (usedEmu.has(emuPort)) emuPort += 2;
    let scrcpyPort = 27183;
    while (usedScrcpy.has(scrcpyPort)) scrcpyPort += 1;
    return { emuPort, scrcpyPort };
  }

  async _withSdkLock(fn) {
    const prev = this._sdkLock;
    let release;
    this._sdkLock = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async _ensureSdkAndImage(id, cfg) {
    const api = apiForVersion(cfg.androidVersion);
    const pkg = `system-images;${api};${cfg.imgTag};${cfg.abi}`;
    const sdkm = path.join(this.sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    const emuBin = path.join(this.sdkRoot, 'emulator', 'emulator');
    const adbBin = path.join(this.sdkRoot, 'platform-tools', 'adb');
    const imgDir = path.join(this.sdkRoot, 'system-images', api, cfg.imgTag, cfg.abi);

    await this._withSdkLock(async () => {
      if (!fs.existsSync(sdkm)) {
        this._setProgress(id, {
          stage: 'downloading_sdk',
          progress: 12,
          message: '首次运行：正在下载 Android 命令行工具…',
        });
        this._log(id, `下载 Android Commandline Tools (${this.cmdlineVer})…`);
        fs.mkdirSync(path.join(this.sdkRoot, 'cmdline-tools'), { recursive: true });
        const zipPath = '/tmp/droidcloud-clt.zip';
        const tmpDir = '/tmp/droidcloud-clt';
        await execFileAsync('curl', [
          '-fSL',
          `https://dl.google.com/android/repository/commandlinetools-linux-${this.cmdlineVer}_latest.zip`,
          '-o',
          zipPath,
        ], { timeout: 300_000 });
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
        await execFileAsync('unzip', ['-q', zipPath, '-d', tmpDir], { timeout: 120_000 });
        await fs.promises.rename(path.join(tmpDir, 'cmdline-tools'), path.join(this.sdkRoot, 'cmdline-tools', 'latest'));
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
        await fs.promises.rm(zipPath, { force: true });
      }

      if (!fs.existsSync(imgDir) || !fs.existsSync(emuBin) || !fs.existsSync(adbBin)) {
        this._setProgress(id, {
          stage: 'downloading_image',
          progress: 26,
          message: `正在下载 Android ${cfg.androidVersion} (Google Play) 系统镜像，约 2-3 GB…`,
        });
        this._log(id, `接受 SDK 许可并安装 ${pkg}…`);

        await new Promise((resolve) => {
          const lic = spawn('bash', ['-c', `yes | "${sdkm}" --licenses >/dev/null 2>&1 || true`]);
          lic.on('close', () => resolve());
        });

        await new Promise((resolve, reject) => {
          const proc = spawn(sdkm, ['--install', 'platform-tools', 'emulator', pkg], {
            env: { ...process.env, ANDROID_SDK_ROOT: this.sdkRoot, ANDROID_HOME: this.sdkRoot },
          });
          let lastPct = 26;
          const handleOut = (chunk) => {
            const lines = chunk.toString('utf8').replace(/\r/g, '\n').split('\n');
            for (const l of lines) {
              const t = l.trim();
              if (!t) continue;
              const m = t.match(/(\d{1,3})%/);
              if (m) {
                const rawPct = Math.min(100, Number(m[1]));
                const mapped = Math.min(62, 26 + Math.round(rawPct * 0.36));
                if (mapped > lastPct) {
                  lastPct = mapped;
                  this._setProgress(id, {
                    stage: 'downloading_image',
                    progress: mapped,
                    message: `正在下载 Android ${cfg.androidVersion} 系统镜像 (${rawPct}%)…`,
                  });
                }
              } else {
                this._log(id, t);
              }
            }
          };
          proc.stdout.on('data', handleOut);
          proc.stderr.on('data', handleOut);
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`sdkmanager 退出码 ${code}`));
          });
          proc.on('error', reject);
        });
      } else {
        this._log(id, `已命中本地缓存的 Android ${cfg.androidVersion} 系统镜像`);
      }
    });
  }

  async _ensureAvd(id, cfg) {
    const api = apiForVersion(cfg.androidVersion);
    const pkg = `system-images;${api};${cfg.imgTag};${cfg.abi}`;
    const avdm = path.join(this.sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager');
    const avdDir = path.join(this.avdDirRoot, `${cfg.avdName}.avd`);

    if (!fs.existsSync(avdDir)) {
      this._setProgress(id, {
        stage: 'creating_avd',
        progress: 66,
        message: `正在创建虚拟设备 ${cfg.device}…`,
      });
      this._log(id, `创建 AVD: ${cfg.avdName} (device=${cfg.device})`);

      const createWithDevice = (devId) =>
        new Promise((resolve, reject) => {
          const proc = spawn(avdm, ['create', 'avd', '-n', cfg.avdName, '-k', pkg, '-d', devId, '--force'], {
            env: { ...process.env, ANDROID_SDK_ROOT: this.sdkRoot, ANDROID_HOME: this.sdkRoot, HOME: path.dirname(this.avdHome) },
          });
          proc.stdin.end('no\n');
          let out = '';
          proc.stdout.on('data', (d) => { out += d.toString(); });
          proc.stderr.on('data', (d) => { out += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(out.trim() || `avdmanager 退出码 ${code}`));
          });
        });

      try {
        await createWithDevice(cfg.device);
      } catch (err) {
        this._log(id, `机型 ${cfg.device} 不可用 (${err.message.split('\n')[0]})，自动回退到 pixel_7`);
        await createWithDevice('pixel_7');
      }
    }

    // Apply tuned hardware config & detect resolution changes
    const cfgFile = path.join(avdDir, 'config.ini');
    const screen = SCREEN_PRESETS[cfg.screenPreset] || SCREEN_PRESETS.balanced;
    if (fs.existsSync(cfgFile)) {
      let text = fs.readFileSync(cfgFile, 'utf8');
      const oldW = text.match(/^hw\.lcd\.width=(.+)$/m)?.[1]?.trim();
      const oldH = text.match(/^hw\.lcd\.height=(.+)$/m)?.[1]?.trim();
      if (oldW && (oldW !== String(screen.width) || oldH !== String(screen.height))) {
        this._log(id, `分辨率变更 (${oldW}x${oldH} -> ${screen.width}x${screen.height})，清理旧快照以冷启动生效`);
        await fs.promises.rm(path.join(avdDir, 'snapshots', 'default_boot'), { recursive: true, force: true }).catch(() => {});
      }

      const dropKeys = [
        'hw.keyboard',
        'hw.ramSize',
        'hw.cpu.ncore',
        'disk.dataPartition.size',
        'hw.lcd.width',
        'hw.lcd.height',
        'hw.lcd.density',
        'hw.gps',
        'hw.sensors.orientation',
        'hw.battery',
        'fastboot.forceFastBoot',
        'PlayStore.enabled',
        'hw.camera.back',
        'hw.camera.front',
        'hw.audioInput',
        'hw.audioOutput',
        'hw.sensors.proximity',
        'hw.sensors.magnetic_field',
        'hw.sensors.temperature',
        'hw.sensors.light',
        'hw.sensors.pressure',
        'hw.sensors.humidity',
        'vm.heapSize',
      ];
      const filtered = text
        .split('\n')
        .filter((line) => !dropKeys.some((k) => line.startsWith(`${k}=`)))
        .join('\n')
        .trimEnd();

      const additions = [
        'hw.keyboard=yes',
        `hw.ramSize=${cfg.ramMb}`,
        `hw.cpu.ncore=${cfg.cores}`,
        `disk.dataPartition.size=${cfg.dataSize}`,
        `hw.lcd.width=${screen.width}`,
        `hw.lcd.height=${screen.height}`,
        `hw.lcd.density=${screen.density}`,
        'hw.gps=yes',
        'hw.sensors.orientation=yes',
        'hw.battery=yes',
        'hw.camera.back=none',
        'hw.camera.front=none',
        'hw.audioInput=no',
        'hw.audioOutput=no',
        'hw.sensors.proximity=no',
        'hw.sensors.magnetic_field=no',
        'hw.sensors.temperature=no',
        'hw.sensors.light=no',
        'hw.sensors.pressure=no',
        'hw.sensors.humidity=no',
        'vm.heapSize=256',
        'fastboot.forceFastBoot=yes',
        'PlayStore.enabled=true',
      ].join('\n');

      fs.writeFileSync(cfgFile, `${filtered}\n${additions}\n`);
    }

    // Remove stale lock files
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (f.endsWith('.lock')) {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        }
      }
    } catch {
      // ignore
    }
  }

  async startPhone(id) {
    const cfg = this.phones.get(id);
    if (!cfg) throw Object.assign(new Error('找不到指定的云手机'), { statusCode: 404 });
    const rt = this._initRuntime(id);
    if (rt.status === 'running' || rt.status === 'starting') {
      return this.getPhoneSummary(id);
    }

    rt.logs = [];
    rt.error = null;
    rt.lastActiveAt = Date.now();
    this._setProgress(id, {
      status: 'starting',
      stage: 'init',
      progress: 5,
      message: '正在检查虚拟化与硬件环境…',
    });

    // Run boot pipeline asynchronously so HTTP call returns immediately
    this._bootPipeline(id, cfg, rt).catch((err) => {
      this._log(id, `启动失败: ${err.message}`);
      this._cleanupRuntime(id);
      this._setProgress(id, {
        status: 'error',
        stage: 'error',
        progress: 0,
        message: `启动失败：${err.message}`,
        error: err.message,
      });
    });

    return this.getPhoneSummary(id);
  }

  _resolveAdbBin() {
    const sdkAdb = path.join(this.sdkRoot, 'platform-tools', 'adb');
    if (fs.existsSync(sdkAdb)) return sdkAdb;
    return 'adb';
  }

  async _bootRedroid(id, cfg, rt) {
    if (!cfg.adbAddress) {
      throw new Error('未配置 Redroid / 外部 ADB 地址');
    }
    const adbBin = this._resolveAdbBin();
    const { scrcpyPort } = this._allocatePorts();
    rt.scrcpyPort = scrcpyPort;

    this._setProgress(id, {
      stage: 'booting',
      progress: 35,
      message: `正在连接 Redroid ADB (${cfg.adbAddress})…`,
    });
    this._log(id, `连接 Redroid / 外部 ADB: ${cfg.adbAddress} (bin=${adbBin})`);

    await execFileAsync(adbBin, ['start-server'], { timeout: 10_000 }).catch(() => {});
    const { stdout: connOut, stderr: connErr } = await execFileAsync(adbBin, ['connect', cfg.adbAddress], {
      timeout: 15_000,
    });
    const connMsg = `${connOut || ''} ${connErr || ''}`.trim();
    this._log(id, `adb connect: ${connMsg}`);

    const adb = new AdbClient({ adbBin, serial: cfg.adbAddress });
    rt.adb = adb;

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (rt.status !== 'starting') return;
      if (await adb.isDeviceReady()) break;
      await execFileAsync(adbBin, ['connect', cfg.adbAddress], { timeout: 6_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!(await adb.isDeviceReady())) {
      throw new Error(`无法连接到 Redroid / ADB 设备 ${cfg.adbAddress}，请确认目标容器已启动并监听 5555 端口`);
    }

    // Auto-detect Android version and exit geo
    const rel = (await adb.shell('getprop ro.build.version.release').catch(() => '')).trim();
    if (rel && rel !== cfg.androidVersion) {
      cfg.androidVersion = rel;
      this._saveStore();
    }
    if (cfg.autoIpEnv) {
      const geo = await this.geoDetector({ httpProxy: cfg.httpProxy }).catch(() => null);
      if (geo) {
        rt.geo = geo;
        cfg.lastGeo = geo;
        this._saveStore();
      }
    }

    await adb.shell('settings put global stay_on_while_plugged_in 7').catch(() => {});
    await adb.shell('wm dismiss-keyguard').catch(() => {});

    rt.lastActiveAt = Date.now();
    rt.screenAsleep = false;
    this._setProgress(id, {
      status: 'running',
      stage: 'ready',
      progress: 100,
      message: `Redroid 已连接 (${cfg.adbAddress})`,
      error: null,
    });
    if (rt.viewers.size > 0) {
      this._ensureScrcpyStarted(id);
    }
    this._log(id, `Redroid 云手机已就绪 (Android ${cfg.androidVersion})`);
  }

  async _bootPipeline(id, cfg, rt) {
    if (cfg.engine === 'redroid') {
      return this._bootRedroid(id, cfg, rt);
    }
    if (!fs.existsSync('/dev/kvm')) {
      throw new Error('宿主机未挂载 /dev/kvm，无法启动官方 KVM 模拟器（可改用 Redroid 容器模式）');
    }

    await this._ensureSdkAndImage(id, cfg);
    if (rt.status !== 'starting') return;

    await this._ensureAvd(id, cfg);
    if (rt.status !== 'starting') return;

    // Auto-detect exit IP geo (routed through per-phone proxy if configured!)
    let geo = null;
    if (cfg.autoIpEnv || cfg.localeMode === 'auto_ip') {
      this._setProgress(id, {
        stage: 'detecting_ip',
        progress: 72,
        message: '正在检测出口 IP 归属地、时区与坐标…',
      });
      geo = await this.geoDetector({ httpProxy: cfg.httpProxy });
      if (geo) {
        rt.geo = geo;
        cfg.lastGeo = geo;
        this._saveStore();
        this._log(id, `出口 IP: ${geo.ip} (${geo.countryCode} ${geo.city}, 时区=${geo.timezone}, ISP=${geo.isp})`);
      } else {
        this._log(id, '出口 IP 检测超时，将使用默认时区配置');
      }
    }

    const resolvedTz = cfg.autoIpEnv && geo?.timezone ? geo.timezone : process.env.TZ || 'Asia/Shanghai';
    const resolvedLocale = resolvePhoneLocale(cfg, geo);
    rt.resolvedTz = resolvedTz;
    rt.resolvedLocale = resolvedLocale;

    const { emuPort, scrcpyPort } = this._allocatePorts();
    rt.emuPort = emuPort;
    rt.scrcpyPort = scrcpyPort;

    const adbBin = path.join(this.sdkRoot, 'platform-tools', 'adb');
    const emuBin = path.join(this.sdkRoot, 'emulator', 'emulator');
    const adb = new AdbClient({ adbBin, serial: `emulator-${emuPort}` });
    rt.adb = adb;

    const emuArgs = [
      '-avd', cfg.avdName,
      '-port', String(emuPort),
      '-no-window',
      '-gpu', this.gpu,
      '-no-audio',
      '-no-boot-anim',
      '-no-metrics',
      '-memory', String(cfg.ramMb),
      '-cores', String(cfg.cores),
      '-change-locale', resolvedLocale,
    ];
    if (cfg.dnsServers && cfg.dnsServers !== 'auto') {
      const primaryDns = cfg.dnsServers.split(',')[0].trim();
      if (primaryDns) {
        emuArgs.push('-dns-server', primaryDns);
      }
    }
    if (cfg.httpProxy) {
      emuArgs.push('-http-proxy', cfg.httpProxy);
    }

    this._setProgress(id, {
      stage: 'booting',
      progress: 78,
      message: `正在启动 Android ${cfg.androidVersion} (语言=${resolvedLocale}, 时区=${resolvedTz})…`,
    });
    this._log(id, `启动 emulator -port ${emuPort} -change-locale ${resolvedLocale} (TZ=${resolvedTz})`);

    const proc = spawn(emuBin, emuArgs, {
      env: {
        ...process.env,
        ANDROID_SDK_ROOT: this.sdkRoot,
        ANDROID_HOME: this.sdkRoot,
        QT_QPA_PLATFORM: 'offscreen',
        TZ: resolvedTz,
        PATH: `${path.join(this.sdkRoot, 'platform-tools')}:${path.join(this.sdkRoot, 'emulator')}:${process.env.PATH || ''}`,
      },
    });
    rt.proc = proc;

    proc.stdout.on('data', (d) => {
      for (const l of d.toString('utf8').split('\n')) {
        if (l.trim()) this._log(id, l);
      }
    });
    proc.stderr.on('data', (d) => {
      for (const l of d.toString('utf8').split('\n')) {
        if (l.trim()) this._log(id, l);
      }
    });
    proc.on('exit', (code) => {
      if (rt.proc === proc) {
        const wasStopping = rt.status === 'stopping' || this._shuttingDown;
        this._cleanupRuntime(id);
        if (wasStopping) {
          this._setProgress(id, {
            status: 'stopped',
            stage: 'stopped',
            progress: 0,
            message: '已安全关机',
            error: null,
          });
        } else {
          this._setProgress(id, {
            status: 'error',
            stage: 'error',
            progress: 0,
            message: `模拟器进程意外退出 (code=${code})`,
            error: `exit_code_${code}`,
          });
        }
      }
    });

    // Ensure adb server is running
    await execFileAsync(adbBin, ['start-server'], { timeout: 10_000 }).catch(() => {});

    // Wait for boot_completed
    const bootDeadline = Date.now() + 180_000;
    let bootNotified = false;
    while (Date.now() < bootDeadline) {
      if (rt.status !== 'starting' || rt.proc !== proc) return;
      if (await adb.isDeviceReady()) break;
      if (!bootNotified && Date.now() > bootDeadline - 165_000) {
        bootNotified = true;
        this._setProgress(id, {
          stage: 'booting',
          progress: 88,
          message: '内核已加载，正在等待 Android 与 Google 服务就绪…',
        });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!(await adb.isDeviceReady())) {
      throw new Error('等待 Android 系统启动超时');
    }

    // Post-boot tuning & IP-matched GPS injection
    this._setProgress(id, {
      stage: 'booting',
      progress: 94,
      message: '正在应用防休眠、流畅度与 GPS 定位配置…',
    });
    await adb.shell('settings put global stay_on_while_plugged_in 7').catch(() => {});
    await adb.shell('settings put system screen_off_timeout 2147483647').catch(() => {});
    await adb.shell('svc power stayon true').catch(() => {});
    await adb.shell('svc wifi enable').catch(() => {});
    await adb.shell('cmd wifi connect-network AndroidWifi open').catch(() => {});
    await adb.shell('settings put global auto_time 1').catch(() => {});
    await adb.shell('settings put global cached_apps_freezer enabled').catch(() => {});
    await adb.shell(`settings put global window_animation_scale ${this.animationScale}`).catch(() => {});
    await adb.shell(`settings put global transition_animation_scale ${this.animationScale}`).catch(() => {});
    await adb.shell(`settings put global animator_duration_scale ${this.animationScale}`).catch(() => {});
    await adb.shell('wm dismiss-keyguard').catch(() => {});

    if (cfg.autoIpEnv && geo && Number.isFinite(geo.lon) && Number.isFinite(geo.lat)) {
      await adb.setLocation(geo.lon, geo.lat).catch(() => {});
      this._log(id, `已同步出口 IP 定位: ${geo.city || geo.country} (${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)})`);
    }

    rt.lastActiveAt = Date.now();
    rt.screenAsleep = false;
    this._setProgress(id, {
      status: 'running',
      stage: 'ready',
      progress: 100,
      message: '云手机运行中',
      error: null,
    });
    // Only start video encoder immediately if a viewer is already waiting; otherwise save CPU until viewed!
    if (rt.viewers.size > 0) {
      this._ensureScrcpyStarted(id);
    }
    this._log(id, '云手机已就绪（无画面连接时自动暂停视频编码以节省 CPU）');
  }

  async syncPhoneIpNow(id) {
    const cfg = this.phones.get(id);
    if (!cfg) throw Object.assign(new Error('找不到指定的云手机'), { statusCode: 404 });
    const rt = this._initRuntime(id);
    const geo = await this.geoDetector({ httpProxy: cfg.httpProxy });
    if (!geo) throw new Error('无法检测当前出口 IP 位置');
    rt.geo = geo;
    cfg.lastGeo = geo;
    this._saveStore();
    if (rt.status === 'running' && rt.adb) {
      await rt.adb.setLocation(geo.lon, geo.lat);
      this._log(id, `已手动同步 GPS 至 ${geo.city || geo.country} (${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)})`);
    }
    this._emitPhonesChanged();
    return geo;
  }

  async diagnosePhone(id) {
    const rt = this.runtimes.get(id);
    if (!rt || rt.status !== 'running' || !rt.adb) {
      throw Object.assign(new Error('云手机未运行'), { statusCode: 409 });
    }
    const cmd = [
      'echo "=== DATE ==="; date -u',
      'echo "=== DNS ==="; getprop net.dns1; getprop net.dns2',
      'echo "=== WIFI ==="; dumpsys wifi | grep -E "Wi-Fi is|mNetworkInfo|SSID:" | head -n 6',
      'echo "=== PING 8.8.8.8 ==="; ping -c 2 -W 2 8.8.8.8 2>&1 || true',
      'echo "=== DNS RESOLVE ==="; ping -c 2 -W 2 accounts.google.com 2>&1 || true',
      'echo "=== GMS LOGS ==="; logcat -d -t 200 | grep -iE "Auth|GLSUser|Checkin|PlayStore|NetworkSecurity|SSL|UnknownHost" | tail -n 20 || true',
    ].join('; ');
    const report = await rt.adb.shell(cmd, { timeout: 15000 });
    return { report };
  }

  async fixGoogleServices(id) {
    const rt = this.runtimes.get(id);
    if (!rt || rt.status !== 'running' || !rt.adb) {
      throw Object.assign(new Error('云手机未运行'), { statusCode: 409 });
    }
    this._log(id, '正在重置 Wi-Fi、同步系统时间并清理 Google Play 缓存…');
    await rt.adb.shell('svc wifi disable; sleep 1; svc wifi enable').catch(() => {});
    await rt.adb.shell('settings put global auto_time 1').catch(() => {});
    await rt.adb.shell('pm clear com.android.vending').catch(() => {});
    await rt.adb.shell('am force-stop com.google.android.gms').catch(() => {});
    await rt.adb.shell('am broadcast -a android.server.checkin.CHECKIN').catch(() => {});
    this._log(id, 'Google 服务缓存与网络已重置，请重新打开 Play 商店尝试登录');
    return { ok: true };
  }

  async stopPhone(id) {
    const cfg = this.phones.get(id);
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.status === 'stopped') return;

    this._setProgress(id, {
      status: 'stopping',
      stage: 'stopping',
      progress: 0,
      message: cfg?.engine === 'redroid' ? '正在断开 Redroid 连接…' : '正在保存快照并安全关机…',
    });

    if (rt.scrcpy) {
      rt.scrcpy.stop();
      rt.scrcpy = null;
    }

    if (cfg?.engine === 'redroid') {
      if (cfg.adbAddress) {
        const adbBin = this._resolveAdbBin();
        await execFileAsync(adbBin, ['disconnect', cfg.adbAddress], { timeout: 5_000 }).catch(() => {});
      }
      this._cleanupRuntime(id);
      this._setProgress(id, {
        status: 'stopped',
        stage: 'stopped',
        progress: 0,
        message: '已断开 Redroid 连接，点击一键开机可重新接入',
        error: null,
      });
      return;
    }

    this._log(id, '正在保存 QuickBoot 快照并关机…');

    const proc = rt.proc;
    if (proc && !proc.killed) {
      if (rt.adb) {
        await rt.adb.run(['emu', 'kill'], { timeout: 6000 }).catch(() => {});
      }
      const exited = await new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve(true);
        const timer = setTimeout(() => resolve(false), 12_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        try { proc.kill('SIGTERM'); } catch {}
        await new Promise((r) => setTimeout(r, 2000));
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch {}
        }
      }
    }

    this._cleanupRuntime(id);
    this._setProgress(id, {
      status: 'stopped',
      stage: 'stopped',
      progress: 0,
      message: '已关机，按需启动以节省 CPU 和内存',
      error: null,
    });
  }

  async rebootPhone(id) {
    await this.stopPhone(id);
    await new Promise((r) => setTimeout(r, 500));
    return this.startPhone(id);
  }

  async stopAll() {
    this._shuttingDown = true;
    this.stopBackgroundWatchers();
    const activeIds = Array.from(this.runtimes.entries())
      .filter(([, rt]) => rt.status !== 'stopped')
      .map(([id]) => id);
    await Promise.all(activeIds.map((id) => this.stopPhone(id)));
  }

  _cleanupRuntime(id) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.scrcpy) {
      rt.scrcpy.stop();
      rt.scrcpy = null;
    }
    rt.proc = null;
    rt.adb = null;
    rt.emuPort = null;
    rt.scrcpyPort = null;
  }

  _checkIdleAndEco() {
    const now = Date.now();
    for (const [id, cfg] of this.phones.entries()) {
      const rt = this.runtimes.get(id);
      if (!rt || rt.status !== 'running') continue;

      if (rt.viewers.size > 0) {
        rt.lastActiveAt = now;
        continue;
      }

      const idleMs = now - rt.lastActiveAt;

      // 1) After 15s with no viewer & no API activity: stop scrcpy video encoder & sleep virtual screen to slash CPU
      if (idleMs >= 15_000) {
        if (rt.scrcpy) {
          this._pauseScrcpy(id);
          this._log(id, '[节能] 无观看连接，已暂停 H.264 编码释放 CPU');
        }
        if (cfg.ecoMode !== false && !rt.screenAsleep && rt.adb) {
          rt.screenAsleep = true;
          rt.adb.sleepScreen().catch(() => {});
          this._log(id, '[节能] 虚拟屏幕已息屏省电，打开画面或调用 API 时自动毫秒唤醒');
        }
      }

      // 2) Full graceful shutdown after idleStopMinutes
      if (cfg.idleStopMinutes > 0 && idleMs >= cfg.idleStopMinutes * 60_000) {
        this._log(id, `[自动节能] 已空闲 ${cfg.idleStopMinutes} 分钟无连接，自动安全关机释放资源`);
        this.stopPhone(id).catch(() => {});
      }
    }
  }
}
