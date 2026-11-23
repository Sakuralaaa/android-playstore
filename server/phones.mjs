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
  { version: '14', api: 'android-34', label: 'Android 14 (兼容)' },
];

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
  const versionRaw = String(input.androidVersion ?? existing?.androidVersion ?? process.env.ANDROID_VERSION ?? '16');
  const androidVersion = ANDROID_VERSIONS.some((v) => v.version === versionRaw) ? versionRaw : '16';
  const deviceRaw = String(input.device ?? existing?.device ?? process.env.DEVICE ?? 'pixel_8');
  const device = DEVICE_PROFILES.some((d) => d.id === deviceRaw) ? deviceRaw : 'pixel_7';
  const screenRaw = String(input.screenPreset ?? existing?.screenPreset ?? process.env.SCREEN_PRESET ?? 'balanced');
  const screenPreset = SCREEN_PRESETS[screenRaw] ? screenRaw : 'balanced';
  const streamRaw = String(input.streamPreset ?? existing?.streamPreset ?? process.env.STREAM_PRESET ?? 'balanced');
  const streamPreset = QUALITY_PRESETS[streamRaw] ? streamRaw : 'balanced';

  const ramMb = Math.max(2048, Math.min(8192, Number(input.ramMb ?? existing?.ramMb ?? process.env.RAM_MB ?? 4096) || 4096));
  const cores = Math.max(1, Math.min(8, Number(input.cores ?? existing?.cores ?? process.env.CORES ?? 4) || 4));
  const dataSizeRaw = String(input.dataSize ?? existing?.dataSize ?? process.env.DATA_SIZE ?? '16G').trim();
  const dataSize = /^\d+[GM]$/i.test(dataSizeRaw) ? dataSizeRaw.toUpperCase() : '16G';

  const localeMode = String(input.localeMode ?? existing?.localeMode ?? 'zh-CN');
  const customLocale = String(input.customLocale ?? existing?.customLocale ?? '').trim();
  const autoIpEnv = input.autoIpEnv !== undefined ? Boolean(input.autoIpEnv) : (existing?.autoIpEnv ?? true);
  const httpProxy = String(input.httpProxy ?? existing?.httpProxy ?? process.env.HTTP_PROXY_URL ?? '').trim();
  const dnsServers = String(input.dnsServers ?? existing?.dnsServers ?? process.env.DNS_SERVERS ?? '8.8.8.8,1.1.1.1').trim() || '8.8.8.8,1.1.1.1';
  const idleStopMinutes = Math.max(0, Math.min(1440, Number(input.idleStopMinutes ?? existing?.idleStopMinutes ?? 30) || 0));

  return {
    name,
    androidVersion,
    imgTag: 'google_apis_playstore',
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
    this._ensureAtLeastOneDefault();
  }

  startBackgroundWatchers() {
    if (this._idleTimer) return;
    this._idleTimer = setInterval(() => this._checkIdleAutoStop(), 30_000);
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

        const verMatch = avdName.match(/a(1[4567])/);
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
    const id = `phone-${crypto.randomBytes(4).toString('hex')}`;
    const clean = sanitizePhoneConfig(input);
    const avdName = `dc-${id}-a${clean.androidVersion}`;
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
    const updatedCfg = sanitizePhoneConfig(patch, existing);
    // Do not change Android version of an already-created AVD in-place
    if (fs.existsSync(path.join(this.avdDirRoot, `${existing.avdName}.avd`))) {
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
    // Remove AVD files to free disk space
    const avdIni = path.join(this.avdDirRoot, `${cfg.avdName}.ini`);
    const avdDir = path.join(this.avdDirRoot, `${cfg.avdName}.avd`);
    await fs.promises.rm(avdIni, { force: true }).catch(() => {});
    await fs.promises.rm(avdDir, { recursive: true, force: true }).catch(() => {});

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
    this._emitPhonesChanged();
  }

  detachViewer(id, wsClient) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.viewers.delete(wsClient);
    rt.lastActiveAt = Date.now();
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

  async _bootPipeline(id, cfg, rt) {
    if (!fs.existsSync('/dev/kvm')) {
      throw new Error('宿主机未挂载 /dev/kvm，无法启动 KVM 加速模拟器');
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
      '-dns-server', cfg.dnsServers,
      '-change-locale', resolvedLocale,
    ];
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
    await adb.shell(`settings put global window_animation_scale ${this.animationScale}`).catch(() => {});
    await adb.shell(`settings put global transition_animation_scale ${this.animationScale}`).catch(() => {});
    await adb.shell(`settings put global animator_duration_scale ${this.animationScale}`).catch(() => {});
    await adb.shell('wm dismiss-keyguard').catch(() => {});

    if (cfg.autoIpEnv && geo && Number.isFinite(geo.lon) && Number.isFinite(geo.lat)) {
      await adb.setLocation(geo.lon, geo.lat).catch(() => {});
      this._log(id, `已同步出口 IP 定位: ${geo.city || geo.country} (${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)})`);
    }

    // Start dedicated scrcpy video/control stream
    const scrcpy = new ScrcpyManager({
      adb,
      serverJarPath: this.scrcpyServerPath,
      localPort: scrcpyPort,
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

    rt.lastActiveAt = Date.now();
    this._setProgress(id, {
      status: 'running',
      stage: 'ready',
      progress: 100,
      message: '云手机运行中',
      error: null,
    });
    this._log(id, '云手机已就绪，可以点击「进入屏幕」开始操作！');
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

  async stopPhone(id) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.status === 'stopped') return;

    this._setProgress(id, {
      status: 'stopping',
      stage: 'stopping',
      progress: 0,
      message: '正在保存快照并安全关机…',
    });
    this._log(id, '正在保存 QuickBoot 快照并关机…');

    if (rt.scrcpy) {
      rt.scrcpy.stop();
      rt.scrcpy = null;
    }

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

  _checkIdleAutoStop() {
    const now = Date.now();
    for (const [id, cfg] of this.phones.entries()) {
      const rt = this.runtimes.get(id);
      if (!rt || rt.status !== 'running') continue;
      if (!cfg.idleStopMinutes || cfg.idleStopMinutes <= 0) continue;
      if (rt.viewers.size > 0) {
        rt.lastActiveAt = now;
        continue;
      }
      const idleMs = now - rt.lastActiveAt;
      if (idleMs >= cfg.idleStopMinutes * 60_000) {
        this._log(id, `[自动节能] 已空闲 ${cfg.idleStopMinutes} 分钟无连接，自动安全关机释放资源`);
        this.stopPhone(id).catch(() => {});
      }
    }
  }
}
