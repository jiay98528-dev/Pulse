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
    analysisState: { days: 30, model: '', currentData: [], compareEnabled: false },
    config: {},
    netHistory: { timestamps: [], recv: [], sent: [] },
    lastDiskData: null,
    lastCpuPerCore: null,
    lastMemData: null,
    lastGpuTemp: null,
    lastBatteryData: null,
};

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
    layoutKey: 'pulse-widget-layout',
    _widgetCharts: {},
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
        el.setAttribute('data-id', w.id);
        el.setAttribute('draggable', 'true');

        var title = spec.name;

        // Determine if this widget needs a mini chart canvas
        var needsChart = false;
        if (w.type === 'cpu' && w.size === 'S') needsChart = true;
        if (w.type === 'memory' && w.size === 'S') needsChart = true;
        if (w.type === 'disk' && w.size === 'M') needsChart = true;
        if (w.type === 'network' && w.size === 'M') needsChart = true;

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

            var sizesStr = spec.sizes.join('/');

            item.innerHTML =
                '<span class="wli-icon">' + spec.icon + '</span>' +
                '<span class="wli-name">' + spec.name + ' (' + sizesStr + ')</span>';

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

                // Mini doughnut for S-size
                if (w.size === 'S' && mem) {
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

                // Mini horizontal bar for M-size
                if (w.size === 'M' && data.disk && data.disk.length > 0) {
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
                var bal = data.balance;
                if (bal) {
                    var balVal = bal.total_balance || bal.balance || 0;
                    valEl.textContent = formatCurrency(Number(balVal));
                    if (unitEl) unitEl.textContent = bal.currency || 'CNY';
                } else if (data.needs_config) {
                    valEl.textContent = '未配置';
                    if (unitEl) unitEl.textContent = '';
                }
                break;

            case 'tokens':
                // Token data comes from CSV import — placeholder
                if (data.total_tokens) {
                    valEl.textContent = formatNumber(data.total_tokens);
                }
                if (unitEl) unitEl.textContent = 'tokens';
                break;

            case 'cache':
                if (data.cached_tokens !== undefined) {
                    var total = (data.total_tokens || data.input_tokens || 0) + (data.output_tokens || 0);
                    var rate = total > 0 ? (data.cached_tokens / total * 100).toFixed(1) : 0;
                    valEl.textContent = rate + '%';
                    if (unitEl) unitEl.textContent = '缓存命中率';
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
        grid.addEventListener('dragover', function(e) {
            if (!self.isEditing) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });

        grid.addEventListener('drop', function(e) {
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
        });
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
    const port = loc.port || '8080';
    return `ws://${loc.hostname}:${port}/ws`;
}

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

function handleMessage(msg) {
    switch (msg.type) {
        case 'system':
            updateSystemData(msg.data);
            WidgetEngine.updateAll('system', msg.data);
            break;
        case 'deepseek':
            updateDeepseekData(msg.data);
            WidgetEngine.updateAll('deepseek', msg.data);
            if (msg.data.needs_config === true) {
                WidgetEngine.setVisibility('balance', false);
                WidgetEngine.setVisibility('tokens', false);
                WidgetEngine.setVisibility('cache', false);
                WidgetEngine.renderAll();
                WidgetEngine.saveLayout();
            }
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

    const cpu = data.cpu?.percent ?? 0;
    const mem = data.memory?.percent ?? 0;
    const disk = data.disk?.[0]?.percent ?? 0;
    const gpu = data.gpu?.[0] ? { name: data.gpu[0].name } : null;
    const temps = data.temperature;
    const netSpeed = data.network_speed;

    // ─ Update Dashboard System Bar (if present — legacy fallback) ─
    if ($('#sysCpuFill')) {
        $('#sysCpuFill').style.width = cpu + '%';
        $('#sysCpuVal').textContent = cpu.toFixed(1) + '%';
        $('#sysMemFill').style.width = mem + '%';
        $('#sysMemVal').textContent = mem.toFixed(1) + '%';
        $('#sysDiskFill').style.width = disk + '%';
        $('#sysDiskVal').textContent = disk.toFixed(1) + '%';
        $('#sysGpuFill').style.width = '0%';
        $('#sysGpuVal').textContent = gpu ? 'Active' : '—';

        // Temperature
        var tempStr = '—';
        if (temps) {
            for (var tk of Object.keys(temps)) {
                var tentries = temps[tk];
                if (tentries && tentries.length > 0) {
                    var tcur = tentries[0].current;
                    if (tcur) {
                        tempStr = tcur.toFixed(0) + '°C';
                        break;
                    }
                }
            }
        }
        $('#sysTemp').textContent = tempStr;

        // Network
        if (netSpeed) {
            var up = formatSpeed(netSpeed.sent_per_sec);
            var down = formatSpeed(netSpeed.recv_per_sec);
            $('#sysNet').textContent = '↓' + down + ' ↑' + up;
        }

        // Last update
        var ts = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        $('#sysLastUpdate').textContent = ts;
    }

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

    updateRealtimeCharts();
}

// ── Deepseek Data Update ─────────────────────────────
function updateDeepseekData(data) {
    if (!data) return;
    if (data.needs_config) {
        var tte = $('#todayTokens'); if (tte) tte.textContent = '未配置';
        var abe = $('#accountBalance'); if (abe) abe.textContent = '—';
        var tce = $('#todayCost'); if (tce) tce.textContent = '—';
        return;
    }
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
    // Keep token/cost cards showing placeholder (no auto-collected data anymore)
    var tte2 = $('#todayTokens'); if (tte2) tte2.textContent = '—';
    var tie = $('#todayInput'); if (tie) tie.textContent = '—';
    var toe = $('#todayOutput'); if (toe) toe.textContent = '—';
    var tce2 = $('#todayCached'); if (tce2) tce2.textContent = '—';
    var tce3 = $('#todayCost'); if (tce3) tce3.textContent = '—';
    var mce = $('#monthCost'); if (mce) mce.textContent = '—';
    var wce = $('#weekCost'); if (wce) wce.textContent = '—';
    var cre = $('#cacheRate'); if (cre) cre.textContent = '—';
    var ame = $('#activeModels'); if (ame) ame.textContent = '—';
    var mle = $('#modelList'); if (mle) mle.textContent = '导入CSV后显示';
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

// ── Analysis Tab ───────────────────────────────

async function loadAnalysisData() {
    const daysEl = $('#filter-days');
    const modelEl = $('#filter-model');
    const days = daysEl ? daysEl.value : '30';
    const model = modelEl ? modelEl.value : '';

    state.analysisState.days = days;
    state.analysisState.model = model;

    try {
        const summaryUrl = '/api/analysis/summary?days=' + days;
        const historyUrl = '/api/analysis/history?days=' + days + '&model=' + encodeURIComponent(model);
        const modelsUrl = '/api/analysis/models?days=' + days;

        const [summaryResp, historyResp, modelsResp] = await Promise.all([
            fetch(summaryUrl),
            fetch(historyUrl),
            fetch(modelsUrl),
        ]);

        const summaryData = summaryResp.ok ? await summaryResp.json() : {};
        const historyData = historyResp.ok ? await historyResp.json() : [];
        const modelsData = modelsResp.ok ? await modelsResp.json() : [];

        state.analysisState.currentData = historyData;

        updateSummaryCards(summaryData, modelsData);
        updateCharts(historyData, modelsData);
        updateDataTable(historyData);
    } catch (e) {
        console.warn('[Analysis] Failed to load data:', e);
    }
}

function updateSummaryCards(summary, modelsData) {
    const tokensEl = $('#kpi-total-tokens-val');
    const costEl = $('#kpi-total-cost-val');
    const cacheEl = $('#kpi-cache-rate-val');
    const modelEl = $('#kpi-primary-model-val');

    if (tokensEl) {
        tokensEl.textContent = (summary.total_tokens && summary.total_tokens > 0)
            ? formatNumber(summary.total_tokens) : '—';
    }

    if (costEl) {
        costEl.textContent = (summary.total_cost !== undefined && summary.total_cost !== null && summary.total_cost > 0)
            ? '¥' + Number(summary.total_cost).toFixed(2) : '—';
    }

    if (cacheEl) {
        if (summary.total_tokens && summary.total_tokens > 0 && summary.total_cached !== undefined) {
            const rate = (summary.total_cached / summary.total_tokens * 100).toFixed(1);
            cacheEl.textContent = rate + '%';
        } else {
            cacheEl.textContent = '—';
        }
    }

    if (modelEl) {
        if (Array.isArray(modelsData) && modelsData.length > 0) {
            // Sort by total_tokens descending, pick first
            var sorted = modelsData.slice().sort(function(a, b) {
                return (b.total_tokens || 0) - (a.total_tokens || 0);
            });
            modelEl.textContent = sorted[0].model || '—';
        } else {
            modelEl.textContent = '—';
        }
    }
}

function updateCharts(history, models) {
    // Aggregate history by date
    var dailyMap = {};
    for (var i = 0; i < history.length; i++) {
        var row = history[i];
        var date = row.date || row.timestamp || '';
        date = date.substring(0, 10);
        if (!dailyMap[date]) {
            dailyMap[date] = { total: 0, input: 0, cost: 0, count: 0 };
        }
        dailyMap[date].total += row.total_tokens || 0;
        dailyMap[date].input += row.input_tokens || 0;
        dailyMap[date].cost += row.cost || 0;
        dailyMap[date].count++;
    }

    var dates = Object.keys(dailyMap).sort();
    var totals = dates.map(function(d) { return dailyMap[d].total; });
    var inputs = dates.map(function(d) { return dailyMap[d].input; });
    var costs = dates.map(function(d) { return dailyMap[d].cost; });

    // Token Trend chart
    var tokenChart = state.charts.tokenTrend;
    if (tokenChart) {
        tokenChart.data.labels = dates;
        tokenChart.data.datasets[0].data = totals;
        tokenChart.data.datasets[1].data = inputs;
        tokenChart.update('none');
    }

    // Model Breakdown chart
    var modelChart = state.charts.modelBreakdown;
    if (modelChart) {
        var modelLabels = [];
        var modelData = [];
        if (Array.isArray(models) && models.length > 0) {
            var sortedModels = models.slice().sort(function(a, b) {
                return (b.total_tokens || 0) - (a.total_tokens || 0);
            });
            modelLabels = sortedModels.map(function(m) {
                var name = m.model || 'unknown';
                return name.length > 16 ? name.substring(0, 16) + '…' : name;
            });
            modelData = sortedModels.map(function(m) { return m.total_tokens || 0; });
        }
        modelChart.data.labels = modelLabels;
        modelChart.data.datasets[0].data = modelData;
        modelChart.update('none');
    }

    // Cache Rate chart (doughnut)
    var cacheChart = state.charts.cacheRate;
    if (cacheChart) {
        var totalTokens = 0;
        var totalCached = 0;
        for (var j = 0; j < history.length; j++) {
            totalTokens += history[j].total_tokens || 0;
            totalCached += history[j].cached_tokens || 0;
        }
        if (totalTokens > 0 && totalCached > 0) {
            cacheChart.data.datasets[0].data = [totalCached, totalTokens - totalCached];
        } else {
            cacheChart.data.datasets[0].data = [0, 100];
        }
        cacheChart.update('none');
    }

    // Cost Trend chart
    var costChart = state.charts.costTrend;
    if (costChart) {
        costChart.data.labels = dates;
        costChart.data.datasets[0].data = costs;
        costChart.update('none');
    }
}

function updateDataTable(rows) {
    var tbody = $('#analysis-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (!rows || rows.length === 0) {
        var emptyRow = document.createElement('tr');
        emptyRow.className = 'empty-row';
        emptyRow.innerHTML = '<td colspan="7">暂无数据 · 导入 CSV 后显示</td>';
        tbody.appendChild(emptyRow);
        return;
    }

    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var tr = document.createElement('tr');
        var date = (r.date || r.timestamp || '').substring(0, 10);
        var model = r.model || '—';
        var inputTokens = r.input_tokens || 0;
        var outputTokens = r.output_tokens || 0;
        var cachedTokens = r.cached_tokens || 0;
        var totalTokens = r.total_tokens || 0;
        var cost = r.cost || 0;

        tr.innerHTML =
            '<td>' + date + '</td>' +
            '<td>' + model + '</td>' +
            '<td class="num">' + formatNumber(inputTokens) + '</td>' +
            '<td class="num">' + formatNumber(outputTokens) + '</td>' +
            '<td class="num">' + formatNumber(cachedTokens) + '</td>' +
            '<td class="num">' + formatNumber(totalTokens) + '</td>' +
            '<td class="num">' + formatCurrency(cost) + '</td>';
        tbody.appendChild(tr);
    }
}

function handleCompareToggle() {
    var toggle = $('#compare-toggle');
    var enabled = toggle ? toggle.checked : false;
    state.analysisState.compareEnabled = enabled;

    var compareDates = $('#compare-dates');
    if (compareDates) {
        compareDates.classList.toggle('hidden', !enabled);
    }

    if (enabled) {
        // Set default dates to cover the current filter range
        var days = state.analysisState.days;
        var daysNum = parseInt(days, 10);
        if (isNaN(daysNum) || daysNum < 1) daysNum = 30;

        var now = new Date();
        var endA = new Date(now);
        var startA = new Date(now);
        startA.setDate(startA.getDate() - daysNum);

        var endB = new Date(startA);
        var startB = new Date(startA);
        startB.setDate(startB.getDate() - daysNum);

        var fmt = function(d) {
            var y = d.getFullYear();
            var m = String(d.getMonth() + 1).padStart(2, '0');
            var day = String(d.getDate()).padStart(2, '0');
            return y + '-' + m + '-' + day;
        };

        var aStart = $('#compare-date-a-start');
        var aEnd = $('#compare-date-a-end');
        var bStart = $('#compare-date-b-start');
        var bEnd = $('#compare-date-b-end');
        if (aStart) aStart.value = fmt(startA);
        if (aEnd) aEnd.value = fmt(endA);
        if (bStart) bStart.value = fmt(startB);
        if (bEnd) bEnd.value = fmt(endB);

        loadCompareData();
    } else {
        loadAnalysisData();
    }
}

async function loadCompareData() {
    var aStart = $('#compare-date-a-start');
    var aEnd = $('#compare-date-a-end');
    var bStart = $('#compare-date-b-start');
    var bEnd = $('#compare-date-b-end');
    var modelEl = $('#filter-model');
    var model = modelEl ? modelEl.value : '';

    if (!aStart || !aEnd || !bStart || !bEnd) return;

    var periodA = 'start=' + aStart.value + '&end=' + aEnd.value;
    var periodB = 'start=' + bStart.value + '&end=' + bEnd.value;
    var modelParam = model ? '&model=' + encodeURIComponent(model) : '';

    try {
        const [respA, respB] = await Promise.all([
            fetch('/api/analysis/history?' + periodA + modelParam),
            fetch('/api/analysis/history?' + periodB + modelParam),
        ]);

        var dataA = respA.ok ? await respA.json() : [];
        var dataB = respB.ok ? await respB.json() : [];

        renderCompareCharts(dataA, dataB);
    } catch (e) {
        console.warn('[Analysis] Compare data load failed:', e);
    }
}

function renderCompareCharts(dataA, dataB) {
    // Aggregate both datasets by date
    function aggregate(data) {
        var map = {};
        for (var i = 0; i < data.length; i++) {
            var date = (data[i].date || data[i].timestamp || '').substring(0, 10);
            if (!map[date]) map[date] = { total: 0, cost: 0 };
            map[date].total += data[i].total_tokens || 0;
            map[date].cost += data[i].cost || 0;
        }
        var keys = Object.keys(map).sort();
        return {
            labels: keys,
            totals: keys.map(function(k) { return map[k].total; }),
            costs: keys.map(function(k) { return map[k].cost; }),
        };
    }

    var aggA = aggregate(dataA);
    var aggB = aggregate(dataB);

    // Token Trend chart — dual datasets
    var tokenChart = state.charts.tokenTrend;
    if (tokenChart) {
        // Merge and sort all unique labels
        var allLabels = {};
        for (var i = 0; i < aggA.labels.length; i++) allLabels[aggA.labels[i]] = true;
        for (var j = 0; j < aggB.labels.length; j++) allLabels[aggB.labels[j]] = true;
        var sortedLabels = Object.keys(allLabels).sort();

        var dataMapA = {};
        for (var k = 0; k < aggA.labels.length; k++) {
            dataMapA[aggA.labels[k]] = aggA.totals[k];
        }
        var dataMapB = {};
        for (var l = 0; l < aggB.labels.length; l++) {
            dataMapB[aggB.labels[l]] = aggB.totals[l];
        }

        var seriesA = sortedLabels.map(function(d) { return dataMapA[d] || 0; });
        var seriesB = sortedLabels.map(function(d) { return dataMapB[d] || 0; });

        tokenChart.data.labels = sortedLabels;
        tokenChart.data.datasets = [{
            label: '期间 A',
            data: seriesA,
            borderColor: chartColors.red,
            backgroundColor: 'transparent',
            borderWidth: 3,
            tension: 0,
            pointRadius: 0,
            pointHoverRadius: 6,
            fill: false,
        }, {
            label: '期间 B',
            data: seriesB,
            borderColor: chartColors.white,
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderDash: [4, 4],
            fill: false,
        }];
        tokenChart.update('none');
    }

    // Cost Trend chart — dual datasets
    var costChart = state.charts.costTrend;
    if (costChart) {
        var allCostLabels = {};
        for (var m = 0; m < aggA.labels.length; m++) allCostLabels[aggA.labels[m]] = true;
        for (var n = 0; n < aggB.labels.length; n++) allCostLabels[aggB.labels[n]] = true;
        var sortedCostLabels = Object.keys(allCostLabels).sort();

        var costMapA = {};
        for (var p = 0; p < aggA.labels.length; p++) {
            costMapA[aggA.labels[p]] = aggA.costs[p];
        }
        var costMapB = {};
        for (var q = 0; q < aggB.labels.length; q++) {
            costMapB[aggB.labels[q]] = aggB.costs[q];
        }

        var costSeriesA = sortedCostLabels.map(function(d) { return costMapA[d] || 0; });
        var costSeriesB = sortedCostLabels.map(function(d) { return costMapB[d] || 0; });

        costChart.data.labels = sortedCostLabels;
        costChart.data.datasets = [{
            label: '期间 A',
            data: costSeriesA,
            borderColor: chartColors.red,
            backgroundColor: 'transparent',
            borderWidth: 3,
            tension: 0,
            pointRadius: 0,
            pointHoverRadius: 6,
            fill: false,
        }, {
            label: '期间 B',
            data: costSeriesB,
            borderColor: chartColors.white,
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderDash: [4, 4],
            fill: false,
        }];
        costChart.update('none');
    }
}

function initAnalysisTab() {
    // Initialize charts
    initTokenTrendChart();
    initModelBreakdownChart();
    initCacheRateChart();
    initCostTrendChart();

    // Bind filter changes
    var filterDays = $('#filter-days');
    if (filterDays) {
        filterDays.addEventListener('change', function() {
            var customGroup = $('#custom-date-group');
            if (customGroup) {
                customGroup.classList.toggle('hidden', this.value !== 'custom');
            }
            loadAnalysisData();
        });
    }

    var filterModel = $('#filter-model');
    if (filterModel) {
        filterModel.addEventListener('change', loadAnalysisData);
    }

    var compareToggle = $('#compare-toggle');
    if (compareToggle) {
        compareToggle.addEventListener('change', handleCompareToggle);
    }

    var compareBtn = $('#compare-load-btn');
    if (compareBtn) {
        compareBtn.addEventListener('click', loadCompareData);
    }

    // Populate model dropdown from API
    populateModelFilter();

    // Initial data load
    loadAnalysisData();
}

async function populateModelFilter() {
    var days = state.analysisState.days || '30';
    try {
        var resp = await fetch('/api/analysis/models?days=' + days);
        var models = resp.ok ? await resp.json() : [];
        var select = $('#filter-model');
        if (!select) return;

        // Keep the "全部模型" option
        select.innerHTML = '<option value="">全部模型</option>';

        if (Array.isArray(models)) {
            var seen = {};
            for (var i = 0; i < models.length; i++) {
                var name = models[i].model;
                if (name && !seen[name]) {
                    seen[name] = true;
                    var opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    select.appendChild(opt);
                }
            }
        }
    } catch (e) {
        console.warn('[Analysis] Failed to load models:', e);
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
    var ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv' || ext === 'zip') {
        state.pendingCsvFile = file;
        var typeLabel = ext === 'zip' ? 'ZIP' : 'CSV';
        showCsvResult('已选择 ' + typeLabel + ': ' + file.name + ' (' + formatBytes(file.size) + ')', 'success');
        $('#csvPreview').classList.remove('hidden');
    } else {
        showCsvResult('仅支持 .csv 或 .zip 文件', 'error');
        return;
    }
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
            $('#csvPreview').classList.add('hidden');
            showToast(msg, 'success');
            // Refresh analysis data without page reload
            if (typeof loadAnalysisData === 'function') loadAnalysisData();
        } else {
            var errMsg = result.detail || '未知错误';
            showCsvResult('✕ 导入失败: ' + errMsg, 'error');
        }
    } catch (e) {
        showCsvResult('✕ 上传错误: ' + e.message, 'error');
    }
});

