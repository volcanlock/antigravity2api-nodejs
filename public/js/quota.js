// 额度管理：查看、刷新、缓存

let currentQuotaToken = null;

const quotaCache = {
    data: {},
    ttl: 5 * 60 * 1000,
    
    get(refreshToken) {
        const cached = this.data[refreshToken];
        if (!cached) return null;
        if (Date.now() - cached.timestamp > this.ttl) {
            delete this.data[refreshToken];
            return null;
        }
        return cached.data;
    },
    
    set(refreshToken, data) {
        this.data[refreshToken] = { data, timestamp: Date.now() };
    },
    
    clear(refreshToken) {
        if (refreshToken) {
            delete this.data[refreshToken];
        } else {
            this.data = {};
        }
    }
};

function normalizePercentRawText(raw) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (!s) return null;
    s = s.replace(/^0+(?=\d)/, '');
    if (s.startsWith('.')) s = `0${s}`;
    return s;
}

const QUOTA_GROUPS = [
    {
        key: 'claude',
        label: 'Claude',
        iconSrc: '/assets/icons/claude.svg',
        match: (modelId) => modelId.toLowerCase().includes('claude')
    },
    {
        key: 'banana',
        label: 'banana',
        iconSrc: '/assets/icons/banana.svg',
        match: (modelId) => modelId.toLowerCase().includes('gemini-3-pro-image')
    },
    {
        key: 'gemini',
        label: 'Gemini',
        iconSrc: '/assets/icons/gemini.svg',
        match: (modelId) => modelId.toLowerCase().includes('gemini') || modelId.toLowerCase().includes('publishers/google/')
    },
    {
        key: 'other',
        label: '其他',
        iconSrc: '',
        match: () => true
    }
];

const QUOTA_SUMMARY_KEYS = ['claude', 'gemini', 'banana'];

function getGroupIconHtml(group) {
    const src = group?.iconSrc || '';
    const alt = escapeHtml(group?.label || '');
    const safeSrc = escapeHtml(src);
    if (!safeSrc) return '';
    return `<img class="quota-icon-img" src="${safeSrc}" alt="${alt}" loading="lazy" decoding="async">`;
}

function clamp01(value) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return 0;
    return Math.min(1, Math.max(0, numberValue));
}

function toPercentage(fraction01) {
    return clamp01(fraction01) * 100;
}

function formatPercentage(fraction01) {
    return `${toPercentage(fraction01).toFixed(2)}%`;
}

function getBarColor(percentage) {
    if (percentage > 50) return '#10b981';
    if (percentage > 20) return '#f59e0b';
    return '#ef4444';
}

function groupModels(models) {
    const grouped = { claude: [], gemini: [], banana: [], other: [] };

    Object.entries(models || {}).forEach(([modelId, quota]) => {
        const groupKey = (QUOTA_GROUPS.find(g => g.match(modelId)) || QUOTA_GROUPS[QUOTA_GROUPS.length - 1]).key;
        if (!grouped[groupKey]) grouped[groupKey] = [];
        grouped[groupKey].push({ modelId, quota });
    });

    return grouped;
}

function summarizeGroup(items) {
    if (!items || items.length === 0) {
        return { percentage: 0, percentageText: '--', resetTime: '--' };
    }

    let minRemaining = 1;
    let earliestResetMs = null;
    let earliestResetText = null;

    items.forEach(({ quota }) => {
        const remaining = clamp01(quota?.remaining);
        if (remaining < minRemaining) minRemaining = remaining;

        const resetRaw = quota?.resetTimeRaw;
        const resetText = quota?.resetTime;

        if (resetRaw) {
            const ms = Date.parse(resetRaw);
            if (Number.isFinite(ms) && (earliestResetMs === null || ms < earliestResetMs)) {
                earliestResetMs = ms;
                earliestResetText = resetText || null;
            }
        } else if (!earliestResetText && resetText) {
            earliestResetText = resetText;
        }
    });

    return {
        percentage: toPercentage(minRemaining),
        percentageText: formatPercentage(minRemaining),
        resetTime: earliestResetText || '--'
    };
}

