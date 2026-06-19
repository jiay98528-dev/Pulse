/* ══════════════════════════════════════════════════
   PULSE — App Core
   实时数据看板 · WebSocket + Charts + UI
   ══════════════════════════════════════════════════ */

'use strict';

// ── Chart.js Global Defaults (Constructivist Theme) ──
Chart.defaults.color = '#B3B3B3';
Chart.defaults.borderColor = '#333333';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.plugins.legend.labels.padding = 12;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.elements.line.borderWidth = 3;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.point.hoverRadius = 6;
Chart.defaults.elements.point.hoverBorderWidth = 2;
Chart.defaults.elements.point.hoverBackgroundColor = '#CC0000';
Chart.defaults.elements.point.hoverBorderColor = '#FFFFFF';
Chart.defaults.animation.duration = 300;
Chart.defaults.animation.easing = 'easeOutQuart';
Chart.defaults.interaction.mode = 'index';
Chart.defaults.interaction.intersect = false;

// ── State ────────────────────────────────────────────
const state = {
    ws: null,
    connected: false,
    systemHistory: { cpu: [], mem: [], timestamps: [] },
    tokenHistory: [],
    costHistory: [],
    balanceHistory: [],
    maxHistoryPoints: 60,
    charts: {},
    pendingCsvFile: null,
    config: {},
};

// ── DOM Refs ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Utility ──────────────────────────────────────────
function formatNumber(n) {
    if (n === undefined || n === null || isNaN(n)) return '—';
    n = Number(n);
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return n.toLocaleString();
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
        if (bytes < 1024) return bytes.toFixed(1) + ' ' + unit;
        bytes /= 1024;
    }
    return bytes.toFixed(1) + ' PB';
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec) return '0 B/s';
    return formatBytes(bytesPerSec) + '/s';
}

function formatCurrency(val) {
    if (val === undefined || val === null) return '¥—';
    return '¥' + Number(val).toFixed(2);
}

function formatUptime(seconds) {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    let parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
}

function getWsUrl() {
    const loc = window.location;
    const port = loc.port || '8080';
    return `ws://${loc.hostname}:${port}/ws`;
}

// ── WebSocket ────────────────────────────────────────
function connectWs() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

    const url = getWsUrl();
    state.ws = new WebSocket(url);

    state.ws.onopen = () => {
        state.connected = true;
        $('#connStatus').className = 'conn-status connected';
        $('#connStatus').textContent = '●';
        $('#connText').textContent = '已连接';
        // Send initial ping
        state.ws.send(JSON.stringify({ action: 'ping' }));
    };

    state.ws.onclose = () => {
        state.connected = false;
        $('#connStatus').className = 'conn-status disconnected';
        $('#connStatus').textContent = '●';
        $('#connText').textContent = '断开';
        setTimeout(connectWs, 3000);
    };

    state.ws.onmessage = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            handleMessage(msg);
        } catch (e) {
            console.warn('[WS] Parse error:', e);
        }
    };

    state.ws.onerror = () => {
        state.ws.close();
    };
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'system':
            updateSystemData(msg.data);
            break;
        case 'deepseek':
            updateDeepseekData(msg.data);
            break;
        case 'pong':
            break;
    }
}

// ── Tab Switching ────────────────────────────────────
$$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        // Update button states
        $$('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Update content
        $$('.tab-content').forEach(c => c.classList.remove('active'));
        const target = $('#tab-' + tab);
        if (target) target.classList.add('active');
        // Resize charts when switching to a tab with charts
        setTimeout(() => {
            Object.values(state.charts).forEach(c => {
                if (c && c.resize) c.resize();
            });
        }, 100);
    });
});

