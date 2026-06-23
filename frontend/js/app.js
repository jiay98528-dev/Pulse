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
    maxHistoryPoints: 180,
    charts: {},
    pendingCsvFile: null,
    pendingPairToken: null,
    lastLimitAlertKey: '',
    config: {},
    latestSystemData: null,
    latestDeepseekData: null,
    netHistory: { timestamps: [], recv: [], sent: [] },
    lastDiskData: null,
    lastCpuPerCore: null,
    lastMemData: null,
    lastGpuTemp: null,
    lastBatteryData: null,
    activeTab: 'dashboard',
    setupRequired: true,
    deepseekConfigured: false,
    tabReloadState: {},
};

const AI_PROVIDERS = {
    deepseek: {
        label: 'Deepseek',
        keyField: 'deepseek_api_key',
        baseField: 'deepseek_base_url',
        defaultBaseUrl: 'https://api.deepseek.com',
        keyPlaceholder: 'sk-...',
    },
    openai: {
        label: 'OpenAI',
        keyField: 'openai_api_key',
        baseField: 'openai_base_url',
        defaultBaseUrl: 'https://api.openai.com',
        keyPlaceholder: 'sk-...',
    },
    anthropic: {
        label: 'Anthropic',
        keyField: 'anthropic_api_key',
        baseField: 'anthropic_base_url',
        defaultBaseUrl: 'https://api.anthropic.com',
        keyPlaceholder: 'sk-ant-...',
    },
};

function getBackendBase() {
    const loc = window.location;
    const localHttp = (loc.protocol === 'http:' || loc.protocol === 'https:') &&
        (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost');
    return localHttp ? '' : 'http://127.0.0.1:8080';
}

function apiUrl(path) {
    return getBackendBase() + path;
}

// ── Widget Registry ──────────────────────────────────
var WidgetRegistry = {
    cpu:     { name: 'CPU',      icon: '⚙', sizes: ['S', 'M'],     defaultSize: 'S', source: 'system' },
    memory:  { name: '内存',      icon: '▦', sizes: ['S', 'M'],     defaultSize: 'S', source: 'system' },
    disk:    { name: '磁盘',      icon: '◈', sizes: ['S', 'M', 'L'], defaultSize: 'M', source: 'system' },
    network: { name: '网络',      icon: '⬡', sizes: ['M', 'L'],     defaultSize: 'M', source: 'system' },
    gpu:     { name: 'GPU',      icon: '◆', sizes: ['S', 'M'],     defaultSize: 'S', source: 'system' },
    balance: { name: '余额',      icon: '¥', sizes: ['S', 'M'],     defaultSize: 'S', source: 'deepseek' },
    tokens:  { name: 'Token',    icon: '⬒', sizes: ['S', 'M'],     defaultSize: 'S', source: 'deepseek' },
    cache:   { name: '缓存',      icon: '◎', sizes: ['S', 'M'],     defaultSize: 'S', source: 'deepseek' },
    uptime:  { name: '运行时间',   icon: '◷', sizes: ['S'],         defaultSize: 'S', source: 'system' },
};

// ── Widget Engine ────────────────────────────────────
var WidgetEngine = {
    widgetIdCounter: 0,
    activeWidgets: [],
    isEditing: false,
    layoutKey: 'pulse-ui-layout-v3',
    legacyLayoutKey: 'pulse-widget-layout',
    _widgetCharts: {},
    _dragHandlers: null,
    _cpuHistory: {},
    _netRecvHistory: {},
    _netSentHistory: {},
    _uptimeSecs: {},

    _ensureMiniChart: function(w, canvasId, config) {
        if (this._widgetCharts[w.id]) return this._widgetCharts[w.id];
        var ctx = document.getElementById(canvasId);
        if (!ctx) return null;
        var chart = new Chart(ctx, config);
        this._widgetCharts[w.id] = chart;
        return chart;
    },

    loadLayout: function() {
        var raw = localStorage.getItem(this.layoutKey);
        if (!raw) {
            var legacy = localStorage.getItem(this.legacyLayoutKey);
            if (legacy) {
                raw = legacy;
                localStorage.setItem(this.layoutKey, raw);
            }
        }
        if (raw) {
            try {
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    this.activeWidgets = parsed;
                    // Restore counter
                    var maxId = 0;
                    for (var i = 0; i < parsed.length; i++) {
                        var num = parseInt(parsed[i].id.replace('w', ''), 10);
                        if (num > maxId) maxId = num;
                    }
                    this.widgetIdCounter = maxId;
                    return;
                }
            } catch (e) { /* fall through to default */ }
        }
        this.activeWidgets = this.getDefaultLayout();
        this.widgetIdCounter = this.activeWidgets.length;
        this.saveLayout();
    },

    saveLayout: function() {
        localStorage.setItem(this.layoutKey, JSON.stringify(this.activeWidgets));
    },

    getDefaultLayout: function() {
        var id = 0;
        return [
            { id: 'w' + (++id), type: 'cpu',     size: 'S' },
            { id: 'w' + (++id), type: 'memory',  size: 'S' },
            { id: 'w' + (++id), type: 'disk',    size: 'M' },
            { id: 'w' + (++id), type: 'network', size: 'M' },
            { id: 'w' + (++id), type: 'balance', size: 'S' },
        ];
    },

    createWidgetElement: function(w) {
        var spec = WidgetRegistry[w.type];
        if (!spec) return null;

        var el = document.createElement('div');
        el.className = 'widget size-' + w.size;
        if (spec.source === 'deepseek' && !state.deepseekConfigured) {
            el.classList.add('widget-locked');
        }
        el.setAttribute('data-id', w.id);
        el.setAttribute('draggable', 'true');

        var title = spec.name;

        // Determine if this widget needs a mini chart canvas
        var needsChart = false;
        if (w.type === 'cpu' && w.size === 'S') needsChart = true;
        if (w.type === 'memory' && (w.size === 'S' || w.size === 'M')) needsChart = true;
        if (w.type === 'disk' && (w.size === 'M' || w.size === 'L')) needsChart = true;
        if (w.type === 'network' && w.size === 'M') needsChart = true;
        if (w.type === 'cache') needsChart = true;

        var chartHtml = needsChart
            ? '<canvas id="wchart-' + w.id + '" class="widget-chart" style="height:45%;"></canvas>'
            : '';

        el.innerHTML =
            '<div class="widget-card">' +
                '<div class="card-header">' + title + '</div>' +
                '<div class="widget-body">' +
                    '<div class="widget-value" id="wv-' + w.id + '">—</div>' +
                    '<div class="widget-unit" id="wu-' + w.id + '"></div>' +
                    chartHtml +
                '</div>' +
            '</div>' +
            '<div class="widget-edit-overlay">' +
                '<button class="widget-edit-btn widget-size-btn" title="切换尺寸">' + w.size + '</button>' +
                '<button class="widget-edit-btn widget-del-btn" title="删除">✕</button>' +
            '</div>';

        // Delete button
        var delBtn = el.querySelector('.widget-del-btn');
        var self = this;
        delBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            self.removeWidget(w.id);
        });

        // Size toggle button
        var sizeBtn = el.querySelector('.widget-size-btn');
        sizeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var sizes = spec.sizes;
            var idx = sizes.indexOf(w.size);
            var next = sizes[(idx + 1) % sizes.length];
            self.setSize(w.id, next);
        });

        // Drag events
        el.addEventListener('dragstart', function(e) {
            if (!self.isEditing) { e.preventDefault(); return; }
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', w.id);
        });

        el.addEventListener('dragend', function() {
            el.classList.remove('dragging');
            // Remove drag-over from all
            var grid = document.getElementById('widgetGrid');
            if (grid) {
                var children = grid.children;
                for (var i = 0; i < children.length; i++) {
                    children[i].classList.remove('drag-over');
                }
            }
        });

        return el;
    },

    renderAll: function() {
        var grid = document.getElementById('widgetGrid');
        if (!grid) return;

        // Destroy old mini chart instances
        var self = this;
        Object.values(this._widgetCharts).forEach(function(c) { if (c) c.destroy(); });
        this._widgetCharts = {};

        grid.innerHTML = '';

        for (var i = 0; i < this.activeWidgets.length; i++) {
            var w = this.activeWidgets[i];
            var el = this.createWidgetElement(w);
            if (!el) continue;

            if (this.isEditing) el.classList.add('editing');

            grid.appendChild(el);
        }

        this._initDragDrop(grid);
    },

    addWidget: function(type) {
        var spec = WidgetRegistry[type];
        if (!spec) return;
        var w = {
            id: 'w' + String(++this.widgetIdCounter),
            type: type,
            size: spec.defaultSize
        };
        this.activeWidgets.push(w);
        this.renderAll();
        this.saveLayout();
        this.updateLibrary();
    },

    removeWidget: function(id) {
        this.activeWidgets = this.activeWidgets.filter(function(w) { return w.id !== id; });
        this.renderAll();
        this.saveLayout();
        this.updateLibrary();
    },

    setSize: function(id, size) {
        for (var i = 0; i < this.activeWidgets.length; i++) {
            if (this.activeWidgets[i].id === id) {
                this.activeWidgets[i].size = size;
                break;
            }
        }
        this.renderAll();
        this.saveLayout();
    },

    enterEditMode: function() {
        this.isEditing = true;

        var actions = document.getElementById('widgetEditActions');
        if (actions) actions.classList.remove('hidden');
        var editBtn = document.getElementById('widgetEditBtn');
        if (editBtn) editBtn.classList.add('hidden');
        var lib = document.getElementById('widgetLibrary');
        if (lib) lib.classList.remove('hidden');

        // Add editing class to all widgets
        var grid = document.getElementById('widgetGrid');
        if (grid) {
            var children = grid.children;
            for (var i = 0; i < children.length; i++) {
                children[i].classList.add('editing');
            }
        }

        this.updateLibrary();
    },

    exitEditMode: function() {
        this.isEditing = false;

        var actions = document.getElementById('widgetEditActions');
        if (actions) actions.classList.add('hidden');
        var editBtn = document.getElementById('widgetEditBtn');
        if (editBtn) editBtn.classList.remove('hidden');
        var lib = document.getElementById('widgetLibrary');
        if (lib) lib.classList.add('hidden');

        // Remove editing class
        var grid = document.getElementById('widgetGrid');
        if (grid) {
            var children = grid.children;
            for (var i = 0; i < children.length; i++) {
                children[i].classList.remove('editing');
            }
        }
    },

    updateLibrary: function() {
        var libGrid = document.getElementById('widgetLibGrid');
        if (!libGrid) return;
        libGrid.innerHTML = '';

        var addedTypes = {};
        for (var i = 0; i < this.activeWidgets.length; i++) {
            addedTypes[this.activeWidgets[i].type] = true;
        }

        var types = Object.keys(WidgetRegistry);
        var self = this;
        for (var j = 0; j < types.length; j++) {
            var type = types[j];
            var spec = WidgetRegistry[type];
            var item = document.createElement('div');
            item.className = 'widget-lib-item';
            if (addedTypes[type]) item.classList.add('added');
            if (spec.source === 'deepseek' && !state.deepseekConfigured) item.classList.add('requires-config');

            var sizesStr = spec.sizes.join('/');
            var suffix = (spec.source === 'deepseek' && !state.deepseekConfigured) ? ' · 需要 API key' : '';

            item.innerHTML =
                '<span class="wli-icon">' + spec.icon + '</span>' +
                '<span class="wli-name">' + spec.name + ' (' + sizesStr + ')' + suffix + '</span>';

            if (!addedTypes[type]) {
                item.addEventListener('click', function(t) {
                    return function() { self.addWidget(t); };
                }(type));
            }

            libGrid.appendChild(item);
        }
    },

    setVisibility: function(type, visible) {
        var found = false;
        for (var i = 0; i < this.activeWidgets.length; i++) {
            if (this.activeWidgets[i].type === type) {
                found = true;
                break;
            }
        }
        if (visible && !found) {
            this.addWidget(type);
        } else if (!visible && found) {
            this.activeWidgets = this.activeWidgets.filter(function(w) { return w.type !== type; });
            this.renderAll();
            this.saveLayout();
            this.updateLibrary();
        }
    },

    updateAll: function(source, data) {
        var changed = false;
        for (var i = 0; i < this.activeWidgets.length; i++) {
            var w = this.activeWidgets[i];
            var spec = WidgetRegistry[w.type];
            if (spec && spec.source === source) {
                this._updateWidgetContent(w, data);
                changed = true;
            }
        }
    },

    _updateWidgetContent: function(w, data) {
        var valEl = document.getElementById('wv-' + w.id);
        var unitEl = document.getElementById('wu-' + w.id);
        if (!valEl) return;

        switch (w.type) {
            case 'cpu':
                var cpu = data.cpu ? data.cpu.percent : null;
                valEl.textContent = cpu !== null ? cpu.toFixed(1) : '—';
                if (unitEl) unitEl.textContent = '%';

                // Mini sparkline for S-size
                if (w.size === 'S' && cpu !== null) {
                    if (!this._cpuHistory[w.id]) this._cpuHistory[w.id] = [];
                    var hist = this._cpuHistory[w.id];
                    hist.push(cpu);
                    if (hist.length > 60) hist.shift();

                    var chart = this._ensureMiniChart(w, 'wchart-' + w.id, {
                        type: 'line',
                        data: {
                            labels: hist.map(function() { return ''; }),
                            datasets: [{
                                data: hist.slice(),
                                borderColor: chartColors.red,
                                backgroundColor: 'transparent',
                                borderWidth: 1.5,
                                tension: 0.1,
                                pointRadius: 0,
                                fill: false,
                            }]
                        },
                        options: {
                            animation: false,
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false },
                                tooltip: { enabled: false },
                            },
                            scales: {
                                x: { display: false },
                                y: { display: false, min: 0, max: 100 },
                            },
                        },
                    });
                    if (chart) {
                        chart.data.labels = hist.map(function() { return ''; });
                        chart.data.datasets[0].data = hist.slice();
                        chart.update('none');
                    }
                }
                break;

            case 'memory':
                var mem = data.memory;
                if (mem) {
                    valEl.textContent = mem.percent.toFixed(1);
                    if (unitEl) unitEl.textContent = '%';
                }

                // Mini doughnut for S/M-size
                if ((w.size === 'S' || w.size === 'M') && mem) {
                    var used = mem.used || 0;
                    var avail = mem.available || 0;
                    var chart = this._ensureMiniChart(w, 'wchart-' + w.id, {
                        type: 'doughnut',
                        data: {
                            labels: ['已用', '可用'],
                            datasets: [{
                                data: [used, avail],
                                backgroundColor: [chartColors.red, chartColors.grid],
                                borderWidth: 0,
                            }]
                        },
                        options: {
                            animation: false,
                            responsive: true,
                            maintainAspectRatio: false,
                            cutout: '70%',
                            plugins: {
                                legend: { display: false },
                                tooltip: { enabled: false },
                            },
                        },
                    });
                    if (chart) {
                        chart.data.datasets[0].data = [used, avail];
                        chart.update('none');
                    }
                }
                break;

            case 'disk':
                var disk0 = data.disk && data.disk[0];
                if (disk0) {
                    valEl.textContent = disk0.percent.toFixed(1);
                    if (unitEl) unitEl.textContent = '% (' + (disk0.device || disk0.mountpoint || '') + ')';
                }

                // Mini horizontal bar for M/L-size
                if ((w.size === 'M' || w.size === 'L') && data.disk && data.disk.length > 0) {
                    var partitions = data.disk;
                    var labels = partitions.map(function(d) { return (d.device || d.mountpoint || '?').substring(0, 12); });
                    var values = partitions.map(function(d) { return d.percent || 0; });

                    var chart = this._ensureMiniChart(w, 'wchart-' + w.id, {
                        type: 'bar',
                        data: {
                            labels: labels,
                            datasets: [{
                                data: values,
                                backgroundColor: chartColors.red,
                                borderColor: '#FFFFFF',
                                borderWidth: 1,
                                borderRadius: 0,
                                barThickness: 10,
                            }]
                        },
                        options: {
                            animation: false,
                            responsive: true,
                            maintainAspectRatio: false,
                            indexAxis: 'y',
                            plugins: {
                                legend: { display: false },
                                tooltip: { enabled: false },
                            },
                            scales: {
                                x: { display: false, min: 0, max: 100 },
                                y: {
                                    display: true,
                                    grid: { display: false },
                                    ticks: {
                                        font: { family: "'JetBrains Mono', monospace", size: 8 },
                                        color: chartColors.grey,
                                    },
                                },
                            },
                        },
                    });
                    if (chart) {
                        chart.data.labels = labels;
                        chart.data.datasets[0].data = values;
                        chart.update('none');
                    }
                }
                break;

            case 'network':
                var ns = data.network_speed;
                if (ns) {
                    valEl.textContent = '↓' + formatSpeed(ns.recv_per_sec);
                    if (unitEl) unitEl.textContent = '↑' + formatSpeed(ns.sent_per_sec);
                }

                // Dual-line sparkline for M-size
                if (w.size === 'M' && ns) {
                    if (!this._netRecvHistory[w.id]) this._netRecvHistory[w.id] = [];
                    if (!this._netSentHistory[w.id]) this._netSentHistory[w.id] = [];
                    this._netRecvHistory[w.id].push(ns.recv_per_sec);
                    this._netSentHistory[w.id].push(ns.sent_per_sec);
                    if (this._netRecvHistory[w.id].length > 30) this._netRecvHistory[w.id].shift();
                    if (this._netSentHistory[w.id].length > 30) this._netSentHistory[w.id].shift();

                    var recvHist = this._netRecvHistory[w.id];
                    var sentHist = this._netSentHistory[w.id];

                    var chart = this._ensureMiniChart(w, 'wchart-' + w.id, {
                        type: 'line',
                        data: {
                            labels: recvHist.map(function() { return ''; }),
                            datasets: [{
                                label: '↓ 接收',
                                data: recvHist.slice(),
                                borderColor: chartColors.red,
                                backgroundColor: 'transparent',
                                borderWidth: 1.5,
                                tension: 0.1,
                                pointRadius: 0,
                                fill: false,
                            }, {
                                label: '↑ 发送',
                                data: sentHist.slice(),
                                borderColor: chartColors.grey,
                                backgroundColor: 'transparent',
                                borderWidth: 1.5,
                                tension: 0.1,
                                pointRadius: 0,
                                fill: false,
                            }]
                        },
                        options: {
                            animation: false,
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false },
                                tooltip: { enabled: false },
                            },
                            scales: {
                                x: { display: false },
                                y: { display: false },
                            },
                        },
                    });
                    if (chart) {
                        chart.data.labels = recvHist.map(function() { return ''; });
                        chart.data.datasets[0].data = recvHist.slice();
                        chart.data.datasets[1].data = sentHist.slice();
                        chart.update('none');
                    }
                }
                break;

            case 'gpu':
                var temp = null;
                var temps = data.temperature;
                if (temps) {
                    var tempKeys = Object.keys(temps);
                    for (var t = 0; t < tempKeys.length; t++) {
                        var entries = temps[tempKeys[t]];
                        if (entries && entries.length > 0 && entries[0].current) {
                            temp = entries[0].current;
                            break;
                        }
                    }
                }
                var gpuName = (data.gpu && data.gpu[0]) ? data.gpu[0].name : null;
                if (temp !== null) {
                    valEl.textContent = temp.toFixed(0) + '°C';
                    // Temperature-based color classes
                    valEl.className = 'widget-value';
                    if (temp > 80) {
                        valEl.classList.add('text-hot');
                        valEl.style.color = chartColors.red;
                    } else if (temp > 60) {
                        valEl.classList.add('text-warm');
                        valEl.style.color = chartColors.yellow;
                    } else {
                        valEl.classList.add('text-cool');
                        valEl.style.color = chartColors.green;
                    }
                } else {
                    valEl.textContent = gpuName ? 'Active' : '—';
                    valEl.className = 'widget-value';
                    valEl.style.color = '';
                }
                if (unitEl) unitEl.textContent = gpuName ? gpuName.substring(0, 12) : '';
                break;

            case 'balance':
                if (!state.deepseekConfigured || data.needs_config) {
                    valEl.textContent = '未配置';
                    if (unitEl) unitEl.textContent = '需要 API key';
                    valEl.classList.add('widget-value-muted');
                    break;
                }
                var bal = data.balance;
                if (bal) {
                    valEl.classList.remove('widget-value-muted');
                    var balVal = bal.total_balance || bal.balance || 0;
                    valEl.textContent = formatCurrency(Number(balVal));
                    if (unitEl) unitEl.textContent = bal.currency || 'CNY';
                }
                break;

            case 'tokens':
                if (!state.deepseekConfigured || data.needs_config) {
                    valEl.textContent = '锁定';
                    if (unitEl) unitEl.textContent = '需要 API key';
                    valEl.classList.add('widget-value-muted');
                    break;
                }
                valEl.classList.remove('widget-value-muted');
                valEl.textContent = formatNumber(Number(data.total_tokens) || 0);
                if (unitEl) unitEl.textContent = 'tokens';
                break;

            case 'cache':
                if (!state.deepseekConfigured || data.needs_config) {
                    valEl.textContent = '锁定';
                    if (unitEl) unitEl.textContent = '需要 API key';
                    valEl.classList.add('widget-value-muted');
                    break;
                }
                valEl.classList.remove('widget-value-muted');
                var total = Number(data.total_tokens) || 0;
                var cached = Number(data.cached_tokens) || 0;
                var rate = total > 0 ? (cached / total * 100).toFixed(1) : '0.0';
                valEl.textContent = rate + '%';
                if (unitEl) unitEl.textContent = 'cache hit';
                var chart = this._ensureMiniChart(w, 'wchart-' + w.id, {
                    type: 'doughnut',
                    data: {
                        labels: ['cache', 'miss'],
                        datasets: [{
                            data: total > 0 ? [cached, Math.max(0, total - cached)] : [0, 100],
                            backgroundColor: [chartColors.red, chartColors.grid],
                            borderWidth: 0,
                        }]
                    },
                    options: {
                        animation: false,
                        responsive: true,
                        maintainAspectRatio: false,
                        cutout: '72%',
                        plugins: {
                            legend: { display: false },
                            tooltip: { enabled: false },
                        },
                    },
                });
                if (chart) {
                    chart.data.datasets[0].data = total > 0 ? [cached, Math.max(0, total - cached)] : [0, 100];
                    chart.update('none');
                }
                break;

            case 'uptime':
                // Sync base from system data if available
                if (data.uptime !== undefined && data.uptime !== null) {
                    this._uptimeSecs[w.id] = data.uptime;
                }
                // Use own ticker value
                var secs = this._uptimeSecs[w.id] || 0;
                valEl.textContent = formatUptime(secs);
                if (unitEl) unitEl.textContent = '';
                break;
        }
    },


    _initDragDrop: function(grid) {
        var self = this;
        if (!this._dragHandlers) {
            this._dragHandlers = {
                dragover: function(e) {
                    if (!self.isEditing) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                },
                drop: function(e) {
                    if (!self.isEditing) return;
                    e.preventDefault();
                    var fromId = e.dataTransfer.getData('text/plain');
                    if (!fromId) return;

                    var target = e.target;
                    // Walk up to find the widget element
                    while (target && target !== grid) {
                        if (target.classList.contains('widget')) break;
                        target = target.parentElement;
                    }
                    if (!target || target === grid) return;

                    var toId = target.getAttribute('data-id');
                    if (!toId || fromId === toId) return;

                    // Find indices and reorder
                    var fromIdx = -1, toIdx = -1;
                    for (var i = 0; i < self.activeWidgets.length; i++) {
                        if (self.activeWidgets[i].id === fromId) fromIdx = i;
                        if (self.activeWidgets[i].id === toId) toIdx = i;
                    }
                    if (fromIdx < 0 || toIdx < 0) return;

                    var item = self.activeWidgets.splice(fromIdx, 1)[0];
                    self.activeWidgets.splice(toIdx, 0, item);
                    self.renderAll();
                    self.saveLayout();
                }
            };
        }

        grid.removeEventListener('dragover', this._dragHandlers.dragover);
        grid.removeEventListener('drop', this._dragHandlers.drop);
        grid.addEventListener('dragover', this._dragHandlers.dragover);
        grid.addEventListener('drop', this._dragHandlers.drop);
    },

    init: function() {
        var self = this;
        this.loadLayout();
        this.renderAll();

        // Toolbar buttons
        var editBtn = document.getElementById('widgetEditBtn');
        if (editBtn) {
            editBtn.addEventListener('click', function() { self.enterEditMode(); });
        }
        var doneBtn = document.getElementById('widgetDoneBtn');
        if (doneBtn) {
            doneBtn.addEventListener('click', function() { self.exitEditMode(); });
        }

        // Uptime ticker — update all uptime widgets every second
        setInterval(function() {
            for (var i = 0; i < self.activeWidgets.length; i++) {
                var w = self.activeWidgets[i];
                if (w.type === 'uptime') {
                    if (self._uptimeSecs[w.id] !== undefined) {
                        self._uptimeSecs[w.id] = self._uptimeSecs[w.id] + 1;
                        var valEl = document.getElementById('wv-' + w.id);
                        if (valEl) {
                            valEl.textContent = formatUptime(self._uptimeSecs[w.id]);
                        }
                    }
                }
            }
        }, 1000);
    }
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
    const backend = getBackendBase();
    if (backend) return backend.replace(/^http/, 'ws') + '/ws';
    const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    const host = loc.host || '127.0.0.1:8080';
    return scheme + '://' + host + '/ws';
}

