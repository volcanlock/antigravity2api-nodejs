import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { QUOTA_CACHE_TTL, QUOTA_CLEANUP_INTERVAL } from '../constants/index.js';
import { decimalSubtract, decimalShiftPow10, isZeroDecimal, normalizeDecimalString } from '../utils/decimal.js';
import config from '../config/config.js';

class QuotaManager {
  /**
   * @param {string} filePath - 额度数据文件路径
   */
  constructor(filePath = path.join(getDataDir(), 'quotas.json')) {
    this.filePath = filePath;
    /** @type {Map<string, {lastUpdated: number, models: Object}>} */
    this.cache = new Map();
    this.CACHE_TTL = QUOTA_CACHE_TTL;
    this.CLEANUP_INTERVAL = QUOTA_CLEANUP_INTERVAL;
    this.cleanupTimer = null;
    this.ensureFileExists();
    this.loadFromFile();
    this.startCleanupTimer();
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL }, quotas: {} }, null, 2), 'utf8');
    }
  }

  loadFromFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      Object.entries(parsed.quotas || {}).forEach(([key, value]) => {
        this.cache.set(key, value);
      });
    } catch (error) {
      log.error('加载额度文件失败:', error.message);
    }
  }

  saveToFile() {
    try {
      const quotas = {};
      this.cache.forEach((value, key) => {
        quotas[key] = value;
      });
      const data = {
        meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL },
        quotas
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      log.error('保存额度文件失败:', error.message);
    }
  }

  updateQuota(refreshToken, quotas) {
    const prev = this.cache.get(refreshToken);
    this.cache.set(refreshToken, {
      lastUpdated: Date.now(),
      models: quotas,
      usage: this._ensureUsageObject(prev?.usage)
    });
    this.saveToFile();
  }

  updateQuotaWithUsage(refreshToken, quotas, options = {}) {
    const prev = this.cache.get(refreshToken);
    const usage = this._ensureUsageObject(prev?.usage);
    const calledAt = Number.isFinite(options.calledAt) ? options.calledAt : Date.now();
    const requestedModel = options.requestedModel || null;
    const mode = options.mode === 'precise' ? 'precise' : 'default';
    const overwriteModelsOnNoUsage = options.overwriteModelsOnNoUsage !== false;
    const settings = this._getQuotaUsageSettings();
    const mirrorToPrecise = options.mirrorToPrecise === true;

    let recorded = false;
    let shouldOverwriteModels = true;

    if (settings.enabled && requestedModel && prev?.models && quotas) {
      const matchedModelId = this._matchModelId(quotas, requestedModel);
      if (matchedModelId && prev.models[matchedModelId] && quotas[matchedModelId]) {
        const prevRaw = String(prev.models[matchedModelId]?.r_raw ?? prev.models[matchedModelId]?.r ?? '');
        const nextRaw = String(quotas[matchedModelId]?.r_raw ?? quotas[matchedModelId]?.r ?? '');
        const prevNorm = normalizeDecimalString(prevRaw);
        const nextNorm = normalizeDecimalString(nextRaw);

        if (prevNorm && nextNorm) {
          const consumedFraction = decimalSubtract(prevNorm, nextNorm); // prev - next
          const isNegative = consumedFraction?.startsWith('-');
          if (consumedFraction && isNegative && !isZeroDecimal(consumedFraction)) {
            // Remaining increased (reset/credit). Move baseline forward regardless of mode.
            shouldOverwriteModels = true;
          } else if (consumedFraction && !isNegative && !isZeroDecimal(consumedFraction)) {
            const consumedPercent = decimalShiftPow10(consumedFraction, 2); // *100
            const prevPercent = decimalShiftPow10(prevNorm, 2);
            const nextPercent = decimalShiftPow10(nextNorm, 2);
            const groupKey = this._groupKeyForModelId(matchedModelId);
            const tokens = this._normalizeTokenUsage(options.tokens);
            const entry = {
              modelId: matchedModelId,
              requestedModel,
              mode,
              prevRemainingRaw: prevRaw,
              nextRemainingRaw: nextRaw,
              prevPercentRaw: prevPercent,
              nextPercentRaw: nextPercent,
              consumedFractionRaw: consumedFraction,
              consumedPercentRaw: consumedPercent,
              tokens,
              calledAt
            };
            usage.last = entry;
            usage.models[matchedModelId] = entry;
            usage.groups[groupKey] = entry;

            this._appendUsagePoint(usage, matchedModelId, mode, entry, calledAt, settings);
            if (mirrorToPrecise && mode === 'default') {
              this._appendUsagePoint(usage, matchedModelId, 'precise', entry, calledAt, settings);
            }
            recorded = true;
            shouldOverwriteModels = true;
          } else {
            // No visible change yet; in precise mode we may want to keep the previous baseline.
            shouldOverwriteModels = overwriteModelsOnNoUsage;
          }
        }
      }
    }

    this.cache.set(refreshToken, {
      lastUpdated: Date.now(),
      models: shouldOverwriteModels ? quotas : (prev?.models || quotas),
      usage
    });
    this.saveToFile();
    return { recorded };
  }

  getQuotaRecord(refreshToken, options = {}) {
    const ignoreTTL = options.ignoreTTL === true;
    const data = this.cache.get(refreshToken);
    if (!data) return null;
    if (!ignoreTTL && Date.now() - data.lastUpdated > this.CACHE_TTL) return null;
    return data;
  }

  _matchModelId(quotas, requestedModel) {
    if (!requestedModel) return null;
    const req = String(requestedModel).trim();
    if (!req) return null;
    if (quotas[req]) return req;

    const lower = req.toLowerCase();
    const keys = Object.keys(quotas || {});
    return keys.find(k => {
      const kk = k.toLowerCase();
      if (kk === lower) return true;
      if (kk.endsWith(`/${lower}`)) return true;
      return kk.endsWith(lower);
    }) || null;
  }

  _groupKeyForModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (id.includes('claude')) return 'claude';
    if (id.includes('gemini-3-pro-image')) return 'banana';
    if (id.includes('gemini') || id.includes('publishers/google/')) return 'gemini';
    return 'other';
  }

  getQuota(refreshToken) {
    return this.getQuotaRecord(refreshToken, { ignoreTTL: false });
  }

  _getQuotaUsageSettings() {
    const quotaUsage = config?.quotaUsage || {};
    const retentionMs = Number.isFinite(quotaUsage.retentionMs) ? quotaUsage.retentionMs : 24 * 60 * 60 * 1000;
    const maxPointsPerModel = Number.isFinite(quotaUsage.maxPointsPerModel) ? quotaUsage.maxPointsPerModel : 2000;
    return {
      enabled: quotaUsage.enabled !== false,
      retentionMs,
      maxPointsPerModel
    };
  }

  _ensureUsageObject(usage) {
    const u = usage && typeof usage === 'object' ? usage : {};
    if (!u.last) u.last = null;
    if (!u.groups || typeof u.groups !== 'object') u.groups = {};
    if (!u.models || typeof u.models !== 'object') u.models = {};
    if (!u.series || typeof u.series !== 'object') u.series = { default: {}, precise: {} };
    if (!u.series.default || typeof u.series.default !== 'object') u.series.default = {};
    if (!u.series.precise || typeof u.series.precise !== 'object') u.series.precise = {};
    return u;
  }

  _normalizeTokenUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const prompt = Number(raw.prompt_tokens);
    const completion = Number(raw.completion_tokens);
    const total = Number(raw.total_tokens);
    const out = {};
    if (Number.isFinite(prompt)) out.prompt_tokens = Math.max(0, Math.floor(prompt));
    if (Number.isFinite(completion)) out.completion_tokens = Math.max(0, Math.floor(completion));
    if (Number.isFinite(total)) out.total_tokens = Math.max(0, Math.floor(total));
    return Object.keys(out).length ? out : null;
  }

  _appendUsagePoint(usage, modelId, mode, entry, calledAt, settings) {
    const safeMode = mode === 'precise' ? 'precise' : 'default';
    const seriesByMode = usage.series[safeMode] || (usage.series[safeMode] = {});
    const list = seriesByMode[modelId] || (seriesByMode[modelId] = []);

    const point = {
      t: calledAt,
      v: entry?.consumedPercentRaw ?? null,
      a: entry?.prevPercentRaw ?? null,
      b: entry?.nextPercentRaw ?? null
    };
    const tokens = entry?.tokens;
    if (tokens?.prompt_tokens !== undefined) point.pt = tokens.prompt_tokens;
    if (tokens?.completion_tokens !== undefined) point.ct = tokens.completion_tokens;
    if (tokens?.total_tokens !== undefined) point.tt = tokens.total_tokens;

    list.push(point);

    const now = Date.now();
    const minT = now - Math.max(0, Number(settings.retentionMs) || 0);
    if (Number.isFinite(minT)) {
      // Prune by retention window
      const firstKeepIdx = list.findIndex(p => Number(p?.t) >= minT);
      if (firstKeepIdx > 0) list.splice(0, firstKeepIdx);
    }

    const cap = Math.max(0, Number(settings.maxPointsPerModel) || 0);
    if (cap > 0 && list.length > cap) {
      list.splice(0, list.length - cap);
    }
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    this.cache.forEach((value, key) => {
      if (now - value.lastUpdated > this.CLEANUP_INTERVAL) {
        this.cache.delete(key);
        cleaned++;
      }
    });
    
    if (cleaned > 0) {
      log.info(`清理了 ${cleaned} 个过期的额度记录`);
      this.saveToFile();
    }
  }

  startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  convertToBeijingTime(utcTimeStr) {
    if (!utcTimeStr) return 'N/A';
    try {
      const utcDate = new Date(utcTimeStr);
      return utcDate.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    } catch (error) {
      return 'N/A';
    }
  }
}

const quotaManager = new QuotaManager();
export default quotaManager;