// ── System Data Update ───────────────────────────────
function updateSystemData(data) {
    if (!data) return;

    // ─ Update Dashboard System Bar ─
    const cpu = data.cpu?.percent ?? 0;
    const mem = data.memory?.percent ?? 0;
    const disk = data.disk?.[0]?.percent ?? 0;
    const gpu = data.gpu?.[0] ? { name: data.gpu[0].name } : null;

    $('#sysCpuFill').style.width = cpu + '%';
    $('#sysCpuVal').textContent = cpu.toFixed(1) + '%';
    $('#sysMemFill').style.width = mem + '%';
    $('#sysMemVal').textContent = mem.toFixed(1) + '%';
    $('#sysDiskFill').style.width = disk + '%';
    $('#sysDiskVal').textContent = disk.toFixed(1) + '%';
    $('#sysGpuFill').style.width = '0%';
    $('#sysGpuVal').textContent = gpu ? 'Active' : '—';

    // Temperature
    const temps = data.temperature;
    let tempStr = '—';
    if (temps) {
        for (const key of Object.keys(temps)) {
            const entries = temps[key];
            if (entries && entries.length > 0) {
                const current = entries[0]?.current;
                if (current) {
                    tempStr = current.toFixed(0) + '°C';
                    break;
                }
            }
        }
    }
    $('#sysTemp').textContent = tempStr;

    // Network
    const netSpeed = data.network_speed;
    if (netSpeed) {
        const up = formatSpeed(netSpeed.sent_per_sec);
        const down = formatSpeed(netSpeed.recv_per_sec);
        $('#sysNet').textContent = '↓' + down + ' ↑' + up;
    }

    // Last update
    const ts = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    $('#sysLastUpdate').textContent = ts;
    $('#sysLastUpdate').closest('.sys-item').title = '最后更新: ' + ts;

    // ─ Update System Tab ─
    const host = data.host || {};
    $('#infoHostname').textContent = host.hostname || '—';
    $('#infoOS').textContent = (host.system || '') + ' ' + (host.release || '');
    $('#infoUptime').textContent = formatUptime(data.uptime);
    $('#infoProcesses').textContent = data.cpu?.count ? (data.cpu.count * 2 + '...') : '—';

    // ─ Store history for real-time charts ─
    const now = new Date().toLocaleTimeString();
    state.systemHistory.cpu.push(cpu);
    state.systemHistory.mem.push(mem);
    state.systemHistory.timestamps.push(now);

    if (state.systemHistory.cpu.length > state.maxHistoryPoints) {
        state.systemHistory.cpu.shift();
        state.systemHistory.mem.shift();
        state.systemHistory.timestamps.shift();
    }

    updateRealtimeCharts();
}