async function loadTokenQuotaSummary(refreshToken) {
    const cardId = refreshToken.substring(0, 8);
    const summaryEl = document.getElementById(`quota-summary-${cardId}`);
    if (!summaryEl) return;
    
    const cached = quotaCache.get(refreshToken);
    if (cached) {
        renderQuotaSummary(summaryEl, cached);
        return;
    }

    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}/quotas`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await response.json();
        
        if (data.success && data.data && data.data.models) {
            quotaCache.set(refreshToken, data.data);
            renderQuotaSummary(summaryEl, data.data);
        } else {
            const errMsg = escapeHtml(data.message || '未知错误');
            summaryEl.innerHTML = `<span class="quota-summary-error">📊 ${errMsg}</span>`;
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            console.error('加载额度摘要失败:', error);
            summaryEl.innerHTML = `<span class="quota-summary-error">📊 加载失败</span>`;
        }
    }
}

function renderQuotaSummary(summaryEl, quotaData) {
    const models = quotaData.models;
    const modelEntries = Object.entries(models || {});
    
    if (modelEntries.length === 0) {
        summaryEl.textContent = '📊 暂无额度';
        return;
    }
    
    const grouped = groupModels(models);
    const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));

    const formatTime = (ts) => {
        if (!ts) return '';
        try {
            return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    };

    const rowsHtml = QUOTA_SUMMARY_KEYS.map((groupKey) => {
        const group = groupByKey[groupKey];
        const summary = summarizeGroup(grouped[groupKey]);
        const barColor = summary.percentageText === '--' ? '#9ca3af' : getBarColor(summary.percentage);
        const safeResetTime = escapeHtml(summary.resetTime);
        const resetText = safeResetTime === '--' ? '--' : `重置: ${safeResetTime}`;
        const safeLabel = escapeHtml(group?.label || groupKey);

        const consumeEntry = quotaData?.usage?.groups?.[groupKey];
        const consumeRaw = normalizePercentRawText(consumeEntry?.consumedPercentRaw);
        const consumeText = consumeRaw ? `${consumeRaw}%` : '--';
        let consumeTitle = '每次调用消耗：暂无数据';
        if (consumeRaw) {
            const prevPctRaw = normalizePercentRawText(consumeEntry?.prevPercentRaw);
            const nextPctRaw = normalizePercentRawText(consumeEntry?.nextPercentRaw);
            const prevPct = prevPctRaw ? `${prevPctRaw}%` : null;
            const nextPct = nextPctRaw ? `${nextPctRaw}%` : null;
            const titleParts = [];
            if (prevPct && nextPct) titleParts.push(`${prevPct} → ${nextPct}`);
            titleParts.push(`每次调用消耗: ${consumeText}`);
            if (consumeEntry?.modelId) titleParts.push(consumeEntry.modelId);
            if (consumeEntry?.calledAt) titleParts.push(formatTime(consumeEntry.calledAt));
            consumeTitle = titleParts.join(' · ');
        }

        const title = `${group?.label || groupKey} - 重置: ${summary.resetTime}`;
        return `
            <div class="quota-summary-row" title="${escapeHtml(title)}">
                <span class="quota-summary-icon">${getGroupIconHtml(group)}</span>
                <span class="quota-summary-label">${safeLabel}</span>
                <span class="quota-summary-bar"><span style="width:${summary.percentage}%;background:${barColor}"></span></span>
                <span class="quota-summary-pct">${summary.percentageText}</span>
                <span class="quota-summary-reset">${resetText}</span>
                <span class="quota-summary-consume" title="${escapeHtml(consumeTitle)}">${escapeHtml(consumeText)}</span>
            </div>
        `;
    }).join('');

    summaryEl.innerHTML = `
        <div class="quota-summary-grid">
            ${rowsHtml}
        </div>
    `;
}

async function toggleQuotaExpand(cardId, refreshToken) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    const toggleEl = document.getElementById(`quota-toggle-${cardId}`);
    if (!detailEl || !toggleEl) return;
    
    const isHidden = detailEl.classList.contains('hidden');
    
    if (isHidden) {
        detailEl.classList.remove('hidden');
        detailEl.classList.remove('collapsing');
        toggleEl.classList.add('expanded');
        
        if (!detailEl.dataset.loaded) {
            detailEl.innerHTML = '<div class="quota-loading-small">加载中...</div>';
            await loadQuotaDetail(cardId, refreshToken);
            detailEl.dataset.loaded = 'true';
        }
    } else {
        // 添加收起动画
        detailEl.classList.add('collapsing');
        toggleEl.classList.remove('expanded');
        
        // 动画结束后隐藏
        setTimeout(() => {
            detailEl.classList.add('hidden');
            detailEl.classList.remove('collapsing');
        }, 200);
    }
}

async function loadQuotaDetail(cardId, refreshToken) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    if (!detailEl) return;
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}/quotas`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await response.json();
        
        if (data.success && data.data && data.data.models) {
            const models = data.data.models;
            const modelEntries = Object.entries(models);
            
            if (modelEntries.length === 0) {
                detailEl.innerHTML = '<div class="quota-empty-small">暂无额度信息</div>';
                return;
            }
            
            const grouped = groupModels(models);
            
            let html = '<div class="quota-detail-grid">';
            
            const renderGroup = (items, icon) => {
                if (items.length === 0) return '';
                let groupHtml = '';
                items.forEach(({ modelId, quota }) => {
                    const percentage = toPercentage(quota?.remaining);
                    const percentageText = formatPercentage(quota?.remaining);
                    const barColor = getBarColor(percentage);
                    const shortName = escapeHtml(modelId.replace('models/', '').replace('publishers/google/', '').split('/').pop());
                    const safeModelId = escapeHtml(modelId);
                    const safeResetTime = escapeHtml(quota.resetTime);
                    groupHtml += `
                        <div class="quota-detail-row" title="${safeModelId} - 重置: ${safeResetTime}">
                            <span class="quota-detail-icon">${icon}</span>
                            <span class="quota-detail-name">${shortName}</span>
                            <span class="quota-detail-bar"><span style="width:${percentage}%;background:${barColor}"></span></span>
                            <span class="quota-detail-pct">${percentageText}</span>
                        </div>
                    `;
                });
                return groupHtml;
            };
            
            const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));
            html += renderGroup(grouped.claude, getGroupIconHtml(groupByKey.claude));
            html += renderGroup(grouped.gemini, getGroupIconHtml(groupByKey.gemini));
            html += renderGroup(grouped.banana, getGroupIconHtml(groupByKey.banana));
            html += renderGroup(grouped.other, '');
            html += '</div>';
            html += `<button class="btn btn-info btn-xs quota-refresh-btn" onclick="refreshInlineQuota('${escapeJs(cardId)}', '${escapeJs(refreshToken)}')">🔄 刷新额度</button>`;
            
            detailEl.innerHTML = html;
        } else {
            const errMsg = escapeHtml(data.message || '未知错误');
            detailEl.innerHTML = `<div class="quota-error-small">加载失败: ${errMsg}</div>`;
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            detailEl.innerHTML = `<div class="quota-error-small">网络错误</div>`;
        }
    }
}

