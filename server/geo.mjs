import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const COUNTRY_TO_LOCALE = {
  US: 'en-US',
  GB: 'en-GB',
  UK: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  SG: 'en-SG',
  IN: 'en-IN',
  PH: 'en-PH',
  JP: 'ja-JP',
  KR: 'ko-KR',
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  ES: 'es-ES',
  MX: 'es-MX',
  IT: 'it-IT',
  NL: 'nl-NL',
  PT: 'pt-PT',
  BR: 'pt-BR',
  RU: 'ru-RU',
  TR: 'tr-TR',
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  MY: 'ms-MY',
  HK: 'zh-HK',
  MO: 'zh-HK',
  TW: 'zh-TW',
  CN: 'zh-CN',
};

export function localeForCountry(countryCode) {
  const cc = String(countryCode || '').trim().toUpperCase();
  return COUNTRY_TO_LOCALE[cc] || 'en-US';
}

export function resolvePhoneLocale(phone, geo = null) {
  const mode = phone?.localeMode || 'zh-CN';
  if (mode === 'auto_ip') {
    return geo?.suggestedLocale || localeForCountry(geo?.countryCode) || 'en-US';
  }
  if (mode === 'custom') {
    const custom = String(phone?.customLocale || '').trim();
    if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(custom)) return custom;
    return 'zh-CN';
  }
  if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(mode)) {
    return mode;
  }
  return 'zh-CN';
}

async function fetchJsonViaCurl(url, httpProxy = '') {
  const args = ['-fsSL', '--max-time', '6'];
  if (httpProxy && String(httpProxy).trim()) {
    args.push('-x', String(httpProxy).trim());
  }
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, { timeout: 8000, encoding: 'utf8' });
  return JSON.parse(stdout);
}

export async function detectIpGeo({ httpProxy = '' } = {}) {
  // Provider 1: ipwho.is (HTTPS, clean JSON, includes timezone id + lat/lon)
  try {
    const d = await fetchJsonViaCurl('https://ipwho.is/', httpProxy);
    if (d && d.success !== false && d.country_code) {
      const countryCode = String(d.country_code).toUpperCase();
      return {
        ip: d.ip || '',
        countryCode,
        country: d.country || countryCode,
        city: d.city || '',
        timezone: d.timezone?.id || 'UTC',
        lat: Number(d.latitude) || 0,
        lon: Number(d.longitude) || 0,
        isp: d.connection?.isp || d.connection?.org || '',
        suggestedLocale: localeForCountry(countryCode),
        detectedAt: Date.now(),
      };
    }
  } catch {
    // fallback to provider 2
  }

  // Provider 2: ip-api.com
  try {
    const d = await fetchJsonViaCurl(
      'http://ip-api.com/json/?fields=status,query,country,countryCode,city,timezone,lat,lon,isp',
      httpProxy
    );
    if (d && d.status === 'success' && d.countryCode) {
      const countryCode = String(d.countryCode).toUpperCase();
      return {
        ip: d.query || '',
        countryCode,
        country: d.country || countryCode,
        city: d.city || '',
        timezone: d.timezone || 'UTC',
        lat: Number(d.lat) || 0,
        lon: Number(d.lon) || 0,
        isp: d.isp || '',
        suggestedLocale: localeForCountry(countryCode),
        detectedAt: Date.now(),
      };
    }
  } catch {
    // ignore
  }

  return null;
}