// ── Deepseek Data Update ─────────────────────────────
function updateDeepseekData(data) {
    if (!data) return;

    // Check if API is not configured
    if (data.needs_config) {
        $('#todayTokens').textContent = '未配置';
        $('#accountBalance').textContent = '—';
        $('#todayCost').textContent = '—';
        return;
    }

    // ── Balance ─
    const balance = data.balance;
    if (balance) {
        const bal = Number(balance.balance) || 0;
        const currency = balance.currency || 'CNY';
        $('#accountBalance').textContent = (currency === 'CNY' ? '¥' : '$') + bal.toFixed(2);
    }

    // ── Today Summary ─
    const today = data.today || {};
    const week = data.week || {};
    const month = data.month || {};

    const totalTokens = Number(today.total_tokens) || 0;
    const inputTokens = Number(today.input_tokens) || 0;
    const outputTokens = Number(today.output_tokens) || 0;
    const cachedTokens = Number(today.cached_tokens) || 0;
    const todayCost = Number(today.total_cost) || 0;
    const weekCost = Number(week.total_cost) || 0;
    const monthCost = Number(month.total_cost) || 0;

    $('#todayTokens').textContent = formatNumber(totalTokens);
    $('#todayInput').textContent = formatNumber(inputTokens);
    $('#todayOutput').textContent = formatNumber(outputTokens);
    $('#todayCached').textContent = formatNumber(cachedTokens);
    $('#todayCost').textContent = formatCurrency(todayCost);
    $('#monthCost').textContent = formatCurrency(monthCost);
    $('#weekCost').textContent = formatCurrency(weekCost);

    // Cache hit rate
    const cacheRate = totalTokens > 0 ? ((cachedTokens / totalTokens) * 100) : 0;
    $('#cacheRate').textContent = cacheRate.toFixed(1) + '%';

    // ── Token Trend ─
    let trendUp = true;
    // Compare with previous day (if we have history)
    if (state.tokenHistory.length > 1) {
        const prev = state.tokenHistory[state.tokenHistory.length - 2]?.total || 0;
        const curr = totalTokens;
        trendUp = curr >= prev;
    }
    const trendEl = $('#tokenTrend').querySelector('.trend-value');
    if (trendEl) {
        trendEl.textContent = trendUp ? '▲ +' : '▼ ';
        trendEl.className = 'trend-value' + (trendUp ? '' : ' down');
    }

    // ── Spending Limit ─
    const limits = data.limits || {};
    const dailyLimit = Number(limits.daily) || 0;
    const overDaily = data.over_limit_daily || false;

    if (dailyLimit > 0) {
        const pct = Math.min((todayCost / dailyLimit) * 100, 100);
        const fill = $('#costLimitFill');
        fill.style.width = pct + '%';
        fill.className = 'limit-bar-fill' + (overDaily ? ' danger' : (pct > 80 ? ' warning' : ''));
        $('#costLimitLabel').textContent = '限额 ¥' + dailyLimit.toFixed(2) + ' | ' + pct.toFixed(0) + '%';
    }

    // ── Over-limit Alert ─
    const alertBar = $('#limitAlert');
    const alertText = $('#limitAlertText');
    if (overDaily) {
        alertBar.classList.remove('hidden');
        alertText.textContent = '⚠ 消费超出每日限额！今日已用 ¥' + todayCost.toFixed(2) + ' / ¥' + dailyLimit.toFixed(2);
        // Pulse the cost card
        $('#costCard').style.borderColor = '#CC0000';
    } else {
        alertBar.classList.add('hidden');
        $('#costCard').style.borderColor = '';
    }

    // ── Model Breakdown ─
    const modelBreakdown = data.model_breakdown || [];
    const modelList = $('#modelList');
    if (modelBreakdown.length > 0) {
        $('#activeModels').textContent = modelBreakdown.length;
        modelList.innerHTML = modelBreakdown.slice(0, 3).map(m =>
            '<span>' + m.model + ': ' + formatNumber(m.total_tokens) + '</span>'
        ).join(' · ');
    } else {
        $('#activeModels').textContent = '0';
        modelList.textContent = '暂无数据';
    }

    // Update model breakdown chart
    updateDeepseekWithModelData(data);

    // ── Save History ─
    const history7d = data.history_7d || [];
    if (history7d.length > 0) {
        state.tokenHistory = history7d;
    }

    const costHist = data.balance_history || [];
    if (costHist.length > 0) {
        state.costHistory = costHist;
    }

    // Update charts
    updateDeepseekCharts();
}

// ── Chart Initialization ────────────────────────────
const chartColors = {
    red: '#CC0000',
    redDim: '#990000',
    redBright: '#FF1A1A',
    white: '#FFFFFF',
    grey: '#808080',
    greyLight: '#B3B3B3',
    grid: '#2A2A2A',
    green: '#2D8A2D',
    yellow: '#FFD700',
};

const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            display: false,
        },
        tooltip: {
            backgroundColor: '#1A1A1A',
            borderColor: '#FFFFFF',
            borderWidth: 1,
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
            padding: 12,
            cornerRadius: 0,
        },
    },
    scales: {
        x: {
            grid: { color: chartColors.grid, drawBorder: false },
            ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, color: chartColors.grey },
        },
        y: {
            grid: { color: chartColors.grid, drawBorder: false },
            ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, color: chartColors.grey },
            beginAtZero: true,
        },
    },
};

// ── Dashboard Charts ────────────────────────────────