// ── Dashboard Telemetry Canvas Controller ────────────
var DashboardTelemetryController = {
    initialized: false,
    charts: {},
    history: {
        labels: [],
        cpu: [],
        mem: [],
        disk: [],
        net: [],
        aiTokens: [],
        aiCost: [],
        cacheRate: [],
        freshness: [],
    },

    init: function() {
        if (this.initialized) return;
        if (!window.TelemetryCanvas || !TelemetryCanvas.create) return;

        this.charts.heroAi = this._create('heroAiCanvas', 'costCache', { max: 100 });
        this.charts.heroSystem = this._create('heroSystemCanvas', 'radial', { min: 0, max: 100 });
        this.charts.heroFreshness = this._create('heroFreshnessCanvas', 'heatStrip', { min: 0, max: 100 });
        this.charts.systemStream = this._create('dashboardSystemStream', 'usageStream', { min: 0, max: 100 });
        this.charts.usageStream = this._create('dashboardUsageStream', 'usageStream', {});
        this.charts.heatStrip = this._create('dashboardHeatStrip', 'heatStrip', { min: 0, max: 100 });

        this.initialized = true;
        this.refresh();
    },

    _create: function(id, type, options) {
        var canvas = document.getElementById(id);
        if (!canvas) return null;
        return TelemetryCanvas.create(canvas, {
            type: type,
            labels: [],
            datasets: [],
            options: options || {},
        });
    },

    _push: function(key, value) {
        if (!this.history[key]) this.history[key] = [];
        var n = Number(value);
        this.history[key].push(Number.isFinite(n) ? n : 0);
        if (this.history[key].length > state.maxHistoryPoints) this.history[key].shift();
    },

    _pushLabel: function() {
        this.history.labels.push(new Date().toLocaleTimeString());
        if (this.history.labels.length > state.maxHistoryPoints) this.history.labels.shift();
    },

    updateSystem: function(data) {
        if (!data) return;
        this.init();

        var cpu = Number(data.cpu && data.cpu.percent) || 0;
        var mem = Number(data.memory && data.memory.percent) || 0;
        var disk = Number(data.disk && data.disk[0] && data.disk[0].percent) || 0;
        var net = data.network_speed
            ? Math.min(100, ((Number(data.network_speed.recv_per_sec) || 0) + (Number(data.network_speed.sent_per_sec) || 0)) / (1024 * 1024) * 8)
            : 0;
        var load = Math.max(cpu, mem, disk);

        this._pushLabel();
        this._push('cpu', cpu);
        this._push('mem', mem);
        this._push('disk', disk);
        this._push('net', net);
        this._push('freshness', 100);

        var loadEl = document.getElementById('heroSystemLoad');
        if (loadEl) loadEl.textContent = Math.round(load) + '%';
        var freshEl = document.getElementById('heroFreshness');
        if (freshEl) freshEl.textContent = 'LIVE';

        this.refresh();
    },

    updateDeepseek: function(data) {
        this.init();
        data = data || {};

        var totalTokens = Number(data.total_tokens || data.today_tokens || 0) || 0;
        var cost = Number(data.today_cost || data.month_cost || data.total_cost || 0) || 0;
        var cached = Number(data.cached_tokens || data.total_cached || 0) || 0;
        var cacheRate = totalTokens > 0 ? cached / totalTokens * 100 : 0;

        this._push('aiTokens', totalTokens);
        this._push('aiCost', cost);
        this._push('cacheRate', cacheRate);

        if (!state.deepseekConfigured || data.needs_config) {
            var balanceEl = document.getElementById('accountBalance');
            if (balanceEl) balanceEl.textContent = '未配置';
            var heroKpi = balanceEl ? balanceEl.closest('.hero-kpi') : null;
            var metaEl = heroKpi ? heroKpi.querySelector('.kpi-meta') : null;
            if (metaEl) metaEl.textContent = '需要配置 API key';
        }

        this.refresh();
    },

    refresh: function() {
        this.init();
        var labels = this.history.labels.length ? this.history.labels.slice() : [''];
        var cpu = this.history.cpu.length ? this.history.cpu.slice() : [0];
        var mem = this.history.mem.length ? this.history.mem.slice() : [0];
        var disk = this.history.disk.length ? this.history.disk.slice() : [0];
        var net = this.history.net.length ? this.history.net.slice() : [0];
        var tokens = this.history.aiTokens.length ? this.history.aiTokens.slice() : [0];
        var cost = this.history.aiCost.length ? this.history.aiCost.slice() : [0];
        var cache = this.history.cacheRate.length ? this.history.cacheRate.slice() : [0];
        var freshness = this.history.freshness.length ? this.history.freshness.slice() : [12, 24, 36];

        this._setData('heroAi', labels, [
            { label: 'Cost', data: cost, borderColor: chartColors.yellow },
            { label: 'Cache', data: cache, borderColor: chartColors.red },
        ], state.deepseekConfigured ? 'AI telemetry' : 'API key required');

        var currentLoad = Math.max(cpu[cpu.length - 1] || 0, mem[mem.length - 1] || 0, disk[disk.length - 1] || 0);
        this._setData('heroSystem', ['load'], [
            { label: 'Load', data: [currentLoad], borderColor: chartColors.green },
        ], 'System load');

        this._setData('heroFreshness', labels, [
            { label: 'Freshness', data: freshness, borderColor: chartColors.green },
        ], 'Data freshness');

        this._setData('systemStream', labels, [
            { label: 'CPU', data: cpu, borderColor: chartColors.red },
            { label: 'Memory', data: mem, borderColor: chartColors.green },
            { label: 'Disk', data: disk, borderColor: chartColors.yellow },
        ], 'System stream');

        this._setData('usageStream', labels, [
            { label: 'Tokens', data: tokens, borderColor: chartColors.red },
            { label: 'Cost', data: cost, borderColor: chartColors.yellow },
            { label: 'Cache', data: cache, borderColor: chartColors.green },
        ], state.deepseekConfigured ? 'AI usage' : 'API key required');

        this._setData('heatStrip', labels, [
            { label: 'Pressure', data: cpu.map(function(v, i) {
                return Math.max(v || 0, mem[i] || 0, disk[i] || 0, net[i] || 0);
            }), borderColor: chartColors.red },
        ], 'Pressure');
    },

    _setData: function(key, labels, datasets, label) {
        var chart = this.charts[key];
        if (!chart) return;
        chart.setData({ labels: labels, datasets: datasets });
        chart.setState({ label: label });
    },

    resize: function() {
        this.init();
        Object.values(this.charts).forEach(function(chart) {
            if (chart && chart.resize) chart.resize();
        });
        this.refresh();
    },
};

// ── WebSocket ────────────────────────────────────────
function connectWs() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

    const url = getWsUrl();
    state.ws = new WebSocket(url);

    state.ws.onopen = function() {
        state.connected = true;
        $('#connStatus').className = 'conn-status connected';
        $('#connStatus').textContent = '●';
        $('#connText').textContent = '已连接';
        hideConnectionLost();
        reconnectAttempts = 0;
        // Send initial ping
        state.ws.send(JSON.stringify({ action: 'ping' }));
    };

    state.ws.onclose = function(e) {
        showConnectionLost();
        reconnectAttempts++;
        var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(function() { connectWs(); }, delay);
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

function reloadPluginUI() {
    if (typeof loadDevices === 'function') loadDevices();
    if (typeof loadLanHardwareDevices === 'function') loadLanHardwareDevices();
    if (typeof loadPlugins === 'function') loadPlugins();
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'system':
            updateSystemData(msg.data);
            WidgetEngine.updateAll('system', msg.data);
            break;
        case 'deepseek':
            state.latestDeepseekData = msg.data || null;
            if (msg.data && msg.data.needs_config === true) {
                state.deepseekConfigured = false;
                updateSetupNotice(false);
            }
            updateDeepseekData(msg.data);
            WidgetEngine.updateAll('deepseek', msg.data);
            break;
        case 'pair_request':
            var pr = document.getElementById('pair-overlay');
            state.pendingPairToken = msg.token || null;
            var info = document.getElementById('pair-request-info');
            if (info && msg.from) {
                info.textContent = (msg.from.name || msg.from.ip || 'LAN device') + ' (' + (msg.from.ip || '-') + ') requests access';
            }
            if (pr) pr.classList.remove('hidden');
            break;
        case 'pair_success':
            showToast('配对成功', 'success');
            state.pendingPairToken = null;
            reloadPluginUI();
            break;
        case 'pair_rejected':
            showToast('配对被拒绝', 'error');
            state.pendingPairToken = null;
            break;
        case 'pong':
            break;
    }
}

// ── Tab Switching ────────────────────────────────────
const VALID_TABS = ['dashboard', 'hardware', 'analysis', 'settings', 'plugins'];

