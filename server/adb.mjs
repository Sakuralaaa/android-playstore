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

export const NAMED_KEYCODES = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  center: 23,
  vol_up: 24,
  vol_down: 25,
  power: 26,
  camera: 27,
  tab: 61,
  space: 62,
  enter: 66,
  delete: 67,
  backspace: 67,
  menu: 82,
  search: 84,
  escape: 111,
  recents: 187,
  sleep: 223,
  wakeup: 224,
  paste: 279,
};

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

function unescapeXml(str = '') {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseUiHierarchyXml(xml) {
  const elements = [];
  const nodeRe = /<node\s+([^>]+?)\/?>/g;
  let match;
  let index = 0;

  while ((match = nodeRe.exec(xml)) !== null) {
    const attrStr = match[1];
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrStr)) !== null) {
      attrs[am[1]] = unescapeXml(am[2]);
    }

    const boundsMatch = (attrs.bounds || '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!boundsMatch) continue;
    const x1 = Number(boundsMatch[1]);
    const y1 = Number(boundsMatch[2]);
    const x2 = Number(boundsMatch[3]);
    const y2 = Number(boundsMatch[4]);
    const clickable = attrs.clickable === 'true';
    const editable = attrs.class?.includes('EditText') || attrs['editable'] === 'true';
    const text = attrs.text || '';
    const contentDesc = attrs['content-desc'] || '';
    const resourceId = attrs['resource-id'] || '';

    // Filter to actionable or informative nodes so AI agents get a crisp, low-token tree
    if (!text && !contentDesc && !clickable && !editable && !resourceId) continue;
    if (x2 <= x1 || y2 <= y1) continue;

    elements.push({
      id: index++,
      text,
      contentDesc,
      resourceId,
      className: (attrs.class || '').split('.').pop() || '',
      clickable,
      editable,
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      bounds: { x1, y1, x2, y2 },
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
    });
  }

  return elements;
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

  async getScreenInfo() {
    const out = await this.shell(
      'wm size; echo "---"; dumpsys window displays | grep -m1 "mCurrentFocus" || dumpsys activity activities | grep -m1 "ResumedActivity" || true',
      { timeout: 6000 }
    );
    const [sizeRaw = '', focusRaw = ''] = out.split('---');
    const sizeMatch = sizeRaw.match(/(\d+)x(\d+)/g);
    const lastSize = sizeMatch ? sizeMatch[sizeMatch.length - 1] : '720x1600';
    const [width, height] = lastSize.split('x').map(Number);
    return {
      width: width || 720,
      height: height || 1600,
      focusedWindow: focusRaw.trim(),
    };
  }

  async getUiTree({ includeXml = false } = {}) {
    const remoteXml = '/data/local/tmp/droidcloud-ui.xml';
    await this.shell(`uiautomator dump ${remoteXml} >/dev/null 2>&1`, { timeout: 15000 });
    const xml = await this.shell(`cat ${remoteXml}`, { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    const elements = parseUiHierarchyXml(xml);
    return includeXml ? { elements, xml } : { elements };
  }

  async inputTap(x, y) {
    const ix = Math.max(0, Math.round(Number(x)));
    const iy = Math.max(0, Math.round(Number(y)));
    await this.shell(`input tap ${ix} ${iy}`, { timeout: 8000 });
  }

  async inputLongPress(x, y, durationMs = 800) {
    const ix = Math.max(0, Math.round(Number(x)));
    const iy = Math.max(0, Math.round(Number(y)));
    const d = Math.max(200, Math.min(5000, Math.round(Number(durationMs) || 800)));
    await this.shell(`input swipe ${ix} ${iy} ${ix} ${iy} ${d}`, { timeout: 10000 });
  }

  async inputSwipe(x1, y1, x2, y2, durationMs = 300) {
    const a = Math.max(0, Math.round(Number(x1)));
    const b = Math.max(0, Math.round(Number(y1)));
    const c = Math.max(0, Math.round(Number(x2)));
    const d = Math.max(0, Math.round(Number(y2)));
    const ms = Math.max(50, Math.min(5000, Math.round(Number(durationMs) || 300)));
    await this.shell(`input swipe ${a} ${b} ${c} ${d} ${ms}`, { timeout: 10000 });
  }

  async inputKey(keycodeOrName) {
    let code;
    if (typeof keycodeOrName === 'string' && NAMED_KEYCODES[keycodeOrName.toLowerCase()] !== undefined) {
      code = NAMED_KEYCODES[keycodeOrName.toLowerCase()];
    } else {
      code = Number(keycodeOrName);
    }
    if (!Number.isInteger(code) || code < 0 || code > 1000) {
      throw new Error('无效的按键码');
    }
    await this.shell(`input keyevent ${code}`, { timeout: 8000 });
  }

  async inputAsciiText(text) {
    const escaped = String(text)
      .replace(/\\/g, '\\\\')
      .replace(/ /g, '%s')
      .replace(/(['"`$&|;<>()!])/g, '\\$1');
    await this.shell(`input text "${escaped}"`, { timeout: 10000 });
  }

  async wakeScreen() {
    await this.shell('input keyevent 224; wm dismiss-keyguard', { timeout: 6000 }).catch(() => {});
  }

  async sleepScreen() {
    await this.shell('input keyevent 223', { timeout: 6000 }).catch(() => {});
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