// Token Trend Chart (7-day)
function initTokenTrendChart() {
    const ctx = document.getElementById('tokenTrendChart');
    if (!ctx) return null;

    state.charts.tokenTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '总 Token',
                data: [],
                borderColor: chartColors.red,
                backgroundColor: 'transparent',
                borderWidth: 3,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 6,
                fill: false,
            }, {
                label: '输入 Token',
                data: [],
                borderColor: chartColors.grey,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderDash: [4, 4],
                fill: false,
            }],
        },
        options: {
            ...chartDefaults,
            scales: {
                ...chartDefaults.scales,
                y: {
                    ...chartDefaults.scales.y,
                    ticks: {
                        ...chartDefaults.scales.y.ticks,
                        callback: (val) => formatNumber(val),
                    },
                },
            },
            plugins: {
                ...chartDefaults.plugins,
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: chartColors.grey,
                        font: { family: "'JetBrains Mono', monospace", size: 10 },
                        padding: 16,
                        usePointStyle: true,
                    },
                },
            },
        },
    });
    return state.charts.tokenTrend;
}

// Model Breakdown (Bar)
function initModelBreakdownChart() {
    const ctx = document.getElementById('modelBreakdownChart');
    if (!ctx) return null;

    state.charts.modelBreakdown = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Token',
                data: [],
                backgroundColor: chartColors.red,
                borderColor: chartColors.white,
                borderWidth: 1,
                borderRadius: 0,
                barThickness: 24,
            }],
        },
        options: {
            ...chartDefaults,
            indexAxis: 'y',
            plugins: {
                ...chartDefaults.plugins,
                legend: { display: false },
            },
            scales: {
                x: {
                    ...chartDefaults.scales.x,
                    ticks: {
                        ...chartDefaults.scales.x.ticks,
                        callback: (val) => formatNumber(val),
                    },
                },
                y: chartDefaults.scales.y,
            },
        },
    });
    return state.charts.modelBreakdown;
}

// Cache Rate (Doughnut)
function initCacheRateChart() {
    const ctx = document.getElementById('cacheRateChart');
    if (!ctx) return null;

    state.charts.cacheRate = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['缓存命中', '未命中'],
            datasets: [{
                data: [0, 100],
                backgroundColor: [chartColors.red, chartColors.grid],
                borderWidth: 0,
                borderRadius: 0,
            }],
        },
        options: {
            ...chartDefaults,
            cutout: '70%',
            plugins: {
                ...chartDefaults.plugins,
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: chartColors.grey,
                        font: { family: "'JetBrains Mono', monospace", size: 9 },
                        padding: 8,
                        usePointStyle: true,
                    },
                },
            },
        },
    });
    return state.charts.cacheRate;
}

// Cost Trend (Line)
function initCostTrendChart() {
    const ctx = document.getElementById('costTrendChart');
    if (!ctx) return null;

    state.charts.costTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '消费',
                data: [],
                borderColor: chartColors.yellow,
                backgroundColor: 'transparent',
                borderWidth: 3,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 6,
                fill: false,
            }],
        },
        options: {
            ...chartDefaults,
            scales: {
                ...chartDefaults.scales,
                y: {
                    ...chartDefaults.scales.y,
                    ticks: {
                        ...chartDefaults.scales.y.ticks,
                        callback: (val) => '¥' + Number(val).toFixed(2),
                    },
                },
            },
            plugins: {
                ...chartDefaults.plugins,
                legend: { display: false },
            },
        },
    });
    return state.charts.costTrend;
}

// ── System Tab Charts ───────────────────────────────

