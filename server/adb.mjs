import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PKG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

const FEATURED_GOOGLE_APPS = [
  { packageName: 'com.android.vending', label: 'Google Play 商店', category: 'google' },
  { packageName: 'com.android.chrome', label: 'Chrome 浏览器', category: 'google' },
  { packageName: 'com.google.android.gm', label: 'Gmail', category: 'google' },
  { packageName: 'com.google.android.youtube', label: 'YouTube', category: 'google' },
  { packageName: 'com.google.android.apps.photos', label: 'Google 相册', category: 'google' },
  { packageName: 'com.google.android.apps.maps', label: 'Google 地图', category: 'google' },
  { packageName: 'com.google.android.apps.nbu.files', label: '文件极客', category: 'google' },
  { packageName: 'com.android.settings', label: '系统设置', category: 'system' },
];

export function sanitizeSdcardPath(inputPath = '/sdcard/Download') {
  let raw = String(inputPath || '/sdcard/Download').trim().replace(/\\/g, '/');
  if (!raw.startsWith('/')) raw = `/sdcard/${raw}`;
  const normalized = path.posix.normalize(raw);
  if (normalized === '/sdcard' || normalized.startsWith('/sdcard/')) {
    return normalized;
  }
  throw new Error('仅允许访问 /sdcard 目录下的文件');
}

export function validatePackageName(pkg) {
  if (typeof pkg !== 'string' || !PKG_NAME_RE.test(pkg)) {
    throw new Error('非法的应用包名');
  }
  return pkg;
}

export class AdbClient {
  constructor({
    adbBin = process.env.ADB_BIN || null,
    serial = process.env.ADB_SERIAL || `emulator-${process.env.EMU_PORT || 5560}`,
  } = {}) {
    this._explicitAdbBin = adbBin;
    this.serial = serial;
  }

  get adbBin() {
    if (this._explicitAdbBin) return this._explicitAdbBin;
    const sdkAdb = path.join(process.env.ANDROID_SDK_ROOT || '/opt/android-sdk', 'platform-tools', 'adb');
    return fs.existsSync(sdkAdb) ? sdkAdb : 'adb';
  }

  async run(args, { timeout = 15000, maxBuffer = 16 * 1024 * 1024 } = {}) {
    const fullArgs = ['-s', this.serial, ...args];
    const { stdout, stderr } = await execFileAsync(this.adbBin, fullArgs, {
      timeout,
      maxBuffer,
      encoding: 'utf8',
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  async runBuffer(args, { timeout = 20000, maxBuffer = 32 * 1024 * 1024 } = {}) {
    const fullArgs = ['-s', this.serial, ...args];
    const { stdout } = await execFileAsync(this.adbBin, fullArgs, {
      timeout,
      maxBuffer,
      encoding: 'buffer',
    });
    return stdout;
  }

  async shell(command, opts = {}) {
    const { stdout } = await this.run(['shell', command], opts);
    return stdout;
  }

  async isDeviceReady() {
    try {
      const out = await this.shell('getprop sys.boot_completed', { timeout: 4000 });
      return out.trim() === '1';
    } catch {
      return false;
    }
  }

  async getDeviceInfo() {
    try {
      const cmd = [
        'getprop ro.product.model',
        'getprop ro.build.version.release',
        'getprop ro.build.version.sdk',
        'wm size',
        'wm density',
        'getprop persist.sys.locale',
      ].join('; echo "---"; ');
      const out = await this.shell(cmd, { timeout: 6000 });
      const parts = out.split('---').map((s) => s.trim());
      return {
        model: parts[0] || 'Pixel Cloud',
        androidRelease: parts[1] || process.env.ANDROID_VERSION || '16',
        sdkInt: parts[2] || '',
        wmSize: parts[3] || '',
        wmDensity: parts[4] || '',
        locale: parts[5] || process.env.LANG_LOCALE || 'zh-CN',
        serial: this.serial,
      };
    } catch {
      return {
        model: 'Pixel Cloud',
        androidRelease: process.env.ANDROID_VERSION || '16',
        sdkInt: '',
        wmSize: '',
        wmDensity: '',
        locale: process.env.LANG_LOCALE || 'zh-CN',
        serial: this.serial,
      };
    }
  }

  async screenshot() {
    return this.runBuffer(['exec-out', 'screencap', '-p'], { timeout: 15000 });
  }

  async installApk(localFilePath) {
    const { stdout, stderr } = await this.run(['install', '-r', localFilePath], {
      timeout: 180000,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    if (!/Success/i.test(combined)) {
      throw new Error(combined || 'APK 安装失败');
    }
    return combined;
  }

  async listApps() {
    const [allRaw, thirdRaw] = await Promise.all([
      this.shell('pm list packages', { timeout: 10000 }),
      this.shell('pm list packages -3', { timeout: 10000 }),
    ]);

    const installedAll = new Set(
      allRaw
        .split('\n')
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean)
    );
    const thirdParty = thirdRaw
      .split('\n')
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
      .sort();

    const featured = FEATURED_GOOGLE_APPS.filter((a) => installedAll.has(a.packageName)).map(
      (a) => ({
        ...a,
        removable: false,
      })
    );

    const featuredSet = new Set(featured.map((a) => a.packageName));
    const userApps = thirdParty
      .filter((pkg) => !featuredSet.has(pkg))
      .map((pkg) => ({
        packageName: pkg,
        label: pkg.split('.').slice(-1)[0] || pkg,
        category: 'user',
        removable: true,
      }));

    return { featured, userApps };
  }

  async launchApp(packageName) {
    const pkg = validatePackageName(packageName);
    await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 10000 });
  }

  async uninstallApp(packageName) {
    const pkg = validatePackageName(packageName);
    const thirdRaw = await this.shell('pm list packages -3', { timeout: 8000 });
    const thirdSet = new Set(
      thirdRaw
        .split('\n')
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean)
    );
    if (!thirdSet.has(pkg)) {
      throw new Error('为保护 Google 生态和系统稳定，不允许卸载系统预装应用');
    }
    const { stdout, stderr } = await this.run(['uninstall', pkg], { timeout: 30000 });
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    if (!/Success/i.test(combined)) {
      throw new Error(combined || '卸载失败');
    }
    return combined;
  }

  async listFiles(inputPath = '/sdcard/Download') {
    const dir = sanitizeSdcardPath(inputPath);
    const escaped = `'${dir.replace(/'/g, "'\\''")}'`;
    await this.shell(`mkdir -p ${escaped}`, { timeout: 5000 }).catch(() => {});
    const out = await this.shell(
      `ls -la ${escaped} 2>/dev/null | tail -n +1`,
      { timeout: 10000 }
    );

    const entries = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('total ')) continue;
      // Toybox ls -la: drwxrwx--- 2 u0_a123 media_rw 4096 2026-11-23 12:00 filename
      const m = trimmed.match(
        /^([dlcbps-])[\w-]{9}\+?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/
      );
      if (!m) continue;
      const typeChar = m[1];
      const size = Number(m[2]) || 0;
      const mtime = m[3];
      let name = m[4];
      if (typeChar === 'l' && name.includes(' -> ')) {
        name = name.split(' -> ')[0];
      }
      if (name === '.' || name === '..') continue;
      entries.push({
        name,
        path: path.posix.join(dir, name),
        isDir: typeChar === 'd',
        size,
        mtime,
      });
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { path: dir, entries };
  }