// ── Settings ─────────────────────────────────────────

// Auto-hide AI widgets when no API key configured
async function checkAiWidgets() {
    try {
        var resp = await fetch('/api/config');
        var cfg = await resp.json();
        var configured = !!cfg.configured;
        WidgetEngine.setVisibility('balance', configured);
        WidgetEngine.setVisibility('tokens', configured);
        WidgetEngine.setVisibility('cache', configured);
        WidgetEngine.renderAll();
        WidgetEngine.saveLayout();
    } catch (e) {
        /* silently ignore */
    }
}

// Load config — multi-vendor
async function loadConfig() {
    try {
        const resp = await fetch('/api/config');
        state.config = await resp.json();
        const cfg = state.config;

        // Update each vendor status
        var vendors = ['deepseek', 'openai', 'anthropic'];
        for (var i = 0; i < vendors.length; i++) {
            var v = vendors[i];
            var key = cfg[v + '_api_key'] || '';
            var keyEl = $('#' + v + '-api-key');
            var statusEl = $('#vendor-status-' + v);
            // Map DOM IDs: settings-api-key-deepseek etc.
            var settingsKeyEl = $('#settings-api-key-' + v);
            if (settingsKeyEl) {
                if (key) {
                    var masked = key.length > 8 ? key.substring(0, 4) + '****' + key.substring(key.length - 4) : '***';
                    settingsKeyEl.placeholder = masked;
                } else {
                    settingsKeyEl.placeholder = v === 'deepseek' ? 'sk-...' : v === 'openai' ? 'sk-...' : 'sk-ant-...';
                }
            }
            if (statusEl) {
                statusEl.textContent = key ? '已配置' : '未配置';
                statusEl.style.color = key ? 'var(--color-green)' : 'var(--color-grey-50)';
            }
        }

        // Set limits
        var dailyEl = $('#settings-daily-limit');
        if (dailyEl) dailyEl.value = cfg.daily_spending_limit || 5;
        var monthlyEl = $('#settings-monthly-limit');
        if (monthlyEl) monthlyEl.value = cfg.monthly_spending_limit || 100;

        updateSystemCardVisibility();
    } catch (e) {
        console.warn('Failed to load config:', e);
    }
}