function initRealtimeCharts() {
    // CPU/Mem real-time chart
    const ctx = document.getElementById('sysCpuChart');
    if (!ctx) return;

    state.charts.sysCpu = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'CPU %',
                data: [],
                borderColor: chartColors.red,
                backgroundColor: 'transparent',
                borderWidth: 3,
                tension: 0,
                pointRadius: 0,
                fill: false,
            }, {
                label: '内存 %',
                data: [],
                borderColor: chartColors.white,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                borderDash: [3, 3],
                fill: false,
            }],
        },
        options: {
            ...chartDefaults,
            scales: {
                ...chartDefaults.scales,
                y: { ...chartDefaults.scales.y, min: 0, max: 100 },
            },
            plugins: {
                ...chartDefaults.plugins,
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: chartColors.grey,
                        font: { family: "'JetBrains Mono', monospace", size: 10 },
                        padding: 16,
                        usePointStyle: true,
                    },
                },
            },
        },
    });
}

function initSysGpuChart() {
    const ctx = document.getElementById('sysGpuChart');
    if (!ctx) return;

    state.charts.sysGpu = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['使用中', '空闲'],
            datasets: [{
                data: [0, 100],
                backgroundColor: [chartColors.red, chartColors.grid],
                borderWidth: 0,
            }],
        },
        options: {
            ...chartDefaults,
            cutout: '75%',
            plugins: {
                ...chartDefaults.plugins,
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: chartColors.grey,
                        font: { family: "'JetBrains Mono', monospace", size: 9 },
                        padding: 8,
                        usePointStyle: true,
                    },
                },
            },
        },
    });
}

function initSysDiskChart() {
    const ctx = document.getElementById('sysDiskChart');
    if (!ctx) return;

    state.charts.sysDisk = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: '使用率',
                data: [],
                backgroundColor: chartColors.red,
                borderColor: chartColors.white,
                borderWidth: 1,
                borderRadius: 0,
            }],
        },
        options: {
            ...chartDefaults,
            indexAxis: 'y',
            plugins: {
                ...chartDefaults.plugins,
                legend: { display: false },
            },
            scales: {
                x: { ...chartDefaults.scales.x, min: 0, max: 100 },
                y: chartDefaults.scales.y,
            },
        },
    });
}

// ── History Tab Charts ──────────────────────────────

function initHistoryTrendChart() {
    const ctx = document.getElementById('historyTrendChart');
    if (!ctx) return;

    state.charts.historyTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '总 Token',
                data: [],
                borderColor: chartColors.red,
                backgroundColor: 'transparent',
                borderWidth: 3,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 6,
                fill: false,
            }, {
                label: '消费 (¥)',
                data: [],
                borderColor: chartColors.yellow,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderDash: [4, 4],
                yAxisID: 'y1',
                fill: false,
            }],
        },
        options: {
            ...chartDefaults,
            scales: {
                x: chartDefaults.scales.x,
                y: {
                    ...chartDefaults.scales.y,
                    position: 'left',
                    ticks: {
                        ...chartDefaults.scales.y.ticks,
                        callback: (val) => formatNumber(val),
                    },
                },
                y1: {
                    position: 'right',
                    grid: { display: false },
                    ticks: {
                        font: { family: "'JetBrains Mono', monospace", size: 10 },
                        color: chartColors.yellow,
                        callback: (val) => '¥' + Number(val).toFixed(2),
                    },
                },
            },
            plugins: {
                ...chartDefaults.plugins,
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: chartColors.grey,
                        font: { family: "'JetBrains Mono', monospace", size: 10 },
                        padding: 16,
                        usePointStyle: true,
                    },
                },
            },
        },
    });
}

// ── Chart Updates ───────────────────────────────────

