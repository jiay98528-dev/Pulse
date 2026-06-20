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

// ══════════════════════════════════════════════════
//  Theme Engine (M4.1)
//  JSON→CSS变量→图表重绘
// ══════════════════════════════════════════════════
const STORE_API = 'http://localhost:8081'; // 商店后端地址

var ThemeEngine = {
    activeThemeId: null,
    installedThemes: {},

    init: function() {
        var saved = localStorage.getItem('pulse-active-theme-id');
        if (saved) {
            this.activeThemeId = saved;
        }
        var installed = localStorage.getItem('pulse-installed-themes');
        if (installed) {
            try { this.installedThemes = JSON.parse(installed); } catch(e) {}
        }
        var tokens = localStorage.getItem('pulse-theme-tokens');
        if (tokens) {
            try {
                var parsed = JSON.parse(tokens);
                this._applyTokens(parsed);
            } catch(e) {}
        }
    },

    _applyTokens: function(tokens) {
        var root = document.documentElement;
        for (var key in tokens) {
            if (tokens.hasOwnProperty(key)) {
                root.style.setProperty('--' + key, tokens[key]);
            }
        }
    },

    activate: function(theme) {
        var root = document.documentElement;
        if (theme.tokens) {
            this._applyTokens(theme.tokens);
            localStorage.setItem('pulse-theme-tokens', JSON.stringify(theme.tokens));
        }
        var customEl = document.getElementById('pulse-theme-custom');
        if (!customEl) {
            customEl = document.createElement('style');
            customEl.id = 'pulse-theme-custom';
            document.head.appendChild(customEl);
        }
        customEl.textContent = theme.customCSS || '';
        Object.values(state.charts).forEach(function(c) {
            if (c && c.update) c.update();
        });
        this.activeThemeId = theme.id || theme.name;
        localStorage.setItem('pulse-active-theme-id', this.activeThemeId);
        var sel = document.getElementById('theme-selector');
        if (sel) {
            var opt = sel.querySelector('option[value="' + this.activeThemeId + '"]');
            if (opt) {
                sel.value = this.activeThemeId;
            }
        }
        console.log('[ThemeEngine] Activated:', theme.name || theme.id);
    },

    install: function(theme) {
        this.installedThemes[theme.id] = {
            name: theme.name,
            author: theme.author,
            type: theme.type,
            installedAt: Date.now(),
        };
        localStorage.setItem('pulse-installed-themes', JSON.stringify(this.installedThemes));
        this.activate(theme);
        var sel = document.getElementById('theme-selector');
        if (sel) {
            var existing = sel.querySelector('option[value="' + theme.id + '"]');
            if (existing) existing.remove();
            var opt = document.createElement('option');
            opt.value = theme.id;
            opt.textContent = theme.name;
            sel.appendChild(opt);
            sel.value = theme.id;
        }
        showToast('主题 "' + theme.name + '" 已安装', 'success');
    },

    resetToDefault: function() {
        localStorage.removeItem('pulse-active-theme-id');
        localStorage.removeItem('pulse-theme-tokens');
        var customEl = document.getElementById('pulse-theme-custom');
        if (customEl) customEl.textContent = '';
        var root = document.documentElement;
        var inlineStyles = root.style;
        var keysToRemove = [];
        for (var i = 0; i < inlineStyles.length; i++) {
            var key = inlineStyles[i];
            if (key.startsWith('--color-') || key.startsWith('--font-') ||
                key.startsWith('--text-') || key.startsWith('--shadow-') ||
                key.startsWith('--border-') || key.startsWith('--space-') ||
                key.startsWith('--duration-')) {
                keysToRemove.push(key);
            }
        }
        for (var j = 0; j < keysToRemove.length; j++) {
            root.style.removeProperty(keysToRemove[j]);
        }
        Object.values(state.charts).forEach(function(c) {
            if (c && c.update) c.update();
        });
        var sel = document.getElementById('theme-selector');
        if (sel) sel.value = 'builtin-constructivist';
        showToast('已恢复默认主题', 'info');
    },

    isInstalled: function(themeId) {
        return !!this.installedThemes[themeId];
    }
};

// ══════════════════════════════════════════════════
//  Marketplace (M6.5)
// ══════════════════════════════════════════════════