// Vendor selector
function initVendorSelector() {
    var options = document.querySelectorAll('.vendor-option');
    for (var i = 0; i < options.length; i++) {
        options[i].addEventListener('click', function() {
            var all = document.querySelectorAll('.vendor-option');
            for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
            this.classList.add('active');
            var radio = this.querySelector('input[type=radio]');
            if (radio) radio.checked = true;
            updateVendorConfig(this.getAttribute('data-vendor'));
        });
    }
}

function updateVendorConfig(vendor) {
    var fields = ['deepseek', 'openai', 'anthropic'];
    for (var i = 0; i < fields.length; i++) {
        var el = $('#vendor-fields-' + fields[i]);
        if (el) el.classList.toggle('hidden', fields[i] !== vendor);
    }
}

// System card visibility (hidden until M5)
function updateSystemCardVisibility() {
    var card = $('#settings-system');
    if (card) card.classList.add('hidden');
}

// Settings save handler
document.addEventListener('DOMContentLoaded', function() {
    var saveBtn = $('#settings-save-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async function() {
            var active = document.querySelector('.vendor-option.active');
            var vendor = active ? active.getAttribute('data-vendor') : 'deepseek';
            var keyEl = $('#settings-api-key-' + vendor);
            var urlEl = $('#settings-base-url-' + vendor);
            var body = {};
            if (keyEl) body[vendor + '_api_key'] = keyEl.value;
            if (urlEl) body[vendor + '_base_url'] = urlEl.value;
            body.daily_spending_limit = parseFloat($('#settings-daily-limit')?.value) || 5;
            body.monthly_spending_limit = parseFloat($('#settings-monthly-limit')?.value) || 100;

            try {
                var resp = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                var result = await resp.json();
                var statusEl = $('#settings-status');
                if (result.status === 'ok') {
                    if (statusEl) {
                        statusEl.textContent = '✓ 已保存';
                        statusEl.className = 'form-status success';
                        setTimeout(function() { statusEl.textContent = ''; }, 3000);
                    }
                    showToast('配置已保存', 'success');
                    loadConfig();
                } else {
                    if (statusEl) {
                        statusEl.textContent = '✕ 保存失败';
                        statusEl.className = 'form-status error';
                    }
                }
            } catch (e) {
                showToast('保存失败: ' + e.message, 'error');
            }
        });
    }
});