function updateDeepseekCharts() {
    // Token Trend Chart
    const trendChart = state.charts.tokenTrend;
    if (trendChart && state.tokenHistory.length > 0) {
        // Group by date
        const byDate = {};
        state.tokenHistory.forEach(r => {
            const d = r.timestamp ? r.timestamp.substring(0, 10) : '';
            if (!d) return;
            if (!byDate[d]) byDate[d] = { total: 0, input: 0 };
            byDate[d].total += Number(r.total_tokens) || 0;
            byDate[d].input += Number(r.input_tokens) || 0;
        });

        const dates = Object.keys(byDate).sort();
        trendChart.data.labels = dates.map(d => d.substring(5));
        trendChart.data.datasets[0].data = dates.map(d => byDate[d].total);
        trendChart.data.datasets[1].data = dates.map(d => byDate[d].input);
        trendChart.update('none');
    }

    // Model Breakdown
    // This gets updated from model_breakdown data - need latest state
    // Will be updated when deepseek data arrives with model info

    // Cache Rate Doughnut
    const cacheChart = state.charts.cacheRate;
    if (cacheChart) {
        const todayTotal = Number($('#todayTokens').textContent.replace(/[^0-9.]/g, '')) || 0;
        const cached = Number($('#todayCached').textContent.replace(/[^0-9.]/g, '')) || 0;
        const hit = Math.min(cached, todayTotal);
        const miss = Math.max(0, todayTotal - hit);
        cacheChart.data.datasets[0].data = todayTotal > 0 ? [hit, miss] : [0, 100];
        cacheChart.update('none');
    }

    // Cost Trend
    const costChart = state.charts.costTrend;
    if (costChart && state.tokenHistory.length > 0) {
        const byDate = {};
        state.tokenHistory.forEach(r => {
            const d = r.timestamp ? r.timestamp.substring(0, 10) : '';
            if (!d) return;
            if (!byDate[d]) byDate[d] = 0;
            byDate[d] += Number(r.cost) || 0;
        });
        const dates = Object.keys(byDate).sort();
        costChart.data.labels = dates.map(d => d.substring(5));
        costChart.data.datasets[0].data = dates.map(d => byDate[d]);
        costChart.update('none');
    }
}

function updateDeepseekWithModelData(data) {
    const modelChart = state.charts.modelBreakdown;
    if (!modelChart) return;

    const models = data.model_breakdown || [];
    if (models.length > 0) {
        modelChart.data.labels = models.map(m => m.model.substring(0, 16));
        modelChart.data.datasets[0].data = models.map(m => Number(m.total_tokens) || 0);
        modelChart.update('none');
    }
}

function updateRealtimeCharts() {
    // CPU/Mem real-time
    const chart = state.charts.sysCpu;
    if (chart) {
        chart.data.labels = state.systemHistory.timestamps;
        chart.data.datasets[0].data = state.systemHistory.cpu;
        chart.data.datasets[1].data = state.systemHistory.mem;
        chart.update('none');
    }

    // Disk
    const diskChart = state.charts.sysDisk;
    if (diskChart && state.lastDiskData) {
        diskChart.data.labels = state.lastDiskData.map(d => d.device || d.mountpoint);
        diskChart.data.datasets[0].data = state.lastDiskData.map(d => d.percent || 0);
        diskChart.update('none');
    }
}

// ── CSV Import ──────────────────────────────────────
const dropZone = $('#csvDropZone');
const fileInput = $('#csvFileInput');
const selectBtn = $('#csvSelectBtn');

if (dropZone) {
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) handleCsvFile(files[0]);
    });
}

if (selectBtn) {
    selectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) handleCsvFile(fileInput.files[0]);
    });
}

function handleCsvFile(file) {
    if (!file.name.endsWith('.csv')) {
        showCsvResult('仅支持 CSV 文件', 'error');
        return;
    }
    state.pendingCsvFile = file;
    showCsvResult('已选择: ' + file.name + ' (' + formatBytes(file.size) + ')', 'success');
    $('#csvPreview').classList.remove('hidden');
}

function showCsvResult(msg, type) {
    const el = $('#csvResult');
    if (el) {
        el.textContent = msg;
        el.style.color = type === 'error' ? '#CC0000' : '#2D8A2D';
    }
}