function normalizeTab(tab) {
    tab = String(tab || '').replace(/^#/, '').replace(/^tab-/, '').trim();
    return VALID_TABS.indexOf(tab) >= 0 ? tab : 'dashboard';
}

function getInitialTab() {
    var params = new URLSearchParams(window.location.search || '');
    var fromQuery = params.get('tab');
    if (fromQuery) return normalizeTab(fromQuery);
    var fromHash = window.location.hash || '';
    if (fromHash) return normalizeTab(fromHash);
    return 'dashboard';
}

function syncTabUrl(tab) {
    var url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    url.hash = '';
    window.history.replaceState({ tab: tab }, '', url.toString());
}

function resizeVisibleCharts() {
    Object.values(state.charts).forEach(function(c) {
        if (c && c.resize) c.resize();
        if (c && c.update) c.update('none');
    });
    if (WidgetEngine && WidgetEngine._widgetCharts) {
        Object.values(WidgetEngine._widgetCharts).forEach(function(c) {
            if (c && c.resize) c.resize();
            if (c && c.update) c.update('none');
        });
    }
    if (DashboardTelemetryController && DashboardTelemetryController.resize) {
        DashboardTelemetryController.resize();
    }
    if (window.TelemetryCanvas && TelemetryCanvas.refreshTheme) {
        TelemetryCanvas.refreshTheme();
    }
}

function refreshTabData(tab) {
    if (tab === 'dashboard') {
        if (state.latestSystemData) DashboardTelemetryController.updateSystem(state.latestSystemData);
        if (state.latestDeepseekData) DashboardTelemetryController.updateDeepseek(state.latestDeepseekData);
        WidgetEngine.updateAll('deepseek', state.latestDeepseekData || { needs_config: !state.deepseekConfigured });
    } else if (tab === 'hardware') {
        updateRealtimeCharts();
        setTimeout(function() {
            Promise.all([loadDevices(), loadLanHardwareDevices()]);
        }, 100);
    } else if (tab === 'analysis') {
        if (state.tokenHistory && state.tokenHistory.length && state.charts.historyTrend) {
            loadAnalysisData();
        } else {
            loadAnalysisData();
        }
    } else if (tab === 'plugins') {
        setTimeout(loadPlugins, 100);
    }
}

function activateTab(tab, options) {
    tab = normalizeTab(tab);
    options = options || {};
    state.activeTab = tab;

    $$('.tab-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    $$('.tab-content').forEach(function(content) {
        content.classList.toggle('active', content.id === 'tab-' + tab);
    });

    if (options.syncUrl) syncTabUrl(tab);
    refreshTabData(tab);
    setTimeout(resizeVisibleCharts, 80);
    setTimeout(resizeVisibleCharts, 220);
}

function initTabNavigation() {
    $$('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            activateTab(btn.dataset.tab, { syncUrl: true });
        });
    });
    window.addEventListener('popstate', function() {
        activateTab(getInitialTab(), { syncUrl: false });
    });
    window.addEventListener('hashchange', function() {
        activateTab(getInitialTab(), { syncUrl: false });
    });
    activateTab(getInitialTab(), { syncUrl: false });
}

// ── System Data Update ───────────────────────────────
function updateSystemData(data) {
    if (!data) return;
    state.latestSystemData = data;

    const cpu = data.cpu?.percent ?? 0;
    const mem = data.memory?.percent ?? 0;
    const disk = data.disk?.[0]?.percent ?? 0;
    const gpu = data.gpu?.[0] ? { name: data.gpu[0].name } : null;
    const temps = data.temperature;
    const netSpeed = data.network_speed;

    // ─ Update System Tab ─
    const host = data.host || {};
    $('#infoHostname').textContent = host.hostname || '—';
    $('#infoOS').textContent = (host.system || '') + ' ' + (host.release || '');
    $('#infoUptime').textContent = formatUptime(data.uptime);
    $('#infoProcesses').textContent = data.cpu?.count ? (data.cpu.count * 2 + '...') : '—';

    // ─ Update Hardware Tab ─
    // Status banner
    const hwBannerText = $('#hwBannerText');
    if (hwBannerText) {
        if (cpu > 90 || mem > 90) {
            hwBannerText.textContent = '⚠ 系统负载过高 — CPU ' + cpu.toFixed(0) + '% / 内存 ' + mem.toFixed(0) + '%';
            const hwBanner = $('#hwBanner');
            if (hwBanner) hwBanner.style.borderColor = 'var(--color-red)';
        } else if (cpu > 70 || mem > 80) {
            hwBannerText.textContent = '系统负载较高 — CPU ' + cpu.toFixed(0) + '% / 内存 ' + mem.toFixed(0) + '%';
            const hwBanner = $('#hwBanner');
            if (hwBanner) hwBanner.style.borderColor = 'var(--color-yellow)';
        } else {
            hwBannerText.textContent = '系统运行正常 — CPU ' + cpu.toFixed(0) + '% / 内存 ' + mem.toFixed(0) + '%';
            const hwBanner = $('#hwBanner');
            if (hwBanner) hwBanner.style.borderColor = 'var(--color-grey-30)';
        }
    }

    // CPU Stats
    const cpuStats = $('#hwCpuStats');
    if (cpuStats && data.cpu) {
        const freq = data.cpu.freq?.current ? (data.cpu.freq.current / 1000).toFixed(1) + ' GHz' : '—';
        cpuStats.innerHTML = '<span>CPU: <strong>' + cpu.toFixed(1) + '%</strong></span>' +
            '<span>核心: <strong>' + (data.cpu.count || '—') + '</strong></span>' +
            '<span>频率: <strong>' + freq + '</strong></span>';
        state.lastCpuPerCore = data.cpu.per_cpu || null;
    }

    // Memory Stats
    const memStats = $('#hwMemStats');
    if (memStats && data.memory) {
        memStats.innerHTML = '<span>已用: <strong>' + formatBytes(data.memory.used) + '</strong></span>' +
            '<span>可用: <strong>' + formatBytes(data.memory.available) + '</strong></span>' +
            '<span>总量: <strong>' + formatBytes(data.memory.total) + '</strong></span>';
        state.lastMemData = data.memory;
    }

    // Disk Stats
    const diskStats = $('#hwDiskStats');
    if (diskStats && data.disk) {
        const disk0 = data.disk[0];
        if (disk0) {
            diskStats.innerHTML = '<span>' + (disk0.device || disk0.mountpoint) + ': <strong>' + disk0.percent.toFixed(1) + '%</strong></span>' +
                '<span>已用: <strong>' + formatBytes(disk0.used) + '</strong></span>' +
                '<span>总量: <strong>' + formatBytes(disk0.total) + '</strong></span>';
        }
        state.lastDiskData = data.disk;
    }

    // GPU Stats
    const gpuStats = $('#hwGpuStats');
    if (gpuStats) {
        const gpuData = data.gpu?.[0];
        if (gpuData) {
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
            const gpuName = gpuData.name ? gpuData.name.substring(0, 24) : 'Unknown';
            gpuStats.innerHTML = '<span>GPU: <strong>' + gpuName + '</strong></span>' +
                '<span>温度: <strong>' + tempStr + '</strong></span>';
            state.lastGpuTemp = (function() {
                if (temps) {
                    for (const key of Object.keys(temps)) {
                        const entries = temps[key];
                        if (entries && entries.length > 0 && entries[0]?.current) {
                            return entries[0].current;
                        }
                    }
                }
                return null;
            })();
        } else {
            gpuStats.innerHTML = '<span>GPU: <strong>未检测到</strong></span>';
            state.lastGpuTemp = null;
        }
    }

    // Network Stats
    const netStats = $('#hwNetStats');
    if (netStats && netSpeed) {
        const down = formatSpeed(netSpeed.recv_per_sec);
        const up = formatSpeed(netSpeed.sent_per_sec);
        netStats.innerHTML = '<span>↓ 接收: <strong>' + down + '</strong></span>' +
            '<span>↑ 发送: <strong>' + up + '</strong></span>';

        // Store net history for chart
        const now = new Date().toLocaleTimeString();
        state.netHistory.timestamps.push(now);
        state.netHistory.recv.push(netSpeed.recv_per_sec);
        state.netHistory.sent.push(netSpeed.sent_per_sec);
        if (state.netHistory.timestamps.length > state.maxHistoryPoints) {
            state.netHistory.timestamps.shift();
            state.netHistory.recv.shift();
            state.netHistory.sent.shift();
        }
    }

    // Battery Stats
    const batteryCard = $('#hwBatteryCard');
    const batteryStats = $('#hwBatteryStats');
    if (data.battery) {
        if (batteryCard) batteryCard.classList.remove('hidden');
        if (batteryStats) {
            const pct = data.battery.percent;
            const status = data.battery.power_plugged ? '充电中' : '放电中';
            batteryStats.innerHTML = '<span>电量: <strong>' + pct.toFixed(0) + '%</strong></span>' +
                '<span>状态: <strong>' + status + '</strong></span>';
        }
        state.lastBatteryData = data.battery;
    } else {
        if (batteryCard) batteryCard.classList.add('hidden');
        state.lastBatteryData = null;
    }

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

    DashboardTelemetryController.updateSystem(data);
    updateRealtimeCharts();
}

// ── Deepseek Data Update ─────────────────────────────
function updateDeepseekData(data) {
    if (!data) return;
    state.latestDeepseekData = data;
    if (data.needs_config === true) state.deepseekConfigured = false;
    // Balance
    var balance = data.balance;
    if (balance) {
        var bal = Number(balance.total_balance || balance.balance) || 0;
        var granted = Number(balance.granted_balance) || 0;
        var toppedUp = Number(balance.topped_up_balance) || 0;
        var currency = balance.currency || 'CNY';
        var sym = currency === 'CNY' ? '¥' : '$';
        var abEl = $('#accountBalance');
        if (abEl) {
            abEl.textContent = sym + bal.toFixed(2);
            var heroKpi = abEl.closest('.hero-kpi');
            if (heroKpi) {
                var metaEl = heroKpi.querySelector('.kpi-meta');
                if (metaEl) {
                    metaEl.innerHTML = '<span>赠金: <strong>' + sym + granted.toFixed(2) + '</strong></span>' +
                        '<span>充值: <strong>' + sym + toppedUp.toFixed(2) + '</strong></span>';
                }
            }
        }
    }
    DashboardTelemetryController.updateDeepseek(data);
    updateCostLimitAlert(data);
}