// ── Alert Close ────────────────────────────────────
$('#limitAlertClose')?.addEventListener('click', () => {
    $('#limitAlert').classList.add('hidden');
});

// ── Init ────────────────────────────────────────────
function init() {
    // Load config
    loadConfig();

    // Initialize Theme Engine (load saved theme or use default)
    ThemeEngine.init();

    // Initialize Widget Engine (replaces old dashboard charts)
    WidgetEngine.init();
    setTimeout(function() { checkAiWidgets(); }, 500);

    // Initialize Analysis Tab
    initAnalysisTab();

    // Initialize vendor selector
    initVendorSelector();
    updateSystemCardVisibility();

    // Initialize theme UI
    initThemeSelector();
    initMarketplace();

    // Initialize hardware tab charts
    initHwCpuCoresChart();
    initHwMemChart();
    initHwDiskChart();
    initHwGpuTempChart();
    initHwNetChart();
    initHwBatteryChart();

    // Connect WebSocket
    connectWs();

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
function checkFirstRun() {
  fetch("/api/config").then(function(r) { return r.json(); }).then(function(cfg) {
    if (cfg.configured) {
      var el = document.getElementById("setup-overlay");
      if (el) el.classList.add("hidden");
    } else {
      var el = document.getElementById("setup-overlay");
      if (el) el.classList.remove("hidden");
    }
  }).catch(function(e) { console.warn("[Pulse] First-run check:", e); });
}

// --- Setup Form ---
function initSetupForm() {
  var form = document.getElementById("setup-form");
  if (!form) return;
  form.onsubmit = function(e) {
    e.preventDefault();
    var btn = form.querySelector(".setup-btn");
    btn.textContent = "SAVING..."; btn.disabled = true;
    fetch("/api/config", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
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
  form.onsubmit = function(e) {
    e.preventDefault();
    fetch("/api/config", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        deepseek_api_key: document.getElementById("settings-api-key").value,
        deepseek_base_url: document.getElementById("settings-base-url").value,
        daily_spending_limit: parseFloat(document.getElementById("settings-daily-limit").value) || 5,
        monthly_spending_limit: parseFloat(document.getElementById("settings-monthly-limit").value) || 100,
      })
    }).then(function(r) {
      if (r.ok) showToast("Config saved","success");
      else showToast("Save failed","error");
    }).catch(function(e) { showToast("Error","error"); });
  };
}