  async pushFile(localPath, targetDir, filename) {
    const safeDir = sanitizeSdcardPath(targetDir);
    const safeName = path.posix.basename(String(filename || 'upload.bin')).replace(/[/\\]/g, '_');
    const remotePath = path.posix.join(safeDir, safeName);
    const escapedDir = `'${safeDir.replace(/'/g, "'\\''")}'`;
    await this.shell(`mkdir -p ${escapedDir}`, { timeout: 5000 }).catch(() => {});
    await this.run(['push', localPath, remotePath], { timeout: 120000 });
    // Trigger Android media scanner so uploaded images/videos appear in Gallery immediately
    const escapedFile = `'file://${remotePath.replace(/'/g, "'\\''")}'`;
    await this.shell(
      `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${escapedFile}`,
      { timeout: 5000 }
    ).catch(() => {});
    return remotePath;
  }

  async pullToTempFile(remoteInputPath) {
    const remotePath = sanitizeSdcardPath(remoteInputPath);
    const tmpName = `droidcloud-pull-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    await this.run(['pull', remotePath, tmpPath], { timeout: 120000 });
    return {
      tmpPath,
      filename: path.posix.basename(remotePath),
      cleanup: () => fs.promises.unlink(tmpPath).catch(() => {}),
    };
  }

  async deleteFile(remoteInputPath) {
    const remotePath = sanitizeSdcardPath(remoteInputPath);
    if (remotePath === '/sdcard' || remotePath === '/sdcard/Download') {
      throw new Error('不允许删除根目录');
    }
    const escaped = `'${remotePath.replace(/'/g, "'\\''")}'`;
    await this.shell(`rm -rf ${escaped}`, { timeout: 15000 });
  }

  async setLocation(lon, lat) {
    const lo = Number(lon);
    const la = Number(lat);
    if (!Number.isFinite(lo) || !Number.isFinite(la) || lo < -180 || lo > 180 || la < -90 || la > 90) {
      throw new Error('无效的经纬度坐标');
    }
    await this.run(['emu', 'geo', 'fix', String(lo), String(la)], { timeout: 8000 });
  }

  async forwardPort(localPort, remoteAbstract) {
    await this.run(['forward', `tcp:${localPort}`, `localabstract:${remoteAbstract}`], {
      timeout: 8000,
    });
  }

  async removeForward(localPort) {
    await this.run(['forward', '--remove', `tcp:${localPort}`], { timeout: 5000 }).catch(() => {});
  }

  async pushServer(localJarPath, remoteJarPath = '/data/local/tmp/scrcpy-server.jar') {
    await this.run(['push', localJarPath, remoteJarPath], { timeout: 20000 });
  }

  spawnShell(args) {
    return spawn(this.adbBin, ['-s', this.serial, 'shell', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}
