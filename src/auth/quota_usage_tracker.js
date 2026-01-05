import quotaManager from './quota_manager.js';
import { getModelsWithQuotas } from '../api/client.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const inflight = new Map(); // refreshToken -> Promise

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDelaysMs(value, fallback) {
  const raw = Array.isArray(value) ? value : fallback;
  const nums = raw
    .map(v => Number(v))
    .filter(v => Number.isFinite(v))
    .map(v => Math.max(0, Math.floor(v)));
  return nums.length ? nums : fallback;
}

export function scheduleQuotaUsageUpdate(token, requestedModel, tokens = null) {
  const refreshToken = token?.refresh_token;
  const accessToken = token?.access_token;
  if (!refreshToken || !accessToken) return;

  const quotaUsage = config?.quotaUsage || {};
  if (quotaUsage.enabled === false) return;

  const calledAt = Date.now();

  const runSampling = async ({ mode, delaysMs, overwriteModelsOnNoUsage }) => {
    let prevDelay = 0;
    for (const delay of delaysMs) {
      const d = Math.max(0, Number(delay) || 0);
      const sleepMs = Math.max(0, d - prevDelay);
      prevDelay = d;
      if (sleepMs > 0) await sleep(sleepMs);

      const quotas = await getModelsWithQuotas({ access_token: accessToken, refresh_token: refreshToken });
      const result = quotaManager.updateQuotaWithUsage(refreshToken, quotas, {
        requestedModel,
        calledAt,
        mode,
        tokens,
        mirrorToPrecise: mode === 'default' && (quotaUsage.preciseEnabled !== false),
        overwriteModelsOnNoUsage
      });
      if (result?.recorded) return true;
    }
    return false;
  };

  const run = async () => {
    const defaultDelaysMs = normalizeDelaysMs(quotaUsage.defaultDelaysMs, [0]);
    const preciseDelaysMs = normalizeDelaysMs(quotaUsage.preciseDelaysMs, [0, 8000, 20000]);
    const wantPrecise = quotaUsage.preciseEnabled !== false;

    const recordedDefault = await runSampling({
      mode: 'default',
      delaysMs: defaultDelaysMs,
      overwriteModelsOnNoUsage: wantPrecise ? false : true
    });

    if (!recordedDefault && wantPrecise) {
      await runSampling({
        mode: 'precise',
        delaysMs: preciseDelaysMs,
        overwriteModelsOnNoUsage: false
      });
    }
  };

  const prev = inflight.get(refreshToken) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(run)
    .catch((error) => {
      logger.warn(`额度用量刷新失败(${String(requestedModel || '').slice(0, 40)}): ${error?.message || error}`);
    })
    .finally(() => {
      if (inflight.get(refreshToken) === next) inflight.delete(refreshToken);
    });

  inflight.set(refreshToken, next);
}