function updateCostLimitAlert(data) {
    var limits = data.limits || {};
    var dailyLimit = Number(limits.daily) || 0;
    var monthlyLimit = Number(limits.monthly) || 0;
    var todayCost = Number(data.today_cost) || 0;
    var monthCost = Number(data.month_cost) || 0;
    var alerts = [];
    if (dailyLimit > 0 && todayCost >= dailyLimit * 0.8) {
        alerts.push('Daily ' + todayCost.toFixed(2) + ' / ' + dailyLimit.toFixed(2));
    }
    if (monthlyLimit > 0 && monthCost >= monthlyLimit * 0.8) {
        alerts.push('Monthly ' + monthCost.toFixed(2) + ' / ' + monthlyLimit.toFixed(2));
    }

    var balanceEl = $('#accountBalance');
    var heroKpi = balanceEl ? balanceEl.closest('.hero-kpi') : null;
    if (!heroKpi) return;

    var alertEl = document.getElementById('ai-cost-limit-alert');
    if (!alerts.length) {
        if (alertEl) alertEl.remove();
        state.lastLimitAlertKey = '';
        return;
    }
    if (!alertEl) {
        alertEl = document.createElement('div');
        alertEl.id = 'ai-cost-limit-alert';
        alertEl.style.cssText = 'margin-top:8px;padding:6px 8px;border:1px solid var(--color-yellow);color:var(--color-yellow);font-family:var(--font-mono);font-size:var(--text-xs);';
        heroKpi.appendChild(alertEl);
    }
    alertEl.textContent = 'AI COST LIMIT WARNING: ' + alerts.join(' | ');
    var alertKey = alerts.join('|');
    if (alertKey !== state.lastLimitAlertKey) {
        showToast('AI cost limit warning: ' + alerts.join(' | '), 'error');
        state.lastLimitAlertKey = alertKey;
    }
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

// ── Hardware Tab Charts ──────────────────────────────

function initHwCpuCoresChart() {
    const ctx = document.getElementById('hwCpuCoresChart');
    if (!ctx) return;

    state.charts.hwCpuCores = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'CPU %',
                data: [],
                backgroundColor: chartColors.red,
                borderColor: chartColors.white,
                borderWidth: 1,
                borderRadius: 0,
                barThickness: 16,
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

function initHwMemChart() {
    const ctx = document.getElementById('hwMemChart');
    if (!ctx) return;

    state.charts.hwMem = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['已用', '可用'],
            datasets: [{
                data: [0, 100],
                backgroundColor: [chartColors.red, chartColors.grid],
                borderWidth: 0,
                borderRadius: 0,
            }],
        },
        options: {
            ...chartDefaults,
            cutout: '65%',
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

function initHwDiskChart() {
    const ctx = document.getElementById('hwDiskChart');
    if (!ctx) return;

    state.charts.hwDisk = new Chart(ctx, {
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
                barThickness: 20,
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

function initHwGpuTempChart() {
    const ctx = document.getElementById('hwGpuTempChart');
    if (!ctx) return;

    state.charts.hwGpuTemp = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['温度', '余量'],
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
}

function initHwNetChart() {
    const ctx = document.getElementById('hwNetChart');
    if (!ctx) return;

    state.charts.hwNet = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: '↓ 接收',
                data: [],
                borderColor: chartColors.red,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                fill: false,
            }, {
                label: '↑ 发送',
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
                y: {
                    ...chartDefaults.scales.y,
                    ticks: {
                        ...chartDefaults.scales.y.ticks,
                        callback: (val) => formatBytes(val),
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
                        font: { family: "'JetBrains Mono', monospace", size: 9 },
                        padding: 12,
                        usePointStyle: true,
                    },
                },
            },
        },
    });
}

function initHwBatteryChart() {
    const ctx = document.getElementById('hwBatteryChart');
    if (!ctx) return;

    state.charts.hwBattery = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['电量', ''],
            datasets: [{
                data: [0, 100],
                backgroundColor: [chartColors.green, chartColors.grid],
                borderWidth: 0,
                borderRadius: 0,
            }],
        },
        options: {
            ...chartDefaults,
            cutout: '65%',
            plugins: {
                ...chartDefaults.plugins,
                legend: { display: false },
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

async function loadAnalysisData() {
    var daysEl = document.getElementById('analysisRangeDays');
    var modelEl = document.getElementById('analysisModelFilter');
    var days = parseInt(daysEl ? daysEl.value : '30', 10) || 30;
    var model = modelEl ? modelEl.value : '';
    var modelParam = model ? '&model=' + encodeURIComponent(model) : '';

    try {
        var summaryResp = await fetch(apiUrl('/api/analysis/summary?days=' + days));
        var historyResp = await fetch(apiUrl('/api/analysis/history?days=' + days + modelParam));
        var modelsResp = await fetch(apiUrl('/api/analysis/models?days=' + days));
        if (!summaryResp.ok || !historyResp.ok || !modelsResp.ok) {
            throw new Error('analysis API failed');
        }
        var summary = await summaryResp.json();
        var history = await historyResp.json();
        var models = await modelsResp.json();

        state.tokenHistory = Array.isArray(history) ? history : [];
        updateAnalysisKpis(summary, models);
        updateAnalysisModelFilter(models, model);
        updateAnalysisCharts(summary, state.tokenHistory, models);
        updateAnalysisTable(state.tokenHistory);
    } catch (e) {
        showToast('分析数据加载失败: ' + e.message, 'error');
    }
}

function updateAnalysisKpis(summary, models) {
    var totalTokens = Number(summary.total_tokens) || 0;
    var totalCached = Number(summary.total_cached) || 0;
    var cacheRate = totalTokens > 0 ? (totalCached / totalTokens * 100).toFixed(1) + '%' : '—';
    var topModel = Array.isArray(models) && models.length > 0 ? models[0].model : '—';
    var totalCost = Number(summary.total_cost) || 0;
    if ($('#analysisTotalTokens')) $('#analysisTotalTokens').textContent = formatNumber(totalTokens);
    if ($('#analysisTotalCost')) $('#analysisTotalCost').textContent = '¥' + totalCost.toFixed(4);
    if ($('#analysisCacheRate')) $('#analysisCacheRate').textContent = cacheRate;
    if ($('#analysisTopModel')) $('#analysisTopModel').textContent = topModel;
}

function updateAnalysisModelFilter(models, selected) {
    var select = document.getElementById('analysisModelFilter');
    if (!select || !Array.isArray(models)) return;
    var current = selected || select.value;
    select.innerHTML = '<option value="">全部模型</option>';
    models.forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m.model;
        opt.textContent = m.model;
        select.appendChild(opt);
    });
    select.value = current;
}

function groupUsageByDate(history) {
    var byDate = {};
    history.forEach(function(r) {
        var d = r.timestamp ? String(r.timestamp).substring(0, 10) : '';
        if (!d) return;
        if (!byDate[d]) byDate[d] = { total: 0, cost: 0, input: 0, output: 0, cached: 0 };
        byDate[d].total += Number(r.total_tokens) || 0;
        byDate[d].cost += Number(r.cost) || 0;
        byDate[d].input += Number(r.input_tokens) || 0;
        byDate[d].output += Number(r.output_tokens) || 0;
        byDate[d].cached += Number(r.cached_tokens) || 0;
    });
    return byDate;
}

function updateAnalysisCharts(summary, history, models) {
    var byDate = groupUsageByDate(history);
    var dates = Object.keys(byDate).sort();
    var labels = dates.map(function(d) { return d.substring(5); });
    var compareMode = !!(document.getElementById('analysisCompareMode') && document.getElementById('analysisCompareMode').checked);

    var historyChart = state.charts.historyTrend;
    if (historyChart) {
        historyChart.data.labels = labels;
        if (compareMode) {
            historyChart.data.datasets = [{
                label: '输入 Token',
                data: dates.map(function(d) { return byDate[d].input; }),
                borderColor: chartColors.red,
                backgroundColor: 'transparent',
                borderWidth: 3,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 6,
                fill: false,
            }, {
                label: '输出 Token',
                data: dates.map(function(d) { return byDate[d].output; }),
                borderColor: chartColors.white,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderDash: [4, 4],
                fill: false,
            }, {
                label: '缓存 Token',
                data: dates.map(function(d) { return byDate[d].cached; }),
                borderColor: chartColors.yellow,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderDash: [2, 4],
                fill: false,
            }];
            historyChart.options.scales.y1.display = false;
        } else {
            historyChart.data.datasets = [{
                label: '总 Token',
                data: dates.map(function(d) { return byDate[d].total; }),
                borderColor: chartColors.red,
                backgroundColor: 'transparent',
                borderWidth: 3,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 6,
                fill: false,
            }, {
                label: '消费 (¥)',
                data: dates.map(function(d) { return byDate[d].cost; }),
                borderColor: chartColors.yellow,
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderDash: [4, 4],
                yAxisID: 'y1',
                fill: false,
            }];
            historyChart.options.scales.y1.display = true;
        }
        historyChart.update('none');
    }

    var costChart = state.charts.costTrend;
    if (costChart) {
        costChart.data.labels = labels;
        costChart.data.datasets[0].data = dates.map(function(d) { return byDate[d].cost; });
        costChart.update('none');
    }

    var modelChart = state.charts.modelBreakdown;
    if (modelChart && Array.isArray(models)) {
        modelChart.data.labels = models.map(function(m) { return String(m.model).substring(0, 16); });
        modelChart.data.datasets[0].data = models.map(function(m) { return Number(m.total_tokens) || 0; });
        modelChart.update('none');
    }

    var cacheChart = state.charts.cacheRate;
    if (cacheChart) {
        var total = Number(summary.total_tokens) || 0;
        var cached = Number(summary.total_cached) || 0;
        cacheChart.data.datasets[0].data = total > 0 ? [cached, Math.max(0, total - cached)] : [0, 100];
        cacheChart.update('none');
    }
}

function updateAnalysisTable(history) {
    var body = document.getElementById('analysisTableBody');
    if (!body) return;
    if (!Array.isArray(history) || history.length === 0) {
        body.innerHTML = '<tr><td colspan="9">暂无导入数据</td></tr>';
        return;
    }
    body.innerHTML = '';
    history.slice().reverse().slice(0, 200).forEach(function(r) {
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td>' + escapeHtml(String(r.timestamp || '').substring(0, 19)) + '</td>' +
            '<td>' + escapeHtml(r.model || '—') + '</td>' +
            '<td>' + formatNumber(Number(r.input_tokens) || 0) + '</td>' +
            '<td>' + formatNumber(Number(r.output_tokens) || 0) + '</td>' +
            '<td>' + formatNumber(Number(r.cached_tokens) || 0) + '</td>' +
            '<td>' + formatNumber(Number(r.total_tokens) || 0) + '</td>' +
            '<td>¥' + (Number(r.cost) || 0).toFixed(4) + '</td>' +
            '<td>' + escapeHtml(r.source_file || '—') + '</td>' +
            '<td>' + escapeHtml(formatImportTime(r.imported_at)) + '</td>';
        body.appendChild(tr);
    });
}

function formatImportTime(value) {
    if (!value) return '—';
    var text = String(value).substring(0, 19).replace('T', ' ');
    return text || '—';
}
function updateRealtimeCharts() {
    // CPU Cores chart
    const cpuChart = state.charts.hwCpuCores;
    if (cpuChart && state.lastCpuPerCore) {
        cpuChart.data.labels = state.lastCpuPerCore.map(function(_, i) { return '核心 ' + i; });
        cpuChart.data.datasets[0].data = state.lastCpuPerCore;
        cpuChart.update('none');
    }

    // Memory chart
    const memChart = state.charts.hwMem;
    if (memChart && state.lastMemData) {
        memChart.data.datasets[0].data = [state.lastMemData.used, state.lastMemData.available];
        memChart.update('none');
    }

    // Disk chart
    const diskChart = state.charts.hwDisk;
    if (diskChart && state.lastDiskData) {
        diskChart.data.labels = state.lastDiskData.map(function(d) { return (d.device || d.mountpoint).substring(0, 20); });
        diskChart.data.datasets[0].data = state.lastDiskData.map(function(d) { return d.percent || 0; });
        diskChart.update('none');
    }

    // GPU Temp chart
    const gpuChart = state.charts.hwGpuTemp;
    if (gpuChart) {
        const temp = state.lastGpuTemp;
        if (temp !== null && temp !== undefined) {
            const cappedTemp = Math.min(temp, 100);
            gpuChart.data.datasets[0].data = [cappedTemp, 100 - cappedTemp];
            gpuChart.data.datasets[0].backgroundColor = [temp > 80 ? chartColors.red : chartColors.green, chartColors.grid];
        } else {
            gpuChart.data.datasets[0].data = [0, 100];
            gpuChart.data.datasets[0].backgroundColor = [chartColors.grid, chartColors.grid];
        }
        gpuChart.update('none');
    }

    // Network chart
    const netChart = state.charts.hwNet;
    if (netChart && state.netHistory.timestamps.length > 0) {
        netChart.data.labels = state.netHistory.timestamps;
        netChart.data.datasets[0].data = state.netHistory.recv;
        netChart.data.datasets[1].data = state.netHistory.sent;
        netChart.update('none');
    }

    // Battery chart
    const batChart = state.charts.hwBattery;
    if (batChart && state.lastBatteryData) {
        const pct = state.lastBatteryData.percent;
        batChart.data.datasets[0].data = [pct, 100 - pct];
        batChart.data.datasets[0].backgroundColor = [
            pct > 50 ? chartColors.green : (pct > 20 ? chartColors.yellow : chartColors.red),
            chartColors.grid
        ];
        batChart.update('none');
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
    var lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.zip')) {
        showCsvResult('仅支持 CSV 或 ZIP 文件', 'error');
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

function updateAnalysisDataSource(source) {
    var el = document.getElementById('analysis-data-source');
    if (!el) return;
    var value = source || localStorage.getItem('pulse-analysis-data-source') || '';
    if (!value) {
        el.classList.add('hidden');
        return;
    }
    el.textContent = 'DATA SOURCE: ' + value;
    el.classList.remove('hidden');
}

$('#csvImportBtn')?.addEventListener('click', async () => {
    if (!state.pendingCsvFile) return;

    const formData = new FormData();
    formData.append('file', state.pendingCsvFile);

    try {
        const resp = await fetch(apiUrl('/api/csv/import'), {
            method: 'POST',
            body: formData,
        });
        const result = await resp.json();
        if (result.status === 'ok') {
            let msg = '✓ 成功导入 ' + result.imported + ' 条记录';
            if (result.columns_unmatched && result.columns_unmatched.length > 0) {
                msg += ' (未匹配列: ' + result.columns_unmatched.join(', ') + ')';
            }
            showCsvResult(msg, 'success');
            var sourceParts = [];
            if (result.files_parsed && result.files_parsed.length) {
                sourceParts.push(result.files_parsed.join(', '));
            } else {
                sourceParts.push(state.pendingCsvFile.name);
            }
            sourceParts.push('seen=' + result.records_seen);
            sourceParts.push('imported=' + result.imported);
            var sourceLabel = sourceParts.join(' | ');
            localStorage.setItem('pulse-analysis-data-source', sourceLabel);
            updateAnalysisDataSource(sourceLabel);
            state.pendingCsvFile = null;
            if ($('#csvPreview')) $('#csvPreview').classList.add('hidden');
            await loadAnalysisData();
        } else {
            showCsvResult('✕ 导入失败', 'error');
        }
    } catch (e) {
        showCsvResult('✕ 上传错误: ' + e.message, 'error');
    }
});

// ── Settings ─────────────────────────────────────────

// Keep AI widgets visible, but render them as locked when no API key is configured.
async function checkAiWidgets() {
    try {
        var resp = await fetch(apiUrl('/api/config'));
        var cfg = await resp.json();
        var providers = cfg.configured_providers || {};
        state.deepseekConfigured = !!providers.deepseek;
        updateSetupNotice(!!cfg.configured);
        WidgetEngine.renderAll();
        if (state.latestDeepseekData) {
            WidgetEngine.updateAll('deepseek', state.latestDeepseekData);
        } else {
            WidgetEngine.updateAll('deepseek', { needs_config: !state.deepseekConfigured });
        }
    } catch (e) {
        /* silently ignore */
    }
}

function getSelectedProvider() {
    var providerEl = document.getElementById('settings-provider');
    var provider = providerEl ? providerEl.value : (state.config.ai_provider || 'deepseek');
    return AI_PROVIDERS[provider] ? provider : 'deepseek';
}

function renderProviderSettings(provider) {
    provider = AI_PROVIDERS[provider] ? provider : 'deepseek';
    var meta = AI_PROVIDERS[provider];
    var cfg = state.config || {};
    var providerEl = document.getElementById('settings-provider');
    var keyEl = document.getElementById('settings-api-key');
    var baseEl = document.getElementById('settings-base-url');
    if (providerEl) providerEl.value = provider;
    if (keyEl) {
        var configured = !!(cfg.configured_providers && cfg.configured_providers[provider]);
        keyEl.value = '';
        keyEl.placeholder = configured ? meta.label + ' 已配置，留空则不修改' : meta.keyPlaceholder;
    }
    if (baseEl) baseEl.value = cfg[meta.baseField] || meta.defaultBaseUrl;
}

// Load config
async function loadConfig() {
    try {
        const resp = await fetch(apiUrl('/api/config'));
        state.config = await resp.json();
        const cfg = state.config;
        state.deepseekConfigured = !!(cfg.configured_providers && cfg.configured_providers.deepseek);
        updateSetupNotice(!!cfg.configured);

        renderProviderSettings(cfg.ai_provider || 'deepseek');
        if ($('#settings-daily-limit')) $('#settings-daily-limit').value = cfg.daily_spending_limit || 5;
        if ($('#settings-monthly-limit')) $('#settings-monthly-limit').value = cfg.monthly_spending_limit || 100;

    } catch (e) {
        console.warn('Failed to load config:', e);
    }
}

// Save Config
async function saveConfig(body, statusEl) {
    try {
        const resp = await fetch(apiUrl('/api/config'), {
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
            loadConfig().then(function() {
                checkAiWidgets();
                DashboardTelemetryController.updateDeepseek(state.latestDeepseekData || { needs_config: !state.deepseekConfigured });
            }); // Refresh
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


// ── Init ────────────────────────────────────────────
function init() {
    // Load config
    loadConfig();

    // Initialize Widget Engine (replaces old dashboard charts)
    WidgetEngine.init();
    setTimeout(function() { checkAiWidgets(); }, 500);

    // Initialize hardware tab charts
    initHwCpuCoresChart();
    initHwMemChart();
    initHwDiskChart();
    initHwGpuTempChart();
    initHwNetChart();
    initHwBatteryChart();
    initHistoryTrendChart();
    initModelBreakdownChart();
    initCacheRateChart();
    initCostTrendChart();
    DashboardTelemetryController.init();
    initTabNavigation();
    loadAnalysisData();
    updateAnalysisDataSource();

    $('#analysisRangeDays')?.addEventListener('change', loadAnalysisData);
    $('#analysisModelFilter')?.addEventListener('change', loadAnalysisData);
    $('#analysisCompareMode')?.addEventListener('change', loadAnalysisData);
    $('#analysisRefreshBtn')?.addEventListener('click', loadAnalysisData);

    // Connect WebSocket
    connectWs();

    window.addEventListener('resize', function() {
        setTimeout(resizeVisibleCharts, 80);
    });

    // Periodic ping
    setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ action: 'ping' }));
        }
    }, 30000);

    console.log('[Pulse] Initialized');
    initPhase45();
}

// --- Title Bar ---
function initTitleBar() {
  document.getElementById("titlebar-minimize").onclick = function() {
    if (window.__TAURI__) { window.__TAURI__.window.getCurrent().minimize(); }
  };
  document.getElementById("titlebar-maximize").onclick = function() {
    if (window.__TAURI__) {
      var w = window.__TAURI__.window.getCurrent();
      w.isMaximized().then(function(m) { if (m) w.unmaximize(); else w.maximize(); });
    } else {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    }
  };
  document.getElementById("titlebar-close").onclick = function() {
    if (window.__TAURI__) {
      window.__TAURI__.window.getCurrent().hide();
    } else {
      if (confirm("Close Pulse?")) window.close();
    }
  };
  document.body.classList.add("has-titlebar");
}

// --- Connection Status ---
var reconnectAttempts = 0;
function showConnectionLost() {
  var b = document.getElementById("connection-banner");
  if (b) { b.classList.remove("hidden"); b.textContent = "CONNECTION LOST — Reconnecting..."; }
}
function hideConnectionLost() {
  var b = document.getElementById("connection-banner");
  if (b) b.classList.add("hidden");
  reconnectAttempts = 0;
}

// --- Toast ---
function showToast(msg, type) {
  type = type || "info";
  var c = document.getElementById("toast-container");
  if (!c) return;
  var t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(function() { t.remove(); }, 4000);
}

// --- First-run Setup ---
function updateSetupNotice(configured) {
  var banner = document.getElementById("setup-banner");
  var overlay = document.getElementById("setup-overlay");
  var dismissed = sessionStorage.getItem("pulse-setup-banner-dismissed") === "1";
  state.setupRequired = !configured;
  if (overlay) overlay.classList.add("hidden");
  if (!banner) return;
  if (configured || dismissed) banner.classList.add("hidden");
  else banner.classList.remove("hidden");
}

function checkFirstRun() {
  fetch(apiUrl("/api/config")).then(function(r) { return r.json(); }).then(function(cfg) {
    state.config = cfg;
    state.deepseekConfigured = !!(cfg.configured_providers && cfg.configured_providers.deepseek);
    updateSetupNotice(!!cfg.configured);
  }).catch(function(e) { console.warn("[Pulse] First-run check:", e); });
}

function initSetupBanner() {
  var dismiss = document.getElementById("setup-banner-dismiss");
  var settings = document.getElementById("setup-banner-settings");
  if (dismiss) {
    dismiss.onclick = function() {
      sessionStorage.setItem("pulse-setup-banner-dismissed", "1");
      updateSetupNotice(false);
    };
  }
  if (settings) {
    settings.onclick = function() {
      sessionStorage.removeItem("pulse-setup-banner-dismissed");
      activateTab("settings", { syncUrl: true });
      var keyEl = document.getElementById("settings-api-key");
      if (keyEl) setTimeout(function() { keyEl.focus(); }, 120);
    };
  }
}

// --- Setup Form ---
function initSetupForm() {
  var form = document.getElementById("setup-form");
  if (!form) return;
  form.onsubmit = function(e) {
    e.preventDefault();
    var btn = form.querySelector(".setup-btn");
    btn.textContent = "SAVING..."; btn.disabled = true;
    fetch(apiUrl("/api/config"), {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        ai_provider: 'deepseek',
        deepseek_api_key: document.getElementById("setup-api-key").value,
        deepseek_base_url: document.getElementById("setup-base-url").value,
        daily_spending_limit: parseFloat(document.getElementById("setup-daily-limit").value) || 5,
        monthly_spending_limit: parseFloat(document.getElementById("setup-monthly-limit").value) || 100,
      })
    }).then(function(r) {
      if (r.ok) { showToast("Config saved","success"); location.reload(); }
      else showToast("Save failed","error");
    }).catch(function(e) { showToast("Error: "+e.message,"error"); });
  };
}

// --- Settings Form ---
function initSettingsForm() {
  var form = document.getElementById("settings-form");
  if (!form) return;
  var providerSelect = document.getElementById("settings-provider");
  if (providerSelect) {
    providerSelect.onchange = function() {
      renderProviderSettings(getSelectedProvider());
    };
  }
  form.onsubmit = function(e) {
    e.preventDefault();
    var provider = getSelectedProvider();
    var meta = AI_PROVIDERS[provider];
    var payload = {
        ai_provider: provider,
        [meta.baseField]: document.getElementById("settings-base-url").value || meta.defaultBaseUrl,
        daily_spending_limit: parseFloat(document.getElementById("settings-daily-limit").value) || 5,
        monthly_spending_limit: parseFloat(document.getElementById("settings-monthly-limit").value) || 100,
    };
    var apiKey = document.getElementById("settings-api-key").value.trim();
    if (apiKey) payload[meta.keyField] = apiKey;
    fetch(apiUrl("/api/config"), {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    }).then(function(r) {
      if (r.ok) {
        showToast("Config saved","success");
        loadConfig();
      }
      else showToast("Save failed","error");
    }).catch(function(e) { showToast("Error","error"); });
  };
}

// --- Autostart Toggle ---
function initAutostartToggle() {
  var cb = document.getElementById("settings-autostart");
  if (!cb) return;
  cb.onchange = function() {
    if (window.__TAURI__) {
      if (cb.checked) showToast("开机自启已启用（Tauri）","info");
      else showToast("开机自启已禁用（Tauri）","info");
    } else {
      showToast("开机自启需在 Tauri 桌面版中使用","info");
      cb.checked = false;
    }
  };
}

// ══════════════════════════════════════════════════
//  Theme Engine (M4.1)
//  JSON→CSS变量→图表重绘
// ══════════════════════════════════════════════════
const STORE_API = 'http://127.0.0.1:8081'; // 商店后端地址
const STORE_OFFLINE_MESSAGE = '主题商店离线，请启动 127.0.0.1:8081 服务后重试。';