$('#csvImportBtn')?.addEventListener('click', async () => {
    if (!state.pendingCsvFile) return;

    const formData = new FormData();
    formData.append('file', state.pendingCsvFile);

    try {
        const resp = await fetch('/api/csv/import', {
            method: 'POST',
            body: formData,
        });
        const result = await resp.json();
        if (result.status === 'ok') {
            const msg = '✓ 成功导入 ' + result.imported + ' 条记录';
            if (result.columns_unmatched && result.columns_unmatched.length > 0) {
                msg += ' (未匹配列: ' + result.columns_unmatched.join(', ') + ')';
            }
            showCsvResult(msg, 'success');
            state.pendingCsvFile = null;
            // Refresh data
            setTimeout(() => location.reload(), 1500);
        } else {
            showCsvResult('✕ 导入失败', 'error');
        }
    } catch (e) {
        showCsvResult('✕ 上传错误: ' + e.message, 'error');
    }
});

// ── Settings ─────────────────────────────────────────

// Load config
async function loadConfig() {
    try {
        const resp = await fetch('/api/config');
        state.config = await resp.json();
        const cfg = state.config;

        if ($('#cfgApiKey')) $('#cfgApiKey').placeholder = cfg.deepseek_api_key ? '已配置: ' + cfg.deepseek_api_key.substring(0, 8) + '...' : 'sk-...';
        if ($('#cfgBaseUrl')) $('#cfgBaseUrl').value = cfg.deepseek_base_url || 'https://api.deepseek.com';
        if ($('#cfgDailyLimit')) $('#cfgDailyLimit').value = cfg.daily_spending_limit || 5;
        if ($('#cfgMonthlyLimit')) $('#cfgMonthlyLimit').value = cfg.monthly_spending_limit || 100;

        const wmi = cfg.wmi_remote || {};
        if ($('#cfgWmiHost')) $('#cfgWmiHost').value = wmi.host || '';
        if ($('#cfgWmiUser')) $('#cfgWmiUser').value = wmi.username || '';
    } catch (e) {
        console.warn('Failed to load config:', e);
    }
}

// Save Config
async function saveConfig(body, statusEl) {
    try {
        const resp = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const result = await resp.json();
        if (result.status === 'ok') {
            if (statusEl) {
                statusEl.textContent = '✓ 已保存';
                statusEl.className = 'form-status success';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
            loadConfig(); // Refresh
        } else {
            if (statusEl) {
                statusEl.textContent = '✕ 保存失败';
                statusEl.className = 'form-status error';
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = '✕ 错误: ' + e.message;
            statusEl.className = 'form-status error';
        }
    }
}

$('#saveApiConfig')?.addEventListener('click', () => {
    saveConfig({
        deepseek_api_key: $('#cfgApiKey').value,
        deepseek_base_url: $('#cfgBaseUrl').value,
    }, $('#apiConfigStatus'));
});

$('#saveLimitConfig')?.addEventListener('click', () => {
    saveConfig({
        daily_spending_limit: parseFloat($('#cfgDailyLimit').value) || 5,
        monthly_spending_limit: parseFloat($('#cfgMonthlyLimit').value) || 100,
    }, $('#limitConfigStatus'));
});

$('#saveWmiConfig')?.addEventListener('click', () => {
    saveConfig({
        wmi_remote: {
            host: $('#cfgWmiHost').value,
            username: $('#cfgWmiUser').value,
            password: $('#cfgWmiPass').value,
        }
    }, $('#wmiConfigStatus'));
});

// ── Alert Close ────────────────────────────────────
$('#limitAlertClose')?.addEventListener('click', () => {
    $('#limitAlert').classList.add('hidden');
});

// ── Init ────────────────────────────────────────────
function init() {
    // Load config
    loadConfig();

    // Initialize charts
    initTokenTrendChart();
    initModelBreakdownChart();
    initCacheRateChart();
    initCostTrendChart();
    initRealtimeCharts();
    initSysGpuChart();
    initSysDiskChart();
    initHistoryTrendChart();

    // Connect WebSocket
    connectWs();

    // Periodic ping
    setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ action: 'ping' }));
        }
    }, 30000);

    console.log('[Pulse] Initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
