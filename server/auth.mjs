import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'droidcloud_session';
const SESSION_TTL_SEC = 7 * 24 * 3600; // 7 days
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_FAILS = 10;

function sha256(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest();
}

export function parseCookies(cookieHeader = '') {
  const result = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function isHttpsRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (proto.split(',')[0].trim() === 'https') return true;
  return Boolean(req.socket?.encrypted);
}

export class AuthManager {
  constructor({ password = null, persistDir = null, secret = null } = {}) {
    this.generated = false;
    this.password = this._resolvePassword(password, persistDir);
    this._passwordHash = sha256(this.password);
    this._secret = secret
      ? sha256(secret)
      : crypto
          .createHmac('sha256', 'droidcloud-session-key-v1')
          .update(this.password)
          .digest();
    this._attempts = new Map();
  }

  _resolvePassword(explicit, persistDir) {
    const envPass =
      explicit ??
      process.env.ACCESS_PASSWORD ??
      process.env.WEB_PASSWORD ??
      process.env.VNC_PASSWORD ??
      '';
    if (String(envPass).trim().length > 0) {
      return String(envPass).trim();
    }

    const candidates = [
      persistDir ? path.join(persistDir, '.droidcloud_password') : null,
      '/root/.android/.droidcloud_password',
      '/tmp/.droidcloud_password',
    ].filter(Boolean);

    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const saved = fs.readFileSync(file, 'utf8').trim();
          if (saved.length >= 8) {
            this.generated = true;
            return saved;
          }
        }
      } catch {
        // try next
      }
    }

    const generated = crypto.randomBytes(12).toString('base64url');
    this.generated = true;
    for (const file of candidates) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
        break;
      } catch {
        // try next
      }
    }
    return generated;
  }

  checkRateLimit(ip) {
    const now = Date.now();
    const list = (this._attempts.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (list.length === 0) {
      this._attempts.delete(ip);
      return { allowed: true, remaining: RATE_MAX_FAILS, retryAfterSec: 0 };
    }
    this._attempts.set(ip, list);
    if (list.length >= RATE_MAX_FAILS) {
      const oldest = list[0];
      const retryAfterSec = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    return { allowed: true, remaining: RATE_MAX_FAILS - list.length, retryAfterSec: 0 };
  }

  recordFailure(ip) {
    const now = Date.now();
    const list = (this._attempts.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
    list.push(now);
    this._attempts.set(ip, list);
  }

  clearFailures(ip) {
    this._attempts.delete(ip);
  }

  verifyPassword(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const candidateHash = sha256(candidate);
    return crypto.timingSafeEqual(candidateHash, this._passwordHash);
  }

  createToken() {
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + SESSION_TTL_SEC,
        nonce: crypto.randomBytes(8).toString('hex'),
      })
    ).toString('base64url');

    const sig = crypto
      .createHmac('sha256', this._secret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!sig) return false;

    const expected = crypto
      .createHmac('sha256', this._secret)
      .update(payload)
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const now = Math.floor(Date.now() / 1000);
      return typeof decoded.exp === 'number' && decoded.exp > now;
    } catch {
      return false;
    }
  }

  isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    return this.verifyToken(token);
  }

  buildLoginCookie(req, token) {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${SESSION_TTL_SEC}`,
    ];
    if (isHttpsRequest(req)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  buildLogoutCookie(req) {
    const parts = [
      `${SESSION_COOKIE}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ];
    if (isHttpsRequest(req)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }
}