async function storeFetch(path, options) {
    try {
        return await fetch(STORE_API + path, options);
    } catch (e) {
        var err = new Error(STORE_OFFLINE_MESSAGE);
        err.cause = e;
        err.storeOffline = true;
        throw err;
    }
}

function showStoreOffline(status, detail) {
    if (status) {
        status.textContent = detail || STORE_OFFLINE_MESSAGE;
        status.style.color = 'var(--signal-warn, var(--color-yellow))';
    }
}

var ThemeEngine = {
    activeThemeId: null,
    installedThemes: {},
    schemaVersion: 3,
    defaultThemeId: 'builtin-telemetry-ops',
    layoutKey: 'pulse-ui-layout-v3',
    legacyLayoutKey: 'pulse-widget-layout',

    init: function() {
        var builtins = this._builtinThemes();
        for (var i = 0; i < builtins.length; i++) {
            this._registerTheme(this._normalizeThemePayload(builtins[i], 'builtin'), true);
        }

        this._loadInstalledThemes();
        this._migrateLegacyLayout();
        this._discoverLocal();
        this._populateSelector();

        var rawTokens = localStorage.getItem('pulse-theme-tokens');
        var rawLegacyTokens = localStorage.getItem('pulse-theme-legacy-tokens');
        var activeId = localStorage.getItem('pulse-active-theme-id') || this.defaultThemeId;
        var legacySchema = parseInt(localStorage.getItem('pulse-theme-schema-version'), 10);
        var customCSS = localStorage.getItem('pulse-theme-custom-css') || '';
        var activeTheme = this.installedThemes[activeId];

        if (rawTokens) {
            try {
                var parsed = JSON.parse(rawTokens);
                var payload = {
                    id: activeId,
                    name: (activeTheme && activeTheme.name) || 'Custom Theme',
                    author: (activeTheme && activeTheme.author) || 'Local',
                    type: (activeTheme && activeTheme.type) || 'custom',
                    schemaVersion: legacySchema || this.schemaVersion,
                    legacyCompatible: localStorage.getItem('pulse-theme-legacy-compatible') === '1',
                    tokens: parsed,
                    legacyTokens: rawLegacyTokens ? JSON.parse(rawLegacyTokens) : null,
                    customCSS: customCSS,
                };
                this.activate(this._normalizeThemePayload(payload, 'stored'));
                return;
            } catch (e) {}
        }

        if (activeTheme) {
            this.activate(this._normalizeThemePayload(activeTheme, 'stored'));
        } else {
            this.activate(this._normalizeThemePayload(this._builtinThemes()[0], 'default'));
        }
    },

    _builtinThemes: function() {
        return [
            {
                id: 'builtin-telemetry-ops',
                name: 'Telemetry Ops',
                author: 'Pulse Team',
                type: 'official',
                schemaVersion: 3,
                legacyCompatible: true,
                tokens: {
                    surface: {
                        base: 'oklch(14% 0.015 250)',
                        panel: 'oklch(19% 0.018 250)',
                        panel2: 'oklch(23% 0.022 250)',
                        elevated: 'oklch(28% 0.025 250)',
                        line: 'oklch(38% 0.035 250)',
                        hairline: 'oklch(42% 0.04 250 / 0.38)',
                    },
                    text: {
                        primary: 'oklch(93% 0.008 250)',
                        secondary: 'oklch(73% 0.018 250)',
                        muted: 'oklch(58% 0.02 250)',
                    },
                    signal: {
                        primary: 'oklch(72% 0.16 205)',
                        ai: 'oklch(76% 0.17 305)',
                        system: 'oklch(74% 0.15 155)',
                        warn: 'oklch(82% 0.16 85)',
                        danger: 'oklch(66% 0.2 25)',
                    },
                    chart: {
                        grid: 'oklch(32% 0.025 250 / 0.7)',
                        glow: 'oklch(72% 0.16 205 / 0.26)',
                    },
                    motion: {
                        fast: '100ms',
                        normal: '200ms',
                        slow: '280ms',
                    },
                    canvas: {
                        glow: 'oklch(72% 0.16 205 / 0.2)',
                    },
                },
                legacyTokens: {
                    'color-red': 'oklch(66% 0.2 25)',
                    'color-black': 'oklch(14% 0.015 250)',
                    'color-white': 'oklch(93% 0.008 250)',
                    'color-grey-10': 'oklch(19% 0.018 250)',
                    'color-grey-20': 'oklch(23% 0.022 250)',
                    'color-grey-30': 'oklch(38% 0.035 250)',
                    'color-grey-50': 'oklch(58% 0.02 250)',
                    'color-grey-70': 'oklch(73% 0.018 250)',
                    'color-yellow': 'oklch(82% 0.16 85)',
                    'color-green': 'oklch(74% 0.15 155)',
                }
            },
            {
                id: 'builtin-constructivist',
                name: '苏维埃构成主义（历史）',
                author: 'Pulse Team',
                type: 'legacy-official',
                schemaVersion: 1,
                legacyCompatible: true,
                tokens: {
                    surface: {
                        base: '#000000',
                        panel: '#1A1A1A',
                        panel2: '#222222',
                        elevated: '#4D4D4D',
                        line: '#990000',
                        hairline: '#CC0000',
                    },
                    text: {
                        primary: '#FFFFFF',
                        secondary: '#B3B3B3',
                        muted: '#808080',
                    },
                    signal: {
                        primary: '#990000',
                        ai: '#FF0000',
                        system: '#00AA44',
                        warn: '#FFD700',
                        danger: '#CC0000',
                    },
                    chart: {
                        grid: '#333333',
                        glow: '#CC0000',
                    },
                    motion: {
                        fast: '100ms',
                        normal: '200ms',
                        slow: '280ms',
                    },
                    canvas: {
                        glow: '#CC0000',
                    },
                },
                legacyTokens: {
                    'color-red': '#CC0000',
                    'color-black': '#000000',
                    'color-white': '#FFFFFF',
                    'color-grey-10': '#1A1A1A',
                    'color-grey-20': '#222222',
                    'color-grey-30': '#4D4D4D',
                    'color-grey-50': '#808080',
                    'color-grey-70': '#B3B3B3',
                    'color-yellow': '#FFD700',
                    'color-green': '#2D8A2D',
                },
            }
        ];
    },

    _migrateLegacyLayout: function() {
        var hasNew = localStorage.getItem(this.layoutKey);
        if (!hasNew) {
            var legacy = localStorage.getItem(this.legacyLayoutKey);
            if (legacy) localStorage.setItem(this.layoutKey, legacy);
        }
    },

    _loadInstalledThemes: function() {
        var installed = localStorage.getItem('pulse-installed-themes');
        if (!installed) return;
        try {
            var parsed = JSON.parse(installed);
            var self = this;
            Object.keys(parsed).forEach(function(id) {
                if (!parsed[id] || typeof parsed[id] !== 'object') return;
                parsed[id].id = parsed[id].id || id;
                self._registerTheme(self._normalizeThemePayload(parsed[id], 'installed'), !!parsed[id].builtin);
            });
        } catch (e) {}
    },

    _registerTheme: function(theme, isBuiltin) {
        if (!theme || !theme.id) return;
        if (!theme.name) theme.name = theme.id;
        if (!theme.author) theme.author = 'Local';
        if (!theme.type) theme.type = isBuiltin ? 'official' : 'custom';
        if (!theme._localPath) delete theme._localPath;
        theme.builtin = !!isBuiltin || !!theme.builtin;
        theme.installedAt = theme.installedAt || Date.now();
        if (typeof theme.schemaVersion !== 'number') theme.schemaVersion = this.schemaVersion;
        this.installedThemes[theme.id] = theme;
        this._persistInstalledThemes();
    },

    _persistInstalledThemes: function() {
        localStorage.setItem('pulse-installed-themes', JSON.stringify(this.installedThemes));
    },

    _discoverLocal: function() {
        var self = this;
        var LOCAL_THEMES = [
            { id: 'mediterranean', path: 'themes/mediterranean/theme.json' },
            { id: 'editorial', path: 'themes/editorial/theme.json' },
        ];
        LOCAL_THEMES.forEach(function(entry) {
            if (self.installedThemes[entry.id]) return;
            fetch(entry.path)
                .then(function(r) { if (!r.ok) throw new Error('not found'); return r.json(); })
                .then(function(theme) {
                    theme.id = entry.id;
                    theme._localPath = entry.path;
                    self._registerTheme(self._normalizeThemePayload(theme, 'local'), false);
                    self._populateSelector();
                })
                .catch(function() {});
        });
    },

    _populateSelector: function() {
        var sel = document.getElementById('theme-selector');
        if (!sel) return;
        while (sel.options.length > 1) sel.remove(1);
        var self = this;
        Object.keys(this.installedThemes).forEach(function(id) {
            var theme = self.installedThemes[id];
            if (!theme) return;
            var opt = document.createElement('option');
            opt.value = id;
            opt.textContent = (theme.name || id) + (theme.legacyCompatible ? ' (Legacy)' : '') + (theme._localPath ? ' [本地]' : '');
            sel.appendChild(opt);
        });
        if (this.activeThemeId) sel.value = this.activeThemeId;
    },

    _syncLegacyAliases: function() {
        var root = document.documentElement;
        var aliases = {
            'color-red': 'signal-danger',
            'color-black': 'surface-base',
            'color-white': 'text-primary',
            'color-grey-10': 'surface-panel',
            'color-grey-20': 'surface-panel2',
            'color-grey-30': 'surface-line',
            'color-grey-50': 'text-muted',
            'color-grey-70': 'text-secondary',
            'color-yellow': 'signal-warn',
            'color-green': 'signal-system',
        };
        Object.keys(aliases).forEach(function(alias) {
            var value = getComputedStyle(root).getPropertyValue('--' + aliases[alias]).trim();
            if (value) root.style.setProperty('--' + alias, value);
        });
    },

    _flattenTokens: function(tokens) {
        var flat = {};
        var groups = {
            surface: ['base', 'panel', 'panel2', 'elevated', 'line', 'hairline'],
            text: ['primary', 'secondary', 'muted'],
            signal: ['primary', 'ai', 'system', 'warn', 'danger'],
            chart: ['grid', 'glow'],
            motion: ['fast', 'normal', 'slow'],
            canvas: ['glow'],
        };
        if (!tokens || typeof tokens !== 'object') tokens = {};
        Object.keys(groups).forEach(function(group) {
            var source = tokens[group];
            if (!source || typeof source !== 'object') return;
            for (var i = 0; i < groups[group].length; i++) {
                var key = groups[group][i];
                if (source[key] !== undefined) {
                    flat[group + '-' + key] = source[key];
                }
            }
        });
        return flat;
    },

    _applyTokens: function(tokens) {
        var root = document.documentElement;
        var flat = this._flattenTokens(tokens);
        for (var key in flat) {
            if (flat.hasOwnProperty(key)) {
                root.style.setProperty('--' + this._normalizeTokenKey(key), flat[key]);
            }
        }
        this._syncLegacyAliases();
    },

    _normalizeTokenKey: function(key) {
        var map = {
            colorPrimary: 'color-red',
            colorAccent: 'color-yellow',
            colorBackground: 'color-black',
            colorSurface: 'color-grey-10',
            colorText: 'color-white',
            colorMuted: 'color-grey-50',
            colorBorder: 'color-grey-30',
            surfaceBase: 'surface-base',
            surfacePanel: 'surface-panel',
            surfacePanel2: 'surface-panel2',
            surfaceElevated: 'surface-elevated',
            surfaceLine: 'surface-line',
            surfaceHairline: 'surface-hairline',
            textPrimary: 'text-primary',
            textSecondary: 'text-secondary',
            textMuted: 'text-muted',
            signalPrimary: 'signal-primary',
            signalAi: 'signal-ai',
            signalSystem: 'signal-system',
            signalWarn: 'signal-warn',
            signalDanger: 'signal-danger',
            chartGrid: 'chart-grid',
            chartGlow: 'chart-glow',
            durationFast: 'duration-fast',
            durationNormal: 'duration-normal',
            durationSlow: 'duration-slow',
            fontBody: 'font-body',
            fontHeading: 'font-heading',
            fontMono: 'font-mono',
            textBase: 'text-base',
            textLg: 'text-lg',
            text4xl: 'text-4xl',
        };
        if (map[key]) return map[key];
        return String(key).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
    },

    _normalizeThemePayload: function(rawTheme, _source) {
        if (!rawTheme || typeof rawTheme !== 'object') {
            throw new Error('theme invalid');
        }

        var theme = {
            id: String(rawTheme.id || ('custom-' + Date.now())),
            name: rawTheme.name || rawTheme.id || 'Custom Theme',
            author: rawTheme.author || 'Local',
            type: rawTheme.type || 'custom',
            schemaVersion: Number(rawTheme.schemaVersion) || this.schemaVersion,
            installedAt: rawTheme.installedAt || Date.now(),
            legacyCompatible: !!rawTheme.legacyCompatible,
            customCSS: rawTheme.customCSS || '',
            builtin: !!rawTheme.builtin,
            _localPath: rawTheme._localPath,
            legacyTokens: null,
            tokens: null,
        };

        var source = rawTheme.tokens || rawTheme;
        if (!source || typeof source !== 'object') {
            throw new Error('theme tokens invalid');
        }

        var aliasMap = {
            'surface-base': ['surface', 'base'],
            'surface-panel': ['surface', 'panel'],
            'surface-panel2': ['surface', 'panel2'],
            'surface-elevated': ['surface', 'elevated'],
            'surface-line': ['surface', 'line'],
            'surface-hairline': ['surface', 'hairline'],
            'text-primary': ['text', 'primary'],
            'text-secondary': ['text', 'secondary'],
            'text-muted': ['text', 'muted'],
            'signal-primary': ['signal', 'primary'],
            'signal-ai': ['signal', 'ai'],
            'signal-system': ['signal', 'system'],
            'signal-warn': ['signal', 'warn'],
            'signal-danger': ['signal', 'danger'],
            'chart-grid': ['chart', 'grid'],
            'chart-glow': ['chart', 'glow'],
            'canvas-glow': ['canvas', 'glow'],
            'duration-fast': ['motion', 'fast'],
            'duration-normal': ['motion', 'normal'],
            'duration-slow': ['motion', 'slow'],
            'motion-fast': ['motion', 'fast'],
            'motion-normal': ['motion', 'normal'],
            'motion-slow': ['motion', 'slow'],
            'color-red': ['signal', 'danger'],
            'color-black': ['surface', 'base'],
            'color-white': ['text', 'primary'],
            'color-grey-10': ['surface', 'panel'],
            'color-grey-20': ['surface', 'panel2'],
            'color-grey-30': ['surface', 'line'],
            'color-grey-50': ['text', 'muted'],
            'color-grey-70': ['text', 'secondary'],
            'color-yellow': ['signal', 'warn'],
            'color-green': ['signal', 'system'],
        };

        var flat = {
            surface: {},
            text: {},
            signal: {},
            chart: {},
            motion: {},
            canvas: {}
        };
        theme.legacyTokens = null;

        if (source.surface || source.text || source.signal || source.chart || source.motion || source.canvas) {
            if (source.surface && typeof source.surface === 'object') flat.surface = source.surface;
            if (source.text && typeof source.text === 'object') flat.text = source.text;
            if (source.signal && typeof source.signal === 'object') flat.signal = source.signal;
            if (source.chart && typeof source.chart === 'object') flat.chart = source.chart;
            if (source.motion && typeof source.motion === 'object') flat.motion = source.motion;
            if (source.canvas && typeof source.canvas === 'object') flat.canvas = source.canvas;
            theme.legacyTokens = rawTheme.legacyTokens || null;
        } else {
            Object.keys(source).forEach(function(key) {
                var mapped = aliasMap[key];
                if (mapped) {
                    flat[mapped[0]][mapped[1]] = source[key];
                } else {
                    var normalized = this._normalizeTokenKey(key);
                    var parts = normalized.split('-');
                    if (parts.length >= 2 && (parts[0] === 'surface' || parts[0] === 'text' || parts[0] === 'signal' || parts[0] === 'chart' || parts[0] === 'motion' || parts[0] === 'canvas')) {
                        flat[parts[0]] = flat[parts[0]] || {};
                        flat[parts[0]][parts.slice(1).join('-')] = source[key];
                    }
                }
            }.bind(this));
            theme.legacyTokens = {};
            Object.keys(source).forEach(function(key) {
                if (aliasMap[key]) {
                    theme.legacyTokens[key] = source[key];
                    return;
                }
            });
            if (!Object.keys(theme.legacyTokens).length) {
                theme.legacyTokens = null;
            }
            theme.schemaVersion = this.schemaVersion;
            theme.legacyCompatible = true;
        }

        var fallback = this._getBuiltinById(theme.id) || this._builtinThemes()[0];
        if (!flat.surface || !flat.surface.base) {
            flat.surface = {
                base: flat.surface.base || fallback.tokens.surface.base,
                panel: flat.surface.panel || fallback.tokens.surface.panel,
                panel2: flat.surface.panel2 || fallback.tokens.surface.panel2,
                elevated: flat.surface.elevated || fallback.tokens.surface.elevated,
                line: flat.surface.line || fallback.tokens.surface.line,
                hairline: flat.surface.hairline || fallback.tokens.surface.hairline,
            };
        }
        if (!flat.text || !flat.text.primary) {
            flat.text = {
                primary: flat.text.primary || fallback.tokens.text.primary,
                secondary: flat.text.secondary || fallback.tokens.text.secondary,
                muted: flat.text.muted || fallback.tokens.text.muted,
            };
        }
        if (!flat.signal || !flat.signal.primary) {
            flat.signal = {
                primary: flat.signal.primary || fallback.tokens.signal.primary,
                ai: flat.signal.ai || fallback.tokens.signal.ai,
                system: flat.signal.system || fallback.tokens.signal.system,
                warn: flat.signal.warn || fallback.tokens.signal.warn,
                danger: flat.signal.danger || fallback.tokens.signal.danger,
            };
        }
        if (!flat.chart || !flat.chart.grid) {
            flat.chart = {
                grid: flat.chart.grid || fallback.tokens.chart.grid,
                glow: flat.chart.glow || fallback.tokens.chart.glow,
            };
        }
        if (!flat.motion || !flat.motion.normal) {
            flat.motion = {
                fast: flat.motion.fast || fallback.tokens.motion.fast,
                normal: flat.motion.normal || fallback.tokens.motion.normal,
                slow: flat.motion.slow || fallback.tokens.motion.slow,
            };
        }
        if (!flat.canvas || !flat.canvas.glow) {
            flat.canvas = {
                glow: flat.canvas.glow || fallback.tokens.canvas.glow,
            };
        }

        theme.tokens = {
            surface: {
                base: flat.surface.base,
                panel: flat.surface.panel,
                panel2: flat.surface.panel2,
                elevated: flat.surface.elevated,
                line: flat.surface.line,
                hairline: flat.surface.hairline,
            },
            text: {
                primary: flat.text.primary,
                secondary: flat.text.secondary,
                muted: flat.text.muted,
            },
            signal: {
                primary: flat.signal.primary,
                ai: flat.signal.ai,
                system: flat.signal.system,
                warn: flat.signal.warn,
                danger: flat.signal.danger,
            },
            chart: {
                grid: flat.chart.grid,
                glow: flat.chart.glow,
            },
            motion: {
                fast: flat.motion.fast || '100ms',
                normal: flat.motion.normal || '200ms',
                slow: flat.motion.slow || '280ms',
            },
            canvas: {
                glow: flat.canvas.glow || (rawTheme.canvas && rawTheme.canvas.glow) || 'oklch(72% 0.16 205 / 0.2)',
            },
        };

        if (Number.isFinite(theme.schemaVersion) && theme.schemaVersion < 3) {
            theme.schemaVersion = this.schemaVersion;
            theme.legacyCompatible = true;
        }
        if (typeof theme.legacyTokens !== 'object' || theme.legacyTokens === null) {
            theme.legacyTokens = null;
        }

        return theme;
    },

    _getBuiltinById: function(id) {
        var builtinList = this._builtinThemes();
        for (var i = 0; i < builtinList.length; i++) {
            if (builtinList[i].id === id) return builtinList[i];
        }
        return null;
    },

    activate: function(theme) {
        var normalized = this._normalizeThemePayload(theme, 'activate');
        this._applyTokens(normalized.tokens);
        if (normalized.legacyTokens) this._applyTokens(normalized.legacyTokens);

        localStorage.setItem('pulse-theme-tokens', JSON.stringify(normalized.tokens));
        localStorage.setItem('pulse-theme-legacy-tokens', JSON.stringify(normalized.legacyTokens || {}));
        localStorage.setItem('pulse-theme-schema-version', String(normalized.schemaVersion || this.schemaVersion));
        localStorage.setItem('pulse-theme-legacy-compatible', normalized.legacyCompatible ? '1' : '0');
        localStorage.setItem('pulse-theme-custom-css', normalized.customCSS || '');

        var customEl = document.getElementById('pulse-theme-custom');
        if (!customEl) {
            customEl = document.createElement('style');
            customEl.id = 'pulse-theme-custom';
            document.head.appendChild(customEl);
        }
        customEl.textContent = normalized.customCSS || '';

        Object.values(state.charts).forEach(function(c) { if (c && c.update) c.update(); });
        if (window.TelemetryCanvas && TelemetryCanvas.refreshTheme) TelemetryCanvas.refreshTheme();
        if (DashboardTelemetryController && DashboardTelemetryController.resize) DashboardTelemetryController.resize();

        this.activeThemeId = normalized.id;
        if (!this.installedThemes[normalized.id]) {
            this._registerTheme(normalized, !!normalized.builtin);
        }
        this._persistInstalledThemes();

        localStorage.setItem('pulse-active-theme-id', this.activeThemeId);
        var sel = document.getElementById('theme-selector');
        if (sel) sel.value = this.activeThemeId;
        this._populateSelector();
        console.log('[ThemeEngine] Activated:', normalized.name || normalized.id);
    },

    install: function(theme) {
        var normalized = this._normalizeThemePayload(theme, 'install');
        normalized.installedAt = Date.now();
        this._registerTheme(normalized, false);
        this.activate(normalized);
        showToast('主题 "' + normalized.name + '" 已安装', 'success');
    },

    resetToDefault: function() {
        localStorage.removeItem('pulse-active-theme-id');
        localStorage.removeItem('pulse-theme-tokens');
        localStorage.removeItem('pulse-theme-legacy-tokens');
        localStorage.removeItem('pulse-theme-schema-version');
        localStorage.removeItem('pulse-theme-legacy-compatible');
        localStorage.removeItem('pulse-theme-custom-css');
        this.activate(this._normalizeThemePayload(this._getBuiltinById(this.defaultThemeId) || this._builtinThemes()[0], 'default'));
        var sel = document.getElementById('theme-selector');
        if (sel) sel.value = this.defaultThemeId;
        showToast('主题已恢复默认', 'info');
    },

    isInstalled: function(themeId) {
        return !!this.installedThemes[themeId];
    }
};