async function loadMarketplace() {
    var grid = document.getElementById('marketplace-grid');
    var status = document.getElementById('marketplace-status');
    var empty = document.getElementById('marketplace-empty');
    if (!grid) return;

    try {
        var resp = await fetch(STORE_API + '/v1/themes');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var themes = await resp.json();
        if (!Array.isArray(themes) || themes.length === 0) {
            if (status) status.classList.add('hidden');
            if (empty) empty.classList.remove('hidden');
            return;
        }

        if (status) status.classList.add('hidden');
        if (empty) empty.classList.add('hidden');
        grid.innerHTML = '';

        for (var i = 0; i < themes.length; i++) {
            var t = themes[i];
            var item = document.createElement('div');
            item.className = 'marketplace-item';
            item.setAttribute('data-theme-id', t.id);

            var badgeText = t.price > 0 ? '¥' + t.price.toFixed(2) : '免费';
            var badgeClass = t.price > 0 ? 'paid' : 'free';
            var typeLabel = t.type || (t.price > 0 ? '官方' : '社区');

            item.innerHTML =
                '<div class="marketplace-preview" style="background:' + (t.previewColor || '#000') + ';border:1px solid #333;">' +
                    '<span style="font-size:24px;color:' + (t.previewIconColor || '#666') + ';">' + (t.previewIcon || '★') + '</span>' +
                '</div>' +
                '<div class="marketplace-info">' +
                    '<div class="marketplace-name">' + escapeHtml(t.name) + '</div>' +
                    '<div class="marketplace-author">' + escapeHtml(t.author || '未知') + ' &middot; ' + typeLabel + '</div>' +
                    '<div class="marketplace-badge ' + badgeClass + '">' + badgeText + '</div>' +
                '</div>';

            (function(theme) {
                item.addEventListener('click', function() { showThemeDetail(theme); });
            })(t);

            grid.appendChild(item);
        }
    } catch (e) {
        console.warn('[Marketplace] Cannot reach store:', e);
        if (status) {
            status.textContent = '无法连接主题商店 (' + e.message + ')';
            status.style.color = 'var(--color-red)';
        }
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
        status.textContent = '商店离线，显示本地可用主题';
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
            var resp = await fetch(STORE_API + '/v1/themes/' + theme.id + '/buy', {
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
            if (qrImg && result.qr_code) {
                qrImg.src = result.qr_code;
            }
            var purchaseId = result.purchase_id || result.id;
            if (purchaseId) {
                pollPaymentStatus(purchaseId, theme);
            }
        } catch (e) {
            showToast('购买错误: ' + e.message, 'error');
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
            var resp = await fetch(STORE_API + '/v1/purchases/' + purchaseId);
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
        var resp = await fetch(STORE_API + '/v1/themes/' + theme.id);
        if (resp.ok) {
            var fullTheme = await resp.json();
            ThemeEngine.install(fullTheme);
            return;
        }
    } catch (e) {
        console.warn('[Install] Cannot fetch theme from store:', e);
    }
    if (theme.id === 'builtin-constructivist') {
        ThemeEngine.resetToDefault();
        ThemeEngine.installedThemes['builtin-constructivist'] = {
            name: theme.name || '苏维埃全主义构成',
            author: 'Pulse Team',
            type: '官方',
            installedAt: Date.now(),
        };
        localStorage.setItem('pulse-installed-themes', JSON.stringify(ThemeEngine.installedThemes));
        showToast('已激活默认主题', 'success');
        return;
    }
    showToast('无法获取主题文件。请检查商店连接。', 'error');
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
        var resp = await fetch(STORE_API + '/v1/restore', {
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
        showToast('错误: ' + e.message, 'error');
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
        var resp = await fetch(STORE_API + '/v1/restore/verify', {
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
        showToast('错误: ' + e.message, 'error');
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
        if (val === 'builtin-constructivist') {
            ThemeEngine.resetToDefault();
        } else if (ThemeEngine.installedThemes[val]) {
            fetch(STORE_API + '/v1/themes/' + val)
                .then(function(r) { return r.json(); })
                .then(function(theme) { ThemeEngine.activate(theme); })
                .catch(function() {
                    showToast('无法重新加载主题', 'error');
                    ThemeEngine.resetToDefault();
                });
        }
    });
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

  // Theme Engine + Marketplace (M4.1 / M6.5)
  ThemeEngine.init();
  initThemeSelector();
  initMarketplaceOnTab();
  initMarketplaceOverlayButtons();
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

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
