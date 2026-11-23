import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let prevCpuTimes = null;

function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] || 0) + (parts[4] || 0);
    const total = parts.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function getCpuPercent() {
  const curr = readCpuTimes();
  if (!curr) return 0;
  if (!prevCpuTimes) {
    prevCpuTimes = curr;
    return 0;
  }
  const dTotal = curr.total - prevCpuTimes.total;
  const dIdle = curr.idle - prevCpuTimes.idle;
  prevCpuTimes = curr;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
}

function getMemoryStats() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) map[m[1]] = Number(m[2]);
    }
    const totalKb = map.MemTotal || Math.round(os.totalmem() / 1024);
    const availKb = map.MemAvailable ?? map.MemFree ?? Math.round(os.freemem() / 1024);
    const usedKb = Math.max(0, totalKb - availKb);
    return {
      memTotalMb: Math.round(totalKb / 1024),
      memUsedMb: Math.round(usedKb / 1024),
    };
  } catch {
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    return { memTotalMb: totalMb, memUsedMb: Math.max(0, totalMb - freeMb) };
  }
}

async function getDiskStats(targetPath = '/root/.android') {
  const checkPath = fs.existsSync(targetPath) ? targetPath : '/';
  try {
    const { stdout } = await execFileAsync('df', ['-k', checkPath], { timeout: 3000 });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const cols = lines[lines.length - 1].trim().split(/\s+/);
      const totalKb = Number(cols[1]) || 0;
      const usedKb = Number(cols[2]) || 0;
      return {
        diskTotalGb: Number((totalKb / 1024 / 1024).toFixed(1)),
        diskUsedGb: Number((usedKb / 1024 / 1024).toFixed(1)),
      };
    }
  } catch {
    // ignore
  }
  return { diskTotalGb: 0, diskUsedGb: 0 };
}

export async function collectSystemMetrics() {
  const cpuPercent = getCpuPercent();
  const mem = getMemoryStats();
  const disk = await getDiskStats();
  return {
    cpuPercent,
    cpuCores: os.cpus().length,
    ...mem,
    ...disk,
    uptimeSec: Math.floor(process.uptime()),
  };
}