function collectThemeEditorTokens() {
    return {
        'color-red': document.getElementById('theme-color-red').value,
        'color-black': document.getElementById('theme-color-black').value,
        'color-white': document.getElementById('theme-color-white').value,
        'color-grey-10': document.getElementById('theme-color-grey-10').value,
        'color-grey-30': document.getElementById('theme-color-grey-30').value,
        'color-grey-50': document.getElementById('theme-color-grey-50').value,
        'color-yellow': document.getElementById('theme-color-yellow').value,
        'color-green': document.getElementById('theme-color-green').value,
        'font-display': document.getElementById('theme-font-display').value,
        'font-heading': document.getElementById('theme-font-display').value,
        'font-body': document.getElementById('theme-font-body').value,
        'font-mono': document.getElementById('theme-font-mono').value,
        'text-base': (Number(document.getElementById('theme-text-base').value) || 16) + 'px',
        'text-lg': (Number(document.getElementById('theme-text-lg').value) || 20) + 'px',
        'text-4xl': (Number(document.getElementById('theme-text-4xl').value) || 56) + 'px',
    };
}

function applyThemeEditor() {
    ThemeEngine.activate({
        id: 'custom-local',
        name: '本地自定义主题',
        author: 'Local',
        type: 'custom',
        tokens: collectThemeEditorTokens(),
        customCSS: '',
    });
}

function normalizeThemePayload(theme) {
    if (!theme || typeof theme !== 'object') throw new Error('主题文件格式无效');
    var normalized = ThemeEngine && ThemeEngine._normalizeThemePayload
        ? ThemeEngine._normalizeThemePayload(theme, 'import')
        : theme;
    normalized.id = normalized.id || ('local-' + Date.now());
    normalized.name = normalized.name || '本地主题';
    normalized.author = normalized.author || 'Local';
    normalized.type = normalized.type || 'custom';
    return normalized;
}

async function installThemeFile(file) {
    if (!file) return;
    var lower = file.name.toLowerCase();
    if (!lower.endsWith('.pulse-theme') && !lower.endsWith('.json')) {
        showToast('仅支持 .pulse-theme 或 JSON 主题文件', 'error');
        return;
    }
    if (lower.endsWith('.pulse-theme')) {
        try {
            var formData = new FormData();
            formData.append('file', file);
            var resp = await fetch(apiUrl('/api/theme/import'), {
                method: 'POST',
                body: formData,
            });
            var result = await resp.json();
            if (!resp.ok || result.status !== 'ok') {
                throw new Error(result.detail || 'theme import failed');
            }
            ThemeEngine.install(normalizeThemePayload(result.theme));
        } catch (e) {
            showToast('主题安装失败: ' + e.message, 'error');
        }
        return;
    }
    var reader = new FileReader();
    reader.onload = function() {
        try {
            var theme = normalizeThemePayload(JSON.parse(String(reader.result || '{}')));
            ThemeEngine.install(theme);
        } catch (e) {
            showToast('主题安装失败: ' + e.message, 'error');
        }
    };
    reader.onerror = function() {
        showToast('主题文件读取失败', 'error');
    };
    reader.readAsText(file, 'utf-8');
}

function exportThemeFile() {
    var active = ThemeEngine && ThemeEngine.installedThemes[ThemeEngine.activeThemeId];
    if (!active) {
        var activeId = ThemeEngine ? ThemeEngine.activeThemeId : null;
        active = {
            id: activeId || 'custom-' + new Date().toISOString().slice(0, 10),
            name: 'Pulse Custom Theme',
            author: 'Local',
            type: 'custom',
            schemaVersion: 3,
            tokens: collectThemeEditorTokens(),
            legacyTokens: null,
            customCSS: ''
        };
    }
    var normalized = ThemeEngine && ThemeEngine._normalizeThemePayload
        ? ThemeEngine._normalizeThemePayload(active, 'export')
        : {
            id: active.id || ('custom-' + new Date().toISOString().slice(0, 10)),
            name: active.name || 'Pulse Custom Theme',
            author: active.author || 'Local',
            type: active.type || 'custom',
            schemaVersion: 3,
            tokens: collectThemeEditorTokens(),
            legacyTokens: active.legacyTokens || null,
            customCSS: active.customCSS || ''
        };
    var exportPayload = {
        id: normalized.id,
        name: normalized.name || 'Pulse Custom Theme',
        author: normalized.author || 'Local',
        type: normalized.type || 'custom',
        schemaVersion: 3,
        legacyCompatible: !!normalized.legacyCompatible,
        tokens: normalized.tokens,
        legacyTokens: normalized.legacyTokens || null,
        customCSS: normalized.customCSS || '',
    };
    var blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (normalized.id || 'pulse-custom-theme') + '.pulse-theme';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function initThemeTools() {
    var drop = document.getElementById('themeDropZone');
    var input = document.getElementById('themeFileInput');
    var importBtn = document.getElementById('themeImportBtn');
    var exportBtn = document.getElementById('themeExportBtn');
    var resetBtn = document.getElementById('themeResetBtn');
    if (importBtn && input) {
        importBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            input.click();
        });
    }
    if (input) {
        input.addEventListener('change', function() {
            if (input.files && input.files[0]) installThemeFile(input.files[0]);
            input.value = '';
        });
    }
    if (drop) {
        drop.addEventListener('click', function() {
            if (input) input.click();
        });
        drop.addEventListener('dragover', function(e) {
            e.preventDefault();
            drop.classList.add('drag-over');
        });
        drop.addEventListener('dragleave', function() {
            drop.classList.remove('drag-over');
        });
        drop.addEventListener('drop', function(e) {
            e.preventDefault();
            drop.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                installThemeFile(e.dataTransfer.files[0]);
            }
        });
    }
    document.querySelectorAll('#themeEditor input').forEach(function(el) {
        el.addEventListener('input', applyThemeEditor);
    });
    if (exportBtn) exportBtn.addEventListener('click', exportThemeFile);
    if (resetBtn) resetBtn.addEventListener('click', function() {
        ThemeEngine.resetToDefault();
    });
}

// ══════════════════════════════════════════════════
//  Marketplace (M6.5)
// ══════════════════════════════════════════════════

function _renderMarketplaceCard(t) {
    var item = document.createElement('div');
    item.className = 'marketplace-item';
    item.setAttribute('data-theme-id', t.id);

    var badgeText = (t.price > 0) ? '¥' + Number(t.price).toFixed(2) : '免费';
    var badgeClass = (t.price > 0) ? 'paid' : 'free';
    var typeLabel = t.type === 'official' ? '官方' : (t.type === 'community' ? '社区' : (t.type || (t.price > 0 ? '官方' : '社区')));

    item.innerHTML =
        '<div class="marketplace-preview" style="background:' + (t.previewColor || '#000') + ';border:1px solid #333;">' +
            '<span style="font-size:24px;color:' + (t.previewIconColor || '#666') + ';">' + (t.previewIcon || '★') + '</span>' +
        '</div>' +
        '<div class="marketplace-info">' +
            '<div class="marketplace-name">' + escapeHtml(t.name) + '</div>' +
            '<div class="marketplace-author">' + escapeHtml(t.author || '未知') + ' · ' + typeLabel + '</div>' +
            '<div class="marketplace-badge ' + badgeClass + '">' + badgeText + '</div>' +
        '</div>';

    item.addEventListener('click', function() { showThemeDetail(t); });
    return item;
}

function _renderMarketplaceGrid(themes, grid, status, empty) {
    grid.innerHTML = '';
    if (!Array.isArray(themes) || themes.length === 0) {
        if (status) status.classList.add('hidden');
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (status) { status.classList.add('hidden'); status.textContent = ''; }
    if (empty) empty.classList.add('hidden');
    for (var i = 0; i < themes.length; i++) {
        grid.appendChild(_renderMarketplaceCard(themes[i]));
    }
}

async function loadMarketplace() {
    var grid = document.getElementById('marketplace-grid');
    var status = document.getElementById('marketplace-status');
    var empty = document.getElementById('marketplace-empty');
    if (!grid) return;

    try {
        var resp = await storeFetch('/v1/themes');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var themes = await resp.json();
        _renderMarketplaceGrid(themes, grid, status, empty);
    } catch (e) {
        console.info('[Marketplace] Store offline:', e.message);
        showStoreOffline(status, e.storeOffline ? STORE_OFFLINE_MESSAGE : ('无法连接主题商店 (' + e.message + ')'));
        showOfflineMarketplace(grid, status, empty);
    }
}

function showOfflineMarketplace(grid, status, empty) {
    if (!grid) return;
    grid.innerHTML = '';
    var fallbackThemes = [
        { id: 'builtin-constructivist', name: '苏维埃全主义构成', author: 'Pulse Team', type: '官方', price: 0, previewIcon: '★', previewColor: '#000', previewIconColor: '#CC0000' }
    ];
    for (var i = 0; i < fallbackThemes.length; i++) {
        var t = fallbackThemes[i];
        var item = document.createElement('div');
        item.className = 'marketplace-item';
        item.innerHTML =
            '<div class="marketplace-preview" style="background:' + t.previewColor + ';border:1px solid #333;">' +
                '<span style="font-size:24px;color:' + t.previewIconColor + ';">' + t.previewIcon + '</span>' +
            '</div>' +
            '<div class="marketplace-info">' +
                '<div class="marketplace-name">' + t.name + '</div>' +
                '<div class="marketplace-author">' + t.author + ' &middot; ' + t.type + '</div>' +
                '<div class="marketplace-badge free">免费</div>' +
            '</div>';
        grid.appendChild(item);
    }
    if (status) {
        status.textContent = '主题商店离线，显示本地可用主题。远端市场需要启动 127.0.0.1:8081。';
        status.style.color = 'var(--color-yellow)';
    }
}

var _currentDetailTheme = null;

function showThemeDetail(theme) {
    _currentDetailTheme = theme;
    var overlay = document.getElementById('theme-detail-overlay');
    if (!overlay) return;
    var nameEl = document.getElementById('theme-detail-name');
    var authorEl = document.getElementById('theme-detail-author');
    var descEl = document.getElementById('theme-detail-desc');
    var priceEl = document.getElementById('theme-detail-price');
    var buyBtn = document.getElementById('theme-detail-buy-btn');
    var installBtn = document.getElementById('theme-detail-install-btn');
    var restoreBtn = document.getElementById('theme-detail-restore-btn');

    if (nameEl) nameEl.textContent = theme.name;
    if (authorEl) authorEl.innerHTML = (theme.author || '未知') + ' &middot; ' + (theme.type || '官方');
    if (descEl) descEl.textContent = theme.description || '暂无描述';
    if (priceEl) priceEl.textContent = theme.price > 0 ? '¥' + theme.price.toFixed(2) : '免费';

    var installed = ThemeEngine.isInstalled(theme.id);
    if (buyBtn) {
        buyBtn.style.display = (theme.price > 0 && !installed) ? 'inline-block' : 'none';
        buyBtn.onclick = function() { buyTheme(theme); };
    }
    if (installBtn) {
        installBtn.style.display = (theme.price === 0 || installed) ? 'inline-block' : 'none';
        installBtn.textContent = installed ? '安装' : '免费安装';
        installBtn.onclick = function() { installTheme(theme); };
    }
    if (restoreBtn) {
        restoreBtn.style.display = 'inline-block';
        restoreBtn.onclick = function() { showRestoreOverlay(); };
    }
    overlay.classList.remove('hidden');
}

function closeThemeDetail() {
    var overlay = document.getElementById('theme-detail-overlay');
    if (overlay) overlay.classList.add('hidden');
    _currentDetailTheme = null;
}

var _purchaseTimer = null;

async function buyTheme(theme) {
    var purchaseOverlay = document.getElementById('purchase-overlay');
    if (!purchaseOverlay) return;
    closeThemeDetail();
    document.getElementById('purchase-step-email').classList.remove('hidden');
    document.getElementById('purchase-step-qr').classList.add('hidden');
    document.getElementById('purchase-submit-btn').disabled = false;
    document.getElementById('purchase-submit-btn').textContent = '确认购买';
    document.getElementById('purchase-email').value = '';
    purchaseOverlay.classList.remove('hidden');

    var submitBtn = document.getElementById('purchase-submit-btn');
    var newBtn = submitBtn.cloneNode(true);
    submitBtn.parentNode.replaceChild(newBtn, submitBtn);

    newBtn.addEventListener('click', async function() {
        var email = document.getElementById('purchase-email').value.trim();
        if (!email) {
            showToast('请输入邮箱地址', 'error');
            return;
        }
        var payment = document.getElementById('purchase-payment').value;
        newBtn.disabled = true;
        newBtn.textContent = '处理中...';
        try {
            var resp = await storeFetch('/v1/themes/' + theme.id + '/buy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, payment: payment })
            });
            if (!resp.ok) {
                var errData = await resp.json().catch(function() { return {}; });
                throw new Error(errData.detail || '购买失败');
            }
            var result = await resp.json();
            document.getElementById('purchase-step-email').classList.add('hidden');
            document.getElementById('purchase-step-qr').classList.remove('hidden');
            var paymentLabel = document.getElementById('purchase-payment-label');
            if (paymentLabel) paymentLabel.textContent = payment === 'wechat' ? '微信' : '支付宝';
            var qrImg = document.getElementById('purchase-qr-img');
            if (qrImg && (result.qr_code || result.qr_code_url)) {
                qrImg.src = result.qr_code || result.qr_code_url;
            }
            var purchaseId = result.purchase_id || result.id;
            if (purchaseId) {
                pollPaymentStatus(purchaseId, theme);
            }
        } catch (e) {
            showToast(e.storeOffline ? STORE_OFFLINE_MESSAGE : ('购买错误: ' + e.message), 'error');
            newBtn.disabled = false;
            newBtn.textContent = '确认购买';
        }
    });
}