async function refreshInlineQuota(cardId, refreshToken) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    const summaryEl = document.getElementById(`quota-summary-${cardId}`);
    
    if (detailEl) detailEl.innerHTML = '<div class="quota-loading-small">刷新中...</div>';
    if (summaryEl) summaryEl.textContent = '📊 刷新中...';
    

    quotaCache.clear(refreshToken);
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}/quotas?refresh=true`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await response.json();
        if (data.success && data.data) {
            quotaCache.set(refreshToken, data.data);
        }
    } catch (e) {}
    
    await loadTokenQuotaSummary(refreshToken);
    await loadQuotaDetail(cardId, refreshToken);
}

async function showQuotaModal(refreshToken) {
    currentQuotaToken = refreshToken;
    
    const activeIndex = cachedTokens.findIndex(t => t.refresh_token === refreshToken);
    
    const emailTabs = cachedTokens.map((t, index) => {
        const email = t.email || '未知';
        const shortEmail = email.length > 20 ? email.substring(0, 17) + '...' : email;
        const isActive = index === activeIndex;
        const safeEmail = escapeHtml(email);
        const safeShortEmail = escapeHtml(shortEmail);
        return `<button type="button" class="quota-tab${isActive ? ' active' : ''}" data-index="${index}" onclick="switchQuotaAccountByIndex(${index})" title="${safeEmail}">${safeShortEmail}</button>`;
    }).join('');
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'quotaModal';
    modal.innerHTML = `
        <div class="modal-content modal-xl">
            <div class="quota-modal-header">
                <div class="modal-title">📊 模型额度</div>
                <div class="quota-update-time" id="quotaUpdateTime"></div>
            </div>
            <div class="quota-tabs" id="quotaEmailList">
                ${emailTabs}
            </div>
            <div id="quotaContent" class="quota-container">
                <div class="quota-loading">加载中...</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal').remove()">关闭</button>
                <button class="btn btn-secondary btn-sm" onclick="showQuotaUsageModal()">📈 统计</button>
                <button class="btn btn-info btn-sm" id="quotaRefreshBtn" onclick="refreshQuotaData()">🔄 刷新</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    await loadQuotaData(refreshToken);
    
    const tabsContainer = document.getElementById('quotaEmailList');
    if (tabsContainer) {
        tabsContainer.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY;
            }
        }, { passive: false });
    }
}