// --- Autostart Toggle ---
function initAutostartToggle() {
  var cb = document.getElementById("settings-autostart");
  if (!cb) return;
  cb.onchange = function() {
    if (cb.checked) showToast("Auto-start enabled","info");
    else showToast("Auto-start disabled","info");
  };
}

// --- Devices ---
function loadDevices() {
  var c = document.getElementById("device-list");
  if (!c) return;
  c.innerHTML = "<div class=loading-spinner></div>";
  fetch("/api/devices").then(function(r) { return r.json(); }).then(function(devices) {
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
          "<div class=device-name><span class=device-status " + (d.enabled ? "online" : "offline") + "></span>" + d.name + "</div>" +
          "<div class=device-host>" + d.host + ":" + (d.port || 135) + "</div>" +
        "</div>" +
        "<div class=device-actions>" +
          "<button class=btn-secondary onclick=deleteDevice(" + d.id + ")>DELETE</button>" +
        "</div>";
      c.appendChild(card);
    }
  }).catch(function(e) {
    c.innerHTML = "<div class=empty-state>Failed to load devices</div>";
  });
}

function deleteDevice(id) {
  if (!confirm("Delete this device?")) return;
  fetch("/api/devices/" + id, {method:"DELETE"}).then(function() {
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
    fetch("/api/devices", {
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
  document.getElementById("device-form-cancel").onclick = function() {
    document.getElementById("device-form-overlay").classList.add("hidden");
  };
  document.getElementById("device-add-btn").onclick = function() {
    document.getElementById("device-form-overlay").classList.remove("hidden");
  };
}

// --- Load devices on tab click ---
// --- Init Phase 4+5 ---
function initPhase45() {
  if (!document.getElementById("titlebar")) return; // skip if HTML not loaded
  initTitleBar();
  initSetupForm();
  initSettingsForm();
  initAutostartToggle();
  initDeviceForm();
  checkFirstRun();
  var hardwareTab = document.querySelector("[data-tab=hardware]");
  if (hardwareTab) {
    hardwareTab.addEventListener('click', function() { setTimeout(loadDevices, 100); });
  }
  if (!document.getElementById("toast-container")) {
    var tc = document.createElement("div");
    tc.id = "toast-container";
    document.body.appendChild(tc);
  }
}

// ── Theme Engine ──────────────────────────────────────
function camelToKebab(str) {
    return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}

// ── Theme UI ────────────────────────────────────
function initThemeSelector() {
    var sel = $('#theme-select');
    if (!sel) return;
    // Remove existing listeners by cloning
    // Using change event
    sel.onchange = function() {
        ThemeEngine.activate(this.value);
    };
    // Sync with current active theme
    if (ThemeEngine.activeTheme) {
        sel.value = ThemeEngine.activeTheme;
    }
}

function initMarketplace() {
    var grid = $('#marketplace-grid');
    if (!grid) return;
    grid.addEventListener('click', function(e) {
        var item = e.target.closest('.marketplace-item');
        if (item) {
            var themeName = item.getAttribute('data-theme');
            if (themeName) {
                ThemeEngine.activate(themeName);
                // Update dropdown to match
                var sel = $('#theme-select');
                if (sel) sel.value = themeName;
            }
        }
    });
}

const ThemeEngine = {
    activeTheme: null,
    themes: {},
    builtinThemePath: 'themes/constructivist/theme.json',

    async loadThemeData(path) {
        if (this.themes[path]) return this.themes[path];
        try {
            var resp = await fetch(path);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var data = await resp.json();
            this.themes[path] = data;
            return data;
        } catch (e) {
            console.warn('[Theme] Failed to load:', path, e);
            return null;
        }
    },

    async activate(name) {
        // Check cache by name
        var theme = this.themes[name];
        if (!theme) {
            var path = name === 'constructivist'
                ? this.builtinThemePath
                : 'themes/' + name + '/theme.json';
            theme = await this.loadThemeData(path);
            if (!theme) {
                console.warn('[Theme] Theme not found:', name);
                return;
            }
            this.themes[name] = theme;
        }

        // Apply tokens as CSS variables on :root
        var tokens = theme.tokens || {};
        var root = document.documentElement;
        for (var key in tokens) {
            if (Object.prototype.hasOwnProperty.call(tokens, key)) {
                var cssVar = '--' + camelToKebab(key);
                root.style.setProperty(cssVar, tokens[key]);
            }
        }

        // Update Chart.js global defaults
        if (tokens.colorTextSecondary) {
            Chart.defaults.color = tokens.colorTextSecondary;
        }
        if (tokens.fontMono) {
            Chart.defaults.font.family = tokens.fontMono;
        }

        // Redraw all Chart.js instances (non-animated)
        for (var chartKey in state.charts) {
            if (state.charts[chartKey] && typeof state.charts[chartKey].update === 'function') {
                state.charts[chartKey].update('none');
            }
        }

        // Redraw widget mini charts
        for (var wid in WidgetEngine._widgetCharts) {
            if (WidgetEngine._widgetCharts[wid] && typeof WidgetEngine._widgetCharts[wid].update === 'function') {
                WidgetEngine._widgetCharts[wid].update('none');
            }
        }

        // Persist preference
        localStorage.setItem('pulse-active-theme', name);
        this.activeTheme = name;

        // Update theme indicator if present
        var indicator = document.getElementById('themeIndicator');
        if (indicator) {
            indicator.textContent = theme.name || name;
        }

        console.log('[Theme] Activated:', name);
    },

    async init() {
        var saved = localStorage.getItem('pulse-active-theme');
        var name = saved || 'constructivist';
        await this.activate(name);
    }
};

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