function pollPaymentStatus(purchaseId, theme) {
    if (_purchaseTimer) {
        clearInterval(_purchaseTimer);
        _purchaseTimer = null;
    }
    var statusEl = document.getElementById('purchase-status');
    _purchaseTimer = setInterval(async function() {
        try {
            var resp = await storeFetch('/v1/purchases/' + purchaseId);
            if (!resp.ok) return;
            var result = await resp.json();
            if (result.status === 'completed' || result.status === 'paid') {
                clearInterval(_purchaseTimer);
                _purchaseTimer = null;
                if (statusEl) statusEl.textContent = '支付成功！正在安装主题...';
                ThemeEngine.install(theme);
                setTimeout(function() {
                    document.getElementById('purchase-overlay').classList.add('hidden');
                }, 1000);
            } else if (result.status === 'failed' || result.status === 'expired') {
                clearInterval(_purchaseTimer);
                _purchaseTimer = null;
                if (statusEl) statusEl.textContent = '支付失败或已过期';
                showToast('支付失败', 'error');
            } else {
                if (statusEl) statusEl.textContent = '等待支付... (' + (result.status || 'pending') + ')';
            }
        } catch (e) {
            console.warn('[Purchase] Poll error:', e);
            if (statusEl && e.storeOffline) statusEl.textContent = STORE_OFFLINE_MESSAGE;
        }
    }, 3000);
}

function cancelPurchase() {
    if (_purchaseTimer) {
        clearInterval(_purchaseTimer);
        _purchaseTimer = null;
    }
    document.getElementById('purchase-overlay').classList.add('hidden');
    document.getElementById('purchase-step-email').classList.remove('hidden');
    document.getElementById('purchase-step-qr').classList.add('hidden');
}

async function installTheme(theme) {
    closeThemeDetail();
    try {
        var resp = await storeFetch('/v1/themes/' + theme.id);
        if (resp.ok) {
            var fullTheme = await resp.json();
            ThemeEngine.install(fullTheme);
            return;
        }
    } catch (e) {
        console.warn('[Install] Cannot fetch theme from store:', e);
    }
    if (theme.id === 'builtin-constructivist') {
        var legacy = ThemeEngine._getBuiltinById('builtin-constructivist');
        if (legacy) {
            ThemeEngine.install(legacy);
            return;
        }
        showToast('无法获取内置 legacy 主题', 'error');
        return;
    }
    showToast('无法获取主题文件。' + STORE_OFFLINE_MESSAGE, 'error');
}

// ══════════════════════════════════════════════════
//  Restore Purchases (M6.5)
// ══════════════════════════════════════════════════

function showRestoreOverlay() {
    closeThemeDetail();
    var overlay = document.getElementById('restore-overlay');
    if (!overlay) return;
    document.getElementById('restore-step-email').classList.remove('hidden');
    document.getElementById('restore-step-verify').classList.add('hidden');
    document.getElementById('restore-step-list').classList.add('hidden');
    document.getElementById('restore-email').value = '';
    document.getElementById('restore-code').value = '';
    overlay.classList.remove('hidden');
}

function closeRestoreOverlay() {
    document.getElementById('restore-overlay').classList.add('hidden');
}

async function sendRestoreCode() {
    var email = document.getElementById('restore-email').value.trim();
    if (!email) {
        showToast('请输入邮箱地址', 'error');
        return;
    }
    var btn = document.getElementById('restore-send-code-btn');
    btn.disabled = true;
    btn.textContent = '发送中...';
    try {
        var resp = await storeFetch('/v1/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
        });
        if (!resp.ok) {
            var errData = await resp.json().catch(function() { return {}; });
            throw new Error(errData.detail || '发送失败');
        }
        document.getElementById('restore-step-email').classList.add('hidden');
        document.getElementById('restore-step-verify').classList.remove('hidden');
        showToast('验证码已发送到 ' + email, 'success');
    } catch (e) {
        showToast(e.storeOffline ? STORE_OFFLINE_MESSAGE : ('错误: ' + e.message), 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '发送验证码';
    }
}

async function verifyRestoreCode() {
    var email = document.getElementById('restore-email').value.trim();
    var code = document.getElementById('restore-code').value.trim();
    if (!code) {
        showToast('请输入验证码', 'error');
        return;
    }
    var btn = document.getElementById('restore-verify-btn');
    btn.disabled = true;
    btn.textContent = '验证中...';
    try {
        var resp = await storeFetch('/v1/restore/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, code: code })
        });
        if (!resp.ok) {
            var errData = await resp.json().catch(function() { return {}; });
            throw new Error(errData.detail || '验证失败');
        }
        var result = await resp.json();
        var purchasedThemes = result.themes || [];
        document.getElementById('restore-step-verify').classList.add('hidden');
        document.getElementById('restore-step-list').classList.remove('hidden');
        var listEl = document.getElementById('restore-theme-list');
        listEl.innerHTML = '';
        if (purchasedThemes.length === 0) {
            listEl.innerHTML = '<p style="color:var(--color-grey-50);">该邮箱没有已购主题</p>';
            return;
        }
        for (var i = 0; i < purchasedThemes.length; i++) {
            var t = purchasedThemes[i];
            var item = document.createElement('div');
            item.className = 'restore-theme-item';
            item.innerHTML =
                '<div>' +
                    '<div class="restore-theme-name">' + escapeHtml(t.name) + '</div>' +
                    '<div class="restore-theme-author">' + escapeHtml(t.author || '') + '</div>' +
                '</div>' +
                '<button class="btn-primary" style="padding:6px 16px;font-size:12px;">安装</button>';
            (function(themeData) {
                item.querySelector('button').addEventListener('click', async function() {
                    ThemeEngine.install(themeData);
                    document.getElementById('restore-overlay').classList.add('hidden');
                });
            })(t);
            listEl.appendChild(item);
        }
    } catch (e) {
        showToast(e.storeOffline ? STORE_OFFLINE_MESSAGE : ('错误: ' + e.message), 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '验证';
    }
}

function initThemeSelector() {
    var sel = document.getElementById('theme-selector');
    if (!sel) return;
    sel.addEventListener('change', function() {
        var val = sel.value;
        if (ThemeEngine.installedThemes[val]) {
            var theme = ThemeEngine.installedThemes[val];
            // Local themes: load customCSS from separate file if available
            if (theme._localPath) {
                var cssPath = theme._localPath.replace('theme.json', 'custom.css');
                fetch(cssPath)
                    .then(function(r) { return r.ok ? r.text() : Promise.resolve(''); })
                    .catch(function() { return ''; })
                    .then(function(css) {
                        if (css) theme.customCSS = css;
                        ThemeEngine.activate(theme);
                    });
            } else {
                ThemeEngine.activate(theme);
            }
        }
    });
    // Populate with already-discovered local themes
    ThemeEngine._populateSelector();
}

function initMarketplaceOnTab() {
    var settingsTab = document.querySelector('[data-tab=settings]');
    if (settingsTab) {
        settingsTab.addEventListener('click', function() {
            var grid = document.getElementById('marketplace-grid');
            if (grid && grid.children.length === 0) {
                loadMarketplace();
            }
        });
    }
}

function initMarketplaceOverlayButtons() {
    var closeBtn = document.getElementById('theme-detail-close');
    if (closeBtn) closeBtn.addEventListener('click', closeThemeDetail);
    var cancelBtn = document.getElementById('purchase-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelPurchase);
    var restoreCloseBtn = document.getElementById('restore-close-btn');
    if (restoreCloseBtn) restoreCloseBtn.addEventListener('click', closeRestoreOverlay);
    var sendCodeBtn = document.getElementById('restore-send-code-btn');
    if (sendCodeBtn) sendCodeBtn.addEventListener('click', sendRestoreCode);
    var verifyBtn = document.getElementById('restore-verify-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyRestoreCode);

    document.querySelectorAll('.overlay').forEach(function(el) {
        el.addEventListener('click', function(e) {
            if (e.target === el) {
                el.classList.add('hidden');
                if (el.id === 'purchase-overlay') cancelPurchase();
            }
        });
    });
}

function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// --- Devices ---
function loadDevices() {
  var c = document.getElementById("device-list");
  if (!c) return;
  c.innerHTML = "<div class=loading-spinner></div>";
  fetch(apiUrl("/api/devices")).then(function(r) { return r.json(); }).then(function(devices) {
    if (!devices || devices.length === 0) {
      c.innerHTML = "<div class=empty-state><div class=icon>No Devices</div><div class=text>Click above to add your first device</div></div>";
      return;
    }
    c.innerHTML = "";
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      var card = document.createElement("div");
      card.className = "device-card";
      card.innerHTML =
        "<div class=device-info>" +
          "<div class=device-name><span class=device-status " + (d.enabled ? "online" : "offline") + "></span>" + escapeHtml(d.name) + "</div>" +
          "<div class=device-host>" + escapeHtml(d.host) + ":" + (d.port || 135) + "</div>" +
        "</div>" +
        "<div class=device-actions>" +
          "<button class=\"btn-secondary device-delete-btn\" type=\"button\">DELETE</button>" +
        "</div>";
      (function(deviceId) {
        var btn = card.querySelector('.device-delete-btn');
        if (btn) btn.addEventListener('click', function() { deleteDevice(deviceId); });
      })(d.id);
      c.appendChild(card);
    }
  }).catch(function(e) {
    c.innerHTML = "<div class=empty-state>Failed to load devices</div>";
  });
}

async function loadLanHardwareDevices() {
  var scroll = document.getElementById("hwLanScroll");
  var empty = document.getElementById("hwLanEmpty");
  if (!scroll) return;
  scroll.innerHTML = "<div class=loading-spinner></div>";
  try {
    var resp = await fetch(apiUrl("/api/lan/devices"));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var devices = await resp.json();
    if (!Array.isArray(devices) || devices.length === 0) {
      scroll.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");
    scroll.innerHTML = "";
    devices.forEach(function(device) {
      var metrics = splitMetrics(device.shared_metrics);
      var card = document.createElement("button");
      card.type = "button";
      card.className = "hw-lan-device-card";
      card.innerHTML =
        '<div class="hw-lan-device-head">' +
          '<span class="hw-lan-device-name">' + escapeHtml(device.name || device.device_id || "LAN Device") + '</span>' +
          '<span class="hw-lan-device-status ' + (device.online ? "online" : "offline") + '">' + (device.online ? "在线" : "离线") + '</span>' +
        '</div>' +
        '<div class="hw-lan-device-ip">' + escapeHtml(device.ip || "-") + '</div>' +
        '<div class="hw-lan-device-metrics">' + escapeHtml(metrics.length ? metrics.slice(0, 4).join("/") : "未配置") + '</div>' +
        '<div class="hw-lan-device-foot">点击查看详情</div>';
      card.addEventListener("click", function() { showLanDeviceDrawer(device); });
      scroll.appendChild(card);
    });
  } catch (e) {
    scroll.innerHTML = "";
    if (empty) {
      empty.textContent = "LAN 设备加载失败";
      empty.classList.remove("hidden");
    }
  }
}

function showLanDeviceDrawer(device) {
  var drawer = document.getElementById("lan-device-drawer");
  if (!drawer) {
    drawer = document.createElement("div");
    drawer.id = "lan-device-drawer";
    drawer.className = "lan-device-drawer hidden";
    document.body.appendChild(drawer);
  }
  destroyLanDrawerCharts();
  var metrics = splitMetrics(device.shared_metrics);
  var metricSet = {};
  metrics.forEach(function(m) { metricSet[m] = true; });
  var lanMetrics = getLanDeviceMetrics(device);
  drawer.innerHTML =
    '<div class="lan-drawer-panel">' +
      '<div class="lan-drawer-header">' +
        '<div><div class="lan-drawer-title">' + escapeHtml(device.name || device.device_id || "LAN Device") + '</div>' +
        '<div class="lan-drawer-subtitle">' + escapeHtml(device.ip || "-") + ' · ' + escapeHtml(device.online ? "在线" : "离线") + '</div></div>' +
        '<button class="btn-secondary" id="lan-device-drawer-close" type="button">×</button>' +
      '</div>' +
      '<div class="lan-drawer-meta">' +
        '<span>LAST UPDATE <strong>' + escapeHtml(formatImportTime(device.last_seen || device.updated_at || device.created_at)) + '</strong></span>' +
        '<span>TRUST <strong>' + (Number(device.persistent_trust) ? "PERSISTENT" : "TEMP") + '</strong></span>' +
      '</div>' +
      '<div class="lan-drawer-chips">' + (metrics.length ? metrics.map(function(m) { return '<span>' + escapeHtml(m) + '</span>'; }).join("") : '<span>NO METRICS</span>') + '</div>' +
      '<div class="lan-drawer-grid">' +
        buildLanMetricPanel(device, "cpu", "CPU", metricSet, lanMetrics) +
        buildLanMetricPanel(device, "memory", "MEMORY", metricSet, lanMetrics) +
        buildLanMetricPanel(device, "disk", "DISK", metricSet, lanMetrics) +
        buildLanMetricPanel(device, "network", "NETWORK", metricSet, lanMetrics) +
        buildLanMetricPanel(device, "gpu", "GPU", metricSet, lanMetrics) +
        buildLanMetricPanel(device, "battery", "BATTERY", metricSet, lanMetrics) +
      '</div>' +
    '</div>';
  drawer.classList.remove("hidden");
  drawer.querySelector("#lan-device-drawer-close").onclick = closeLanDeviceDrawer;
  drawer.addEventListener("click", function(e) {
    if (e.target === drawer) closeLanDeviceDrawer();
  }, { once: true });
  renderLanDrawerCharts(device, metricSet, lanMetrics);
}

function closeLanDeviceDrawer() {
  destroyLanDrawerCharts();
  var drawer = document.getElementById("lan-device-drawer");
  if (drawer) drawer.classList.add("hidden");
}

function getLanDeviceMetrics(device) {
  return device.metrics || device.data || device.snapshot || {};
}

function buildLanMetricPanel(device, key, title, metricSet, data) {
  data = data || getLanDeviceMetrics(device);
  var authorized = !!metricSet[key];
  var hasData = authorized && !!data[key];
  return '<div class="lan-metric-panel">' +
    '<div class="lan-metric-title">' + title + '</div>' +
    (hasData ? '<canvas id="lan-chart-' + key + '"></canvas>' : '<div class="lan-metric-empty">' + (authorized ? "暂无数据" : "未授权") + '</div>') +
  '</div>';
}

function renderLanDrawerCharts(device, metricSet, data) {
  data = data || getLanDeviceMetrics(device);
  if (metricSet.cpu && data.cpu && document.getElementById("lan-chart-cpu")) {
    var cpu = Number(data.cpu.percent) || 0;
    createLanDrawerChart("cpu", "doughnut", ["CPU", "IDLE"], [cpu, Math.max(0, 100 - cpu)]);
  }
  if (metricSet.memory && data.memory && document.getElementById("lan-chart-memory")) {
    var used = Number(data.memory.used_gb || data.memory.used || data.memory.percent) || 0;
    var total = Number(data.memory.total_gb || data.memory.total) || 100;
    createLanDrawerChart("memory", "doughnut", ["USED", "FREE"], [used, Math.max(0, total - used)]);
  }
  if (metricSet.disk && data.disk && document.getElementById("lan-chart-disk")) {
    var disks = Array.isArray(data.disk) ? data.disk : [data.disk];
    createLanDrawerChart("disk", "bar", disks.map(function(d) { return d.mount || d.device || d.mountpoint || "DISK"; }), disks.map(function(d) { return Number(d.percent) || 0; }));
  }
  if (metricSet.network && data.network && document.getElementById("lan-chart-network")) {
    createLanDrawerChart("network", "bar", ["RECV", "SENT"], [Number(data.network.recv_bytes_per_sec) || 0, Number(data.network.sent_bytes_per_sec) || 0]);
  }
  if (metricSet.gpu && data.gpu && document.getElementById("lan-chart-gpu")) {
    var temp = Number(data.gpu.temperature || data.gpu.temp || 0);
    createLanDrawerChart("gpu", "doughnut", ["TEMP", "HEADROOM"], [temp, Math.max(0, 100 - temp)]);
  }
  if (metricSet.battery && data.battery && document.getElementById("lan-chart-battery")) {
    var pct = Number(data.battery.percent || data.battery.percentage || 0);
    createLanDrawerChart("battery", "doughnut", ["BATTERY", "EMPTY"], [pct, Math.max(0, 100 - pct)]);
  }
}

function createLanDrawerChart(key, type, labels, values) {
  var canvas = document.getElementById("lan-chart-" + key);
  if (!canvas) return;
  var options = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  };
  if (type === "bar") {
    options.scales = {
      x: { ticks: { color: chartColors.grey, font: { family: "'JetBrains Mono', monospace", size: 9 } }, grid: { color: chartColors.grid } },
      y: { min: 0, max: key === "network" ? undefined : 100, ticks: { color: chartColors.grey }, grid: { color: chartColors.grid } },
    };
  } else {
    options.cutout = "68%";
  }
  if (!state.lanDrawerCharts) state.lanDrawerCharts = {};
  state.lanDrawerCharts[key] = new Chart(canvas, {
    type: type,
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: type === "bar" ? chartColors.red : [chartColors.red, chartColors.grid],
        borderColor: chartColors.white,
        borderWidth: type === "bar" ? 1 : 0,
        borderRadius: 0,
      }],
    },
    options: options,
  });
}