async function switchQuotaAccountByIndex(index) {
    if (index < 0 || index >= cachedTokens.length) return;
    
    const token = cachedTokens[index];
    currentQuotaToken = token.refresh_token;
    
    document.querySelectorAll('.quota-tab').forEach((tab, i) => {
        if (i === index) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    await loadQuotaData(token.refresh_token);
    if (document.getElementById('quotaUsageModal')) {
        await loadQuotaUsageDataAndRender(true);
    }
}

async function switchQuotaAccount(refreshToken) {
    const index = cachedTokens.findIndex(t => t.refresh_token === refreshToken);
    if (index >= 0) {
        await switchQuotaAccountByIndex(index);
    }
}

async function loadQuotaData(refreshToken, forceRefresh = false) {
    const quotaContent = document.getElementById('quotaContent');
    if (!quotaContent) return;
    
    const refreshBtn = document.getElementById('quotaRefreshBtn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 加载中...';
    }
    
    if (!forceRefresh) {
         const cached = quotaCache.get(refreshToken);
         if (cached) {
             renderQuotaModal(quotaContent, cached);
             if (refreshBtn) {
                 refreshBtn.disabled = false;
                 refreshBtn.textContent = '🔄 刷新';
             }
            return;
        }
     } else {
         quotaCache.clear(refreshToken);
     }

     
     quotaContent.innerHTML = '<div class="quota-loading">加载中...</div>';
    
    try {
        const url = `/admin/tokens/${encodeURIComponent(refreshToken)}/quotas${forceRefresh ? '?refresh=true' : ''}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
         if (data.success) {
             quotaCache.set(refreshToken, data.data);
             renderQuotaModal(quotaContent, data.data);
         } else {
             quotaContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(data.message)}</div>`;
         }
    } catch (error) {
        if (quotaContent) {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(error.message)}</div>`;
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 刷新';
        }
    }
}

async function refreshQuotaData() {
    if (currentQuotaToken) {
        await loadQuotaData(currentQuotaToken, true);
    }
}

function renderQuotaModal(quotaContent, quotaData) {
    const models = quotaData.models;
    
    const updateTimeEl = document.getElementById('quotaUpdateTime');
    if (updateTimeEl && quotaData.lastUpdated) {
        const lastUpdated = new Date(quotaData.lastUpdated).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        updateTimeEl.textContent = `更新于 ${lastUpdated}`;
    }
    
    if (Object.keys(models).length === 0) {
        quotaContent.innerHTML = '<div class="quota-empty">暂无额度信息</div>';
        return;
    }
    
    const grouped = groupModels(models);

    const formatTime = (ts) => {
        if (!ts) return '';
        try {
            return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    };
    
    let html = '';
    
    const renderGroup = (items, group) => {
        const summary = summarizeGroup(items);
        const safeLabel = escapeHtml(group.label);
        const safeResetTime = escapeHtml(summary.resetTime);
        const iconHtml = getGroupIconHtml(group);
        let groupHtml = `
            <div class="quota-group-title">
                <span class="quota-group-left">
                    <span class="quota-group-icon">${iconHtml}</span>
                    <span class="quota-group-label">${safeLabel}</span>
                </span>
                <span class="quota-group-meta">${escapeHtml(summary.percentageText)} · 重置: ${safeResetTime}</span>
            </div>
        `;

        if (items.length === 0) {
            groupHtml += '<div class="quota-empty-small">暂无</div>';
            return groupHtml;
        }

        groupHtml += '<div class="quota-grid">';
        items.forEach(({ modelId, quota }) => {
            const percentage = toPercentage(quota?.remaining);
            const percentageText = formatPercentage(quota?.remaining);
            const barColor = getBarColor(percentage);
            const shortName = escapeHtml(modelId.replace('models/', '').replace('publishers/google/', ''));
            const safeModelId = escapeHtml(modelId);
            const safeResetTime = escapeHtml(quota.resetTime);
            const consumeEntry = quotaData?.usage?.models?.[modelId];
            const consumeRaw = normalizePercentRawText(consumeEntry?.consumedPercentRaw);
            const consumeText = consumeRaw ? `${consumeRaw}%` : '--';
            let consumeTitle = '每次调用消耗：暂无数据';
            if (consumeRaw) {
                const prevPctRaw = normalizePercentRawText(consumeEntry?.prevPercentRaw);
                const nextPctRaw = normalizePercentRawText(consumeEntry?.nextPercentRaw);
                const prevPct = prevPctRaw ? `${prevPctRaw}%` : null;
                const nextPct = nextPctRaw ? `${nextPctRaw}%` : null;
                const titleParts = [];
                if (prevPct && nextPct) titleParts.push(`${prevPct} → ${nextPct}`);
                titleParts.push(`每次调用消耗: ${consumeText}`);
                if (consumeEntry?.calledAt) titleParts.push(formatTime(consumeEntry.calledAt));
                consumeTitle = titleParts.join(' · ');
            }
            groupHtml += `
                <div class="quota-item">
                    <div class="quota-model-name" title="${safeModelId}">
                        <span class="quota-model-icon">${iconHtml}</span>
                        <span class="quota-model-text">${shortName}</span>
                    </div>
                    <div class="quota-bar-container">
                        <div class="quota-bar" style="width: ${percentage}%; background: ${barColor};"></div>
                    </div>
                    <div class="quota-info-row">
                        <span class="quota-reset">重置: ${safeResetTime}</span>
                        <span class="quota-consume" title="${escapeHtml(consumeTitle)}">${escapeHtml(consumeText)}</span>
                        <span class="quota-percentage">${percentageText}</span>
                    </div>
                </div>
            `;
        });
        groupHtml += '</div>';
        return groupHtml;
    };
    
    const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));
    html += renderGroup(grouped.claude, groupByKey.claude);
    html += renderGroup(grouped.gemini, groupByKey.gemini);
    html += renderGroup(grouped.banana, groupByKey.banana);
    if (grouped.other && grouped.other.length > 0) {
        html += renderGroup(grouped.other, groupByKey.other);
    }
    
    quotaContent.innerHTML = html;
}

// ==================== 用量统计（折线图） ====================

const quotaUsageState = {
    mode: 'default',
    windowMs: 5 * 60 * 60 * 1000,
    limit: 300,
    refreshToken: null,
    data: null,
    selectedModelId: null,
    loading: false,
    pollTimer: null
};

function formatTimeShort(ts) {
    if (!ts) return '--';
    try {
        return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
        return '--';
    }
}

function getShortModelName(modelId) {
    return String(modelId || '').replace('models/', '').replace('publishers/google/', '');
}

function buildSparklineSvg(points, width = 86, height = 26, stroke = 'rgba(239, 68, 68, 0.95)') {
    const nums = (points || [])
        .map(p => Number(normalizePercentRawText(p?.v)))
        .filter(n => Number.isFinite(n));
    if (nums.length < 2) {
        return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
    }
    let min = Math.min(...nums);
    let max = Math.max(...nums);
    if (min === max) max = min + 1;
    const pad = 2;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const stepX = w / (nums.length - 1);
    const d = nums.map((v, i) => {
        const x = pad + i * stepX;
        const y = pad + (1 - (v - min) / (max - min)) * h;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
            <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
    `;
}

function buildLineChartSvg(points, width = 620, height = 220) {
    const pts = (points || [])
        .map(p => ({ t: Number(p?.t), v: Number(normalizePercentRawText(p?.v)) }))
        .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
    if (pts.length < 2) return '<div class="quota-usage-empty">暂无数据</div>';

    let minV = Math.min(...pts.map(p => p.v));
    let maxV = Math.max(...pts.map(p => p.v));
    if (minV === maxV) maxV = minV + 1;
    const minT = Math.min(...pts.map(p => p.t));
    const maxT = Math.max(...pts.map(p => p.t));
    const pad = 16;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const scaleX = (t) => (maxT === minT) ? pad : pad + ((t - minT) / (maxT - minT)) * w;
    const scaleY = (v) => pad + (1 - (v - minV) / (maxV - minV)) * h;

    const d = pts.map((p, i) => {
        const x = scaleX(p.t);
        const y = scaleY(p.v);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');

    return `
        <svg class="quota-usage-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="额度消耗折线图">
            <path d="${d}" fill="none" stroke="rgba(239, 68, 68, 0.95)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
    `;
}

function getQuotaUsageSubtitle(refreshToken) {
    const t = (cachedTokens || []).find(x => x.refresh_token === refreshToken);
    const email = t?.email || '未知';
    const short = email.length > 28 ? `${email.slice(0, 25)}...` : email;
    return short;
}

async function fetchQuotaUsage(refreshToken, { mode, windowMs, limit }) {
    const response = await authFetch('/admin/quota-usage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refreshToken, mode, windowMs, limit })
    });

    const raw = await response.text();
    let parsed = null;
    try {
        parsed = raw ? JSON.parse(raw) : null;
    } catch {
        parsed = null;
    }

    if (!response.ok) {
        const msg = parsed?.message || `HTTP ${response.status}`;
        if (response.status === 404) {
            throw new Error(`${msg}（后端未更新/未重启？）`);
        }
        throw new Error(msg);
    }
    if (!parsed?.success) throw new Error(parsed?.message || '加载失败');
    return parsed.data;
}

function renderQuotaUsageModal() {
    const listEl = document.getElementById('quotaUsageList');
    const detailEl = document.getElementById('quotaUsageDetail');
    const subtitleEl = document.getElementById('quotaUsageSubtitle');
    if (subtitleEl && quotaUsageState.refreshToken) {
        subtitleEl.textContent = getQuotaUsageSubtitle(quotaUsageState.refreshToken);
    }
    if (!listEl || !detailEl) return;

    const data = quotaUsageState.data;
    const models = data?.models || {};
    const modelIds = Object.keys(models);
    if (modelIds.length === 0) {
        listEl.innerHTML = '<div class="quota-usage-empty">暂无记录</div>';
        detailEl.innerHTML = '<div class="quota-usage-empty">暂无记录</div>';
        return;
    }

    const sortedIds = modelIds.sort((a, b) => getShortModelName(a).localeCompare(getShortModelName(b)));
    if (!quotaUsageState.selectedModelId || !models[quotaUsageState.selectedModelId]) {
        quotaUsageState.selectedModelId = sortedIds[0];
    }

    const listHtml = sortedIds.map((modelId) => {
        const m = models[modelId];
        const stats = m?.stats || {};
        const lastText = stats.lastRaw ? `${stats.lastRaw}%` : '--';
        const medianText = stats.medianRaw ? `${stats.medianRaw}%` : '--';
        const callsLeft = (stats.callsLeft === null || stats.callsLeft === undefined) ? '--' : String(stats.callsLeft);
        const spark = buildSparklineSvg(m?.points || []);
        const active = modelId === quotaUsageState.selectedModelId ? ' active' : '';
        return `
            <button type="button" class="quota-usage-item${active}" onclick="selectQuotaUsageModel('${escapeJs(modelId)}')">
                <div class="quota-usage-item-top">
                    <span class="quota-usage-item-name" title="${escapeHtml(modelId)}">${escapeHtml(getShortModelName(modelId))}</span>
                    <span class="quota-usage-item-last">${escapeHtml(lastText)}</span>
                </div>
                <div class="quota-usage-item-bottom">
                    <span class="quota-usage-item-meta">中位 ${escapeHtml(medianText)} · 余≈${escapeHtml(callsLeft)}次</span>
                    <span class="quota-usage-item-spark">${spark}</span>
                </div>
            </button>
        `;
    }).join('');

    listEl.innerHTML = listHtml;

    const selected = models[quotaUsageState.selectedModelId];
    const sStats = selected?.stats || {};
    const remaining = selected?.remainingPercentRaw ? `${selected.remainingPercentRaw}%` : '--';
    const detailHeader = `
        <div class="quota-usage-detail-header">
            <div class="quota-usage-detail-title">${escapeHtml(getShortModelName(quotaUsageState.selectedModelId))}</div>
            <div class="quota-usage-detail-meta">剩余 ${escapeHtml(remaining)} · 中位 ${escapeHtml(sStats.medianRaw ? `${sStats.medianRaw}%` : '--')}</div>
        </div>
    `;
    const chartHtml = buildLineChartSvg(selected?.points || []);

    const rows = (selected?.points || []).slice(-20).reverse().map(p => {
        const v = p?.v ? `${p.v}%` : '--';
        const tt = Number.isFinite(Number(p?.tt)) ? `${p.tt} tok` : '--';
        const pt = Number.isFinite(Number(p?.pt)) ? p.pt : null;
        const ct = Number.isFinite(Number(p?.ct)) ? p.ct : null;
        const tokenDetail = (pt !== null || ct !== null) ? `(${pt ?? '--'}/${ct ?? '--'})` : '';
        return `
            <div class="quota-usage-row">
                <span class="quota-usage-cell time">${escapeHtml(formatTimeShort(p?.t))}</span>
                <span class="quota-usage-cell v">${escapeHtml(v)}</span>
                <span class="quota-usage-cell tok" title="total_tokens (prompt/completion)">${escapeHtml(`${tt} ${tokenDetail}`.trim())}</span>
            </div>
        `;
    }).join('');

    detailEl.innerHTML = `
        ${detailHeader}
        <div class="quota-usage-chart-wrap">${chartHtml}</div>
        <div class="quota-usage-stats">
            <span>记录 ${escapeHtml(String(sStats.count ?? 0))}</span>
            <span>最小 ${escapeHtml(sStats.minRaw ? `${sStats.minRaw}%` : '--')}</span>
            <span>最大 ${escapeHtml(sStats.maxRaw ? `${sStats.maxRaw}%` : '--')}</span>
            <span>估算剩余次数 ${escapeHtml(sStats.callsLeft === null || sStats.callsLeft === undefined ? '--' : `≈${sStats.callsLeft} 次`)}</span>
        </div>
        <div class="quota-usage-table">
            <div class="quota-usage-table-head">
                <span class="quota-usage-cell time">时间</span>
                <span class="quota-usage-cell v">消耗</span>
                <span class="quota-usage-cell tok">Token</span>
            </div>
            ${rows || '<div class="quota-usage-empty">暂无明细</div>'}
        </div>
    `;
}

async function loadQuotaUsageDataAndRender(force = false) {
    const modal = document.getElementById('quotaUsageModal');
    if (!modal) return;

    if (quotaUsageState.loading) return;
    quotaUsageState.loading = true;

    const btn = document.getElementById('quotaUsageRefreshBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '? 加载中...';
    }

    try {
        const refreshToken = currentQuotaToken || quotaUsageState.refreshToken;
        if (!refreshToken) return;
        quotaUsageState.refreshToken = refreshToken;

        const modeSel = document.getElementById('quotaUsageMode');
        const winSel = document.getElementById('quotaUsageWindow');
        if (modeSel) quotaUsageState.mode = modeSel.value === 'precise' ? 'precise' : 'default';
        if (winSel) quotaUsageState.windowMs = Number(winSel.value) || quotaUsageState.windowMs;

        const data = await fetchQuotaUsage(refreshToken, {
            mode: quotaUsageState.mode,
            windowMs: quotaUsageState.windowMs,
            limit: quotaUsageState.limit
        });

        const preciseAvailable = Boolean(data?.availableModes?.precise);
        if (modeSel) {
            const opt = [...modeSel.options].find(o => o.value === 'precise');
            if (opt) opt.disabled = !preciseAvailable;
            if (!preciseAvailable && quotaUsageState.mode === 'precise') {
                quotaUsageState.mode = 'default';
                modeSel.value = 'default';
                quotaUsageState.data = await fetchQuotaUsage(refreshToken, {
                    mode: 'default',
                    windowMs: quotaUsageState.windowMs,
                    limit: quotaUsageState.limit
                });
            } else {
                quotaUsageState.data = data;
            }
        } else {
            quotaUsageState.data = data;
        }

        renderQuotaUsageModal();
    } catch (e) {
        const listEl = document.getElementById('quotaUsageList');
        const detailEl = document.getElementById('quotaUsageDetail');
        const msg = escapeHtml(e?.message || '加载失败');
        if (listEl) listEl.innerHTML = `<div class="quota-usage-empty">⚠ ${msg}</div>`;
        if (detailEl) detailEl.innerHTML = `<div class="quota-usage-empty">⚠ ${msg}</div>`;
    } finally {
        quotaUsageState.loading = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔄 刷新';
        }
    }
}

function selectQuotaUsageModel(modelId) {
    quotaUsageState.selectedModelId = modelId;
    renderQuotaUsageModal();
}

async function showQuotaUsageModal() {
    if (!currentQuotaToken) return;

    const existing = document.getElementById('quotaUsageModal');
    if (existing) existing.remove();

    if (quotaUsageState.pollTimer) {
        clearInterval(quotaUsageState.pollTimer);
        quotaUsageState.pollTimer = null;
    }

    quotaUsageState.refreshToken = currentQuotaToken;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'quotaUsageModal';
    modal.innerHTML = `
        <div class="modal-content modal-xl quota-usage-modal">
            <div class="quota-modal-header">
                <div class="modal-title">📈 用量统计</div>
                <div class="quota-update-time" id="quotaUsageSubtitle">${escapeHtml(getQuotaUsageSubtitle(currentQuotaToken))}</div>
            </div>
            <div class="quota-usage-controls">
                <div class="quota-usage-control">
                    <span class="quota-usage-label">模式</span>
                    <select id="quotaUsageMode" class="quota-usage-select">
                        <option value="default">默认</option>
                        <option value="precise">精确</option>
                    </select>
                </div>
                <div class="quota-usage-control">
                    <span class="quota-usage-label">窗口</span>
                    <select id="quotaUsageWindow" class="quota-usage-select">
                        <option value="${5 * 60 * 60 * 1000}">5小时</option>
                        <option value="${24 * 60 * 60 * 1000}">24小时</option>
                    </select>
                </div>
                <button class="btn btn-info btn-sm" id="quotaUsageRefreshBtn">🔄 刷新</button>
            </div>
            <div class="quota-usage-layout">
                <div class="quota-usage-list" id="quotaUsageList"></div>
                <div class="quota-usage-detail" id="quotaUsageDetail"></div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal').remove()">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    const modeSel = document.getElementById('quotaUsageMode');
    const winSel = document.getElementById('quotaUsageWindow');
    if (modeSel) modeSel.value = quotaUsageState.mode;
    if (winSel) winSel.value = String(quotaUsageState.windowMs);

    modeSel?.addEventListener('change', async () => {
        await loadQuotaUsageDataAndRender(true);
    });
    winSel?.addEventListener('change', async () => {
        await loadQuotaUsageDataAndRender(true);
    });
    document.getElementById('quotaUsageRefreshBtn')?.addEventListener('click', async () => {
        await loadQuotaUsageDataAndRender(true);
    });

    await loadQuotaUsageDataAndRender(true);

    // 轮询同步：避免“调用后延迟记录/需要刷新”导致看起来不更新
    quotaUsageState.pollTimer = setInterval(() => {
        if (!document.getElementById('quotaUsageModal')) {
            clearInterval(quotaUsageState.pollTimer);
            quotaUsageState.pollTimer = null;
            return;
        }
        if (!quotaUsageState.loading) {
            loadQuotaUsageDataAndRender(false);
        }
    }, 4000);
}