function destroyLanDrawerCharts() {
  if (!state.lanDrawerCharts) return;
  Object.keys(state.lanDrawerCharts).forEach(function(key) {
    if (state.lanDrawerCharts[key]) state.lanDrawerCharts[key].destroy();
  });
  state.lanDrawerCharts = {};
}

function deleteDevice(id) {
  if (!confirm("Delete this device?")) return;
  fetch(apiUrl("/api/devices/" + id), {method:"DELETE"}).then(function() {
    showToast("Device deleted","success");
    loadDevices();
  });
}

function initDeviceForm() {
  var form = document.getElementById("device-form");
  if (!form) return;
  form.onsubmit = function(e) {
    e.preventDefault();
    var payload = {
      name: document.getElementById("device-name").value,
      host: document.getElementById("device-host").value,
      username: document.getElementById("device-username").value,
      password: document.getElementById("device-password").value,
      port: parseInt(document.getElementById("device-port").value) || 135,
      enabled: document.getElementById("device-enabled").checked,
    };
    fetch(apiUrl("/api/devices"), {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload),
    }).then(function(r) {
      if (r.ok) {
        showToast("Device added","success");
        document.getElementById("device-form-overlay").classList.add("hidden");
        loadDevices();
      } else showToast("Save failed","error");
    }).catch(function(e) { showToast("Error","error"); });
  };
  var cancelBtn = document.getElementById("device-form-cancel");
  if (cancelBtn) cancelBtn.onclick = function() {
    document.getElementById("device-form-overlay").classList.add("hidden");
  };
  var addButtons = [
    document.getElementById("hwAddDeviceBtn"),
  ].filter(Boolean);
  addButtons.forEach(function(btn) {
    btn.onclick = function() {
      document.getElementById("device-form-overlay").classList.remove("hidden");
    };
  });
}

// --- Plugins ---
async function loadPlugins() {
  var list = document.getElementById("plugin-list");
  var empty = document.getElementById("plugin-empty");
  if (!list) return;
  list.innerHTML = "<div class=loading-spinner></div>";
  try {
    var resp = await fetch(apiUrl("/api/plugins"));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var plugins = await resp.json();
    if (!Array.isArray(plugins) || plugins.length === 0) {
      list.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");
    list.innerHTML = "";
    for (var i = 0; i < plugins.length; i++) {
      list.appendChild(await createPluginCard(plugins[i]));
    }
  } catch (e) {
    list.innerHTML = "<div class=empty-state>插件加载失败: " + escapeHtml(e.message) + "</div>";
  }
}

async function createPluginCard(plugin) {
  var card = document.createElement("div");
  card.className = "plugin-card" + (plugin.enabled ? "" : " disabled");
  var pairedCount = "—";
  var pairedDevices = [];
  if (isLanPluginName(plugin.name)) {
    try {
      var pairedResp = await fetch(apiUrl("/api/lan/devices"));
      if (pairedResp.ok) {
        var paired = await pairedResp.json();
        pairedDevices = Array.isArray(paired) ? paired : [];
        pairedCount = pairedDevices.length;
      }
    } catch (e) {
      pairedCount = "—";
    }
  }

  card.innerHTML =
    '<div class="plugin-card-head">' +
      '<div>' +
        '<div class="plugin-title">' + escapeHtml(plugin.name || "Unknown Plugin") + '</div>' +
        '<div class="plugin-version">v' + escapeHtml(plugin.version || "0.0.0") + '</div>' +
      '</div>' +
      '<div class="plugin-status ' + (plugin.enabled ? "enabled" : "") + '">' + (plugin.enabled ? "已启用" : "未启用") + '</div>' +
    '</div>' +
    '<div class="plugin-desc">' + escapeHtml(plugin.description || "无描述") + '</div>' +
    '<div class="plugin-meta">已配对设备 <strong>' + pairedCount + '</strong></div>' +
    (isLanPluginName(plugin.name) ? buildLanPluginDeviceList(pairedDevices) : "") +
    '<div class="plugin-actions"></div>';
  var actions = card.querySelector(".plugin-actions");
  var toggle = document.createElement("button");
  toggle.className = plugin.enabled ? "btn-secondary" : "btn-primary";
  toggle.type = "button";
  toggle.textContent = plugin.enabled ? "禁用" : "启用";
  toggle.addEventListener("click", function() {
    togglePlugin(plugin.name, !plugin.enabled);
  });
  actions.appendChild(toggle);

  if (isLanPluginName(plugin.name) && plugin.enabled) {
    var scan = document.createElement("button");
    scan.className = "btn-secondary";
    scan.type = "button";
    scan.textContent = "扫描局域网设备";
    scan.addEventListener("click", scanLanDevices);
    actions.appendChild(scan);
  }

  card.querySelectorAll(".lan-metrics-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var id = Number(btn.getAttribute("data-device-id"));
      var device = pairedDevices.find(function(d) { return Number(d.id) === id; });
      if (device) showLanMetricsConfig(device);
    });
  });

  return card;
}

function isLanPluginName(name) {
  return String(name || "").toUpperCase().indexOf("LAN") !== -1;
}

function splitMetrics(metrics) {
  if (Array.isArray(metrics)) return metrics;
  return String(metrics || "").split(",").map(function(m) { return m.trim(); }).filter(Boolean);
}

function buildLanPluginDeviceList(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return '<div class="lan-paired-list"><div class="lan-paired-title">已配对设备</div><div class="lan-device-empty">暂无配对设备</div></div>';
  }
  var html = '<div class="lan-paired-list"><div class="lan-paired-title">已配对设备</div>';
  devices.forEach(function(d) {
    var metrics = splitMetrics(d.shared_metrics);
    var trust = Number(d.persistent_trust) ? "持久信任" : "临时信任";
    html += '<div class="lan-paired-row">' +
      '<div class="lan-paired-main">' +
        '<div class="lan-paired-name">' + escapeHtml(d.name || d.device_id || "LAN Device") + '</div>' +
        '<div class="lan-paired-ip">' + escapeHtml(d.ip || "") + ' · ' + escapeHtml(d.online ? "在线" : "离线") + ' · ' + escapeHtml(trust) + '</div>' +
        '<div class="lan-paired-metrics">' + escapeHtml(metrics.length ? metrics.join("/") : "未配置指标") + '</div>' +
      '</div>' +
      '<button class="btn-secondary lan-metrics-btn" type="button" data-device-id="' + escapeHtml(String(d.id || "")) + '">配置指标</button>' +
    '</div>';
  });
  html += '</div>';
  return html;
}

function showLanMetricsConfig(device) {
  var overlay = document.getElementById("lan-metrics-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "lan-metrics-overlay";
    overlay.className = "overlay hidden";
    document.body.appendChild(overlay);
  }
  var options = ["cpu", "memory", "disk", "network", "gpu", "battery", "processes"];
  var selected = splitMetrics(device.shared_metrics);
  overlay.innerHTML = '<div class="overlay-content lan-metrics-panel">' +
    '<div class="overlay-header"><h1>共享指标配置</h1><button class="btn-secondary" id="lan-metrics-close" type="button">×</button></div>' +
    '<div class="lan-metrics-device">' + escapeHtml(device.name || device.device_id || "LAN Device") + ' · ' + escapeHtml(device.ip || "") + '</div>' +
    '<div class="lan-metrics-options">' + options.map(function(opt) {
      var checked = selected.indexOf(opt) !== -1 ? " checked" : "";
      return '<label><input type="checkbox" value="' + opt + '"' + checked + '> <span>' + opt + '</span></label>';
    }).join("") + '</div>' +
    '<div class="modal-actions"><button class="btn-secondary" id="lan-metrics-cancel" type="button">取消</button><button class="btn-primary" id="lan-metrics-save" type="button">保存</button></div>' +
  '</div>';
  overlay.classList.remove("hidden");
  overlay.querySelector("#lan-metrics-close").onclick = function() { overlay.classList.add("hidden"); };
  overlay.querySelector("#lan-metrics-cancel").onclick = function() { overlay.classList.add("hidden"); };
  overlay.onclick = function(e) { if (e.target === overlay) overlay.classList.add("hidden"); };
  overlay.querySelector("#lan-metrics-save").onclick = async function() {
    var values = Array.from(overlay.querySelectorAll('input[type="checkbox"]:checked')).map(function(input) { return input.value; });
    if (!values.length) {
      showToast("至少选择一个共享指标", "error");
      return;
    }
    try {
      var resp = await fetch(apiUrl("/api/lan/devices/" + encodeURIComponent(device.id) + "/metrics"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metrics: values.join(",") }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      overlay.classList.add("hidden");
      showToast("共享指标已保存", "success");
      await Promise.all([loadPlugins(), loadLanHardwareDevices()]);
    } catch (e) {
      showToast("保存共享指标失败: " + e.message, "error");
    }
  };
}
async function togglePlugin(name, enable) {
  try {
    var action = enable ? "enable" : "disable";
    var resp = await fetch(apiUrl("/api/plugins/" + encodeURIComponent(name) + "/" + action), {
      method: "POST",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    showToast(enable ? "插件已启用" : "插件已禁用", "success");
    await loadPlugins();
  } catch (e) {
    showToast("插件操作失败: " + e.message, "error");
  }
}

async function scanLanDevices() {
  showLanScan();
}

// ── Theme Marketplace Popup ────────────────────────────
function showThemeMarketplace() {
    var overlay = document.getElementById('theme-marketplace-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    var grid = document.getElementById('theme-marketplace-grid');
    var status = document.getElementById('theme-marketplace-status');
    if (grid && status) {
        grid.innerHTML = '';
        loadMarketplaceToGrid(grid, status, document.getElementById('theme-marketplace-empty'));
    }
}
async function loadMarketplaceToGrid(grid, status, empty) {
    status.textContent = '加载中...';
    try {
        var resp = await storeFetch('/v1/themes');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var themes = await resp.json();
        _renderMarketplaceGrid(themes, grid, status, empty);
        if (themes.length) status.textContent = themes.length + ' 个主题可用';
    } catch (e) {
        showStoreOffline(status, e.storeOffline ? STORE_OFFLINE_MESSAGE : '商店暂不可用（离线模式）');
        if (empty) empty.classList.remove('hidden');
    }
}
document.addEventListener('click', function(e) {
    if (e.target.id === 'theme-marketplace-close') {
        var overlay = document.getElementById('theme-marketplace-overlay');
        if (overlay) overlay.classList.add('hidden');
    }
});

// ── LAN Scan Popup ─────────────────────────────────────
function showLanScan() {
    var overlay = document.getElementById('lan-scan-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    var results = document.getElementById('lan-scan-results');
    var status = document.getElementById('lan-scan-status');
    var timerEl = document.getElementById('lan-scan-timer');
    var empty = document.getElementById('lan-scan-empty');
    if (results) results.innerHTML = '';
    if (empty) empty.classList.add('hidden');
    var remaining = 5;
    if (timerEl) timerEl.textContent = remaining;
    if (status) status.innerHTML = '正在扫描... <span id="lan-scan-timer">5</span>秒';
    var timer = setInterval(function() {
        remaining = Math.max(0, remaining - 1);
        var currentTimer = document.getElementById('lan-scan-timer');
        if (currentTimer) currentTimer.textContent = remaining;
    }, 1000);

    fetch(apiUrl('/api/lan/discover?timeout=5'), { method: 'POST' }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }).then(function(data) {
        clearInterval(timer);
        if (status) status.innerHTML = '扫描完成 · <a href="#" onclick="showLanScan();return false" style="color:var(--color-red);">重新扫描</a>';
        var devices = data.devices || [];
        if (results) results.innerHTML = '';
        if (!devices.length) {
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');
        devices.forEach(function(d) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px;border:1px solid var(--color-grey-30);background:var(--color-black);';
            row.innerHTML = '<div><div style="font-family:var(--font-mono);font-size:14px;">' + escapeHtml(d.name || d.hostname) + '</div>' +
                '<div style="font-size:11px;color:var(--color-grey-50);">' + escapeHtml(d.ip) + '</div></div>' +
                '<button class="btn-secondary" style="min-height:36px;font-size:12px;" onclick="requestPair(\'' + escapeHtml(d.ip) + '\')">配对</button>';
            results.appendChild(row);
        });
    }).catch(function(e) {
        clearInterval(timer);
        if (status) status.textContent = '扫描失败，请确认 LAN 插件已启用';
        if (empty) empty.classList.remove('hidden');
    });
}
document.addEventListener('click', function(e) {
    if (e.target.id === 'lan-scan-close') {
        var overlay = document.getElementById('lan-scan-overlay');
        if (overlay) overlay.classList.add('hidden');
    }
});
async function requestPair(ip) {
    try {
        showToast('Requesting pair with ' + ip + '...', 'info');
        var resp = await fetch(apiUrl('/api/lan/pair-request'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip, name: ip }),
        });
        var result = await resp.json();
        if (!resp.ok || result.status === 'error') {
            throw new Error(result.detail || result.message || 'pair request failed');
        }
        if (result.status === 'already_paired') {
            showToast('Device already paired', 'info');
        } else if (result.status === 'approved') {
            showToast('Device approved by persistent trust', 'success');
        } else {
            showToast('Pair request sent', 'success');
        }
        if (typeof loadPlugins === 'function') loadPlugins();
    } catch (e) {
        showToast('Pair request failed: ' + e.message, 'error');
    }
}

function initPairingOverlay() {
    var overlay = document.getElementById('pair-overlay');
    var persistent = document.getElementById('pair-persistent');
    var pinGroup = document.getElementById('pair-pin-group');
    var pinInput = document.getElementById('pair-pin-input');
    var approve = document.getElementById('pair-approve-btn');
    var reject = document.getElementById('pair-reject-btn');
    if (persistent && pinGroup) {
        persistent.addEventListener('change', function() {
            pinGroup.classList.toggle('hidden', !persistent.checked);
        });
    }
    if (approve) {
        approve.addEventListener('click', async function() {
            if (!state.pendingPairToken) return;
            try {
                var resp = await fetch(apiUrl('/api/lan/pair-approve'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: state.pendingPairToken,
                        persistent: !!(persistent && persistent.checked),
                        pin: pinInput ? pinInput.value : '',
                    }),
                });
                var result = await resp.json();
                if (!resp.ok || result.status === 'error') {
                    throw new Error(result.detail || result.message || 'approval failed');
                }
                if (overlay) overlay.classList.add('hidden');
                state.pendingPairToken = null;
                showToast('Pair approved', 'success');
                reloadPluginUI();
            } catch (e) {
                showToast('Pair approval failed: ' + e.message, 'error');
            }
        });
    }
    if (reject) {
        reject.addEventListener('click', async function() {
            if (!state.pendingPairToken) {
                if (overlay) overlay.classList.add('hidden');
                return;
            }
            try {
                await fetch(apiUrl('/api/lan/pair-reject'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: state.pendingPairToken }),
                });
            } finally {
                if (overlay) overlay.classList.add('hidden');
                state.pendingPairToken = null;
            }
        });
    }
}

// --- Load devices on tab click ---
// --- Init Phase 4+5 ---
function initPhase45() {
  if (!document.getElementById("titlebar")) return; // skip if HTML not loaded
  initTitleBar();
  initSetupBanner();
  initSetupForm();
  initSettingsForm();
  initAutostartToggle();
  initDeviceForm();
  checkFirstRun();

  // Theme Engine + Marketplace (M4.1 / M6.5)
  ThemeEngine.init();
  initThemeTools();
  initThemeSelector();
  initMarketplaceOnTab();
  initMarketplaceOverlayButtons();
  initPairingOverlay();
  if (!document.getElementById("toast-container")) {
    var tc = document.createElement("div");
    tc.id = "toast-container";
    document.body.appendChild(tc);
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}



