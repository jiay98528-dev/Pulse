/* Pulse TelemetryCanvas
   Lightweight canvas charts plus a Chart.js-compatible shim. */
(function (window) {
    'use strict';

    var DEFAULT_THEME = {
        surface: 'oklch(14% 0.015 250)',
        panel: 'oklch(19% 0.018 250)',
        line: 'oklch(38% 0.035 250)',
        text: 'oklch(93% 0.008 250)',
        muted: 'oklch(58% 0.02 250)',
        primary: 'oklch(72% 0.16 205)',
        ai: 'oklch(76% 0.17 305)',
        system: 'oklch(74% 0.15 155)',
        warn: 'oklch(82% 0.16 85)',
        danger: 'oklch(66% 0.2 25)',
    };

    var activeInstances = [];
    var rafId = null;
    var pageHidden = document.hidden;
    var reducedMotionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    var reducedMotion = reducedMotionQuery ? reducedMotionQuery.matches : false;

    function cssVar(name, fallback) {
        var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    }

    function theme() {
        return {
            surface: cssVar('--surface-base', DEFAULT_THEME.surface),
            panel: cssVar('--surface-panel', DEFAULT_THEME.panel),
            line: cssVar('--surface-line', DEFAULT_THEME.line),
            text: cssVar('--text-primary', DEFAULT_THEME.text),
            muted: cssVar('--text-muted', DEFAULT_THEME.muted),
            primary: cssVar('--signal-primary', DEFAULT_THEME.primary),
            ai: cssVar('--signal-ai', DEFAULT_THEME.ai),
            system: cssVar('--signal-system', DEFAULT_THEME.system),
            warn: cssVar('--signal-warn', DEFAULT_THEME.warn),
            danger: cssVar('--signal-danger', DEFAULT_THEME.danger),
        };
    }

    function deviceQuality() {
        var cores = navigator.hardwareConcurrency || 2;
        var memory = navigator.deviceMemory || 4;
        if (reducedMotion || cores <= 2 || memory <= 4) return 'low';
        if (cores >= 8 && memory >= 8) return 'high';
        return 'balanced';
    }

    function maxDprForQuality(q) {
        return q === 'high' ? 2 : 1.5;
    }

    function frameInterval(q) {
        if (reducedMotion) return 250;
        if (q === 'high') return 1000 / 60;
        if (q === 'balanced') return 1000 / 36;
        return 1000 / 24;
    }

    function register(instance) {
        activeInstances.push(instance);
        ensureLoop();
    }

    function unregister(instance) {
        activeInstances = activeInstances.filter(function (item) { return item !== instance; });
        if (!activeInstances.length) {
            stopLoop();
        }
    }

    function ensureLoop() {
        if (pageHidden || activeInstances.length === 0) return;
        if (rafId) return;
        function tick(now) {
            rafId = requestAnimationFrame(tick);
            for (var i = 0; i < activeInstances.length; i++) {
                var inst = activeInstances[i];
                if (!inst || inst.destroyed) continue;
                if (!isRenderableCanvas(inst.canvas)) continue;
                var interval = frameInterval(inst.quality);
                if (now - inst._lastFrame < interval) continue;
                inst._lastFrame = now;
                inst.render(now);
            }
        }
        rafId = requestAnimationFrame(tick);
    }

    function stopLoop() {
        if (!rafId) return;
        cancelAnimationFrame(rafId);
        rafId = null;
    }

    function isRenderableCanvas(canvas) {
        if (!canvas || !canvas.isConnected) return false;
        var rect = canvas.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    document.addEventListener('visibilitychange', function () {
        pageHidden = document.hidden;
        if (pageHidden) {
            stopLoop();
            return;
        }
        ensureLoop();
        activeInstances.forEach(function (inst) {
            if (!inst.destroyed) inst.render(performance.now());
        });
    });

    if (reducedMotionQuery && reducedMotionQuery.addEventListener) {
        reducedMotionQuery.addEventListener('change', function (ev) {
            reducedMotion = ev.matches;
        });
    } else if (reducedMotionQuery && reducedMotionQuery.addListener) {
        reducedMotionQuery.addListener(function (ev) {
            reducedMotion = ev.matches;
        });
    }

    function normalizeValues(values) {
        if (!Array.isArray(values)) return [];
        return values.map(function (value) {
            var n = Number(value);
            return Number.isFinite(n) ? n : 0;
        });
    }

    function flattenDatasets(data) {
        if (!data) return [];
        if (Array.isArray(data.values)) return [{ label: data.label || '', data: normalizeValues(data.values) }];
        if (Array.isArray(data.datasets)) {
            return data.datasets.map(function (ds) {
                return {
                    label: ds.label || '',
                    data: normalizeValues(ds.data || []),
                    color: ds.borderColor || ds.backgroundColor,
                    fill: ds.fill,
                };
            });
        }
        return [];
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function clear(ctx, w, h, t) {
        ctx.clearRect(0, 0, w, h);
        var g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, t.panel);
        g.addColorStop(1, t.surface);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
    }

    function drawGrid(ctx, w, h, t) {
        ctx.strokeStyle = t.line;
        ctx.globalAlpha = 0.38;
        ctx.lineWidth = 1;
        var cols = 6;
        var rows = 4;
        for (var i = 1; i < cols; i++) {
            var x = Math.round(w * i / cols) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (var j = 1; j < rows; j++) {
            var y = Math.round(h * j / rows) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    function drawLabel(ctx, text, x, y, t, size) {
        ctx.font = '600 ' + (size || 11) + 'px "JetBrains Mono", "Cascadia Mono", monospace';
        ctx.fillStyle = t.muted;
        ctx.fillText(String(text || ''), x, y);
    }

    function drawSparkline(ctx, w, h, datasets, t, now, options) {
        drawGrid(ctx, w, h, t);
        var all = [];
        datasets.forEach(function (ds) { all = all.concat(ds.data); });
        var max = Number(options && options.max);
        var min = Number(options && options.min);
        if (!Number.isFinite(max)) max = Math.max(1, Math.max.apply(null, all.concat([1])));
        if (!Number.isFinite(min)) min = Math.min(0, Math.min.apply(null, all.concat([0])));
        var range = Math.max(1, max - min);
        var pad = 14;
        datasets.forEach(function (ds, idx) {
            var values = ds.data.slice(-180);
            if (!values.length) return;
            var color = Array.isArray(ds.color) ? ds.color[0] : (ds.color || (idx ? t.ai : t.primary));
            ctx.lineWidth = idx ? 1.6 : 2.4;
            ctx.strokeStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = reducedMotion ? 0 : 10;
            ctx.beginPath();
            for (var i = 0; i < values.length; i++) {
                var x = pad + (w - pad * 2) * (values.length === 1 ? 1 : i / (values.length - 1));
                var y = h - pad - ((values[i] - min) / range) * (h - pad * 2);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;
        });
        if (!reducedMotion && datasets[0] && datasets[0].data.length) {
            var pulse = 0.45 + Math.sin(now / 320) * 0.2;
            ctx.fillStyle = t.primary;
            ctx.globalAlpha = pulse;
            ctx.fillRect(w - 18, 12, 8, 8);
            ctx.globalAlpha = 1;
        }
    }

    function drawRadial(ctx, w, h, datasets, t) {
        var value = datasets[0] && datasets[0].data.length ? datasets[0].data[0] : 0;
        var pct = clamp(Number(value) || 0, 0, 100);
        var cx = w / 2;
        var cy = h / 2;
        var radius = Math.max(24, Math.min(w, h) * 0.34);
        var start = -Math.PI / 2;
        var end = start + Math.PI * 2 * pct / 100;
        var color = pct >= 85 ? t.danger : (pct >= 70 ? t.warn : t.system);
        ctx.lineWidth = Math.max(8, radius * 0.18);
        ctx.strokeStyle = t.line;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = reducedMotion ? 0 : 14;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, start, end);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = t.text;
        ctx.font = '700 ' + Math.max(24, radius * 0.52) + 'px "JetBrains Mono", monospace';
        ctx.fillText(Math.round(pct) + '%', cx, cy);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawBars(ctx, w, h, datasets, labels, t) {
        drawGrid(ctx, w, h, t);
        var values = datasets[0] ? datasets[0].data : [];
        if (!values.length) return;
        var max = Math.max(1, Math.max.apply(null, values.concat([100])));
        var gap = 6;
        var pad = 18;
        var barH = Math.max(8, Math.min(18, (h - pad * 2 - gap * (values.length - 1)) / values.length));
        for (var i = 0; i < values.length; i++) {
            var y = pad + i * (barH + gap);
            var width = (w - pad * 2) * clamp(values[i] / max, 0, 1);
            var color = values[i] >= 85 ? t.danger : (values[i] >= 70 ? t.warn : t.primary);
            ctx.fillStyle = t.line;
            ctx.fillRect(pad, y, w - pad * 2, barH);
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = reducedMotion ? 0 : 8;
            ctx.fillRect(pad, y, width, barH);
            ctx.shadowBlur = 0;
            if (labels && labels[i]) drawLabel(ctx, labels[i], pad, y - 3, t, 9);
        }
    }

    function drawHeat(ctx, w, h, datasets, t) {
        var values = datasets[0] ? datasets[0].data.slice(-180) : [];
        if (!values.length) return;
        var max = Math.max(1, Math.max.apply(null, values));
        var cellW = Math.max(3, w / values.length);
        for (var i = 0; i < values.length; i++) {
            var alpha = clamp(values[i] / max, 0.05, 1);
            ctx.fillStyle = alpha > 0.8 ? t.danger : (alpha > 0.6 ? t.warn : t.primary);
            ctx.globalAlpha = 0.18 + alpha * 0.72;
            ctx.fillRect(i * cellW, 0, Math.ceil(cellW), h);
        }
        ctx.globalAlpha = 1;
    }

    function drawCostCache(ctx, w, h, datasets, t, now, options) {
        drawSparkline(ctx, w, h, datasets, t, now, options);
        var second = datasets[1] && datasets[1].data.length ? datasets[1].data[datasets[1].data.length - 1] : null;
        if (second !== null) {
            ctx.fillStyle = t.ai;
            ctx.globalAlpha = 0.2;
            ctx.fillRect(0, h - clamp(second, 0, 100) / 100 * h, w, h);
            ctx.globalAlpha = 1;
        }
    }

    function TelemetryCanvasInstance(canvas, config) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.config = config || {};
        this.type = this.config.type || 'sparkline';
        this.data = this.config.data || { labels: this.config.labels || [], datasets: this.config.datasets || [] };
        this.options = this.config.options || {};
        this.state = {};
        this.quality = deviceQuality();
        this.destroyed = false;
        this._lastFrame = 0;
        this._observer = new ResizeObserver(this.resize.bind(this));
        this._observer.observe(canvas);
        this.resize();
        register(this);
    }

    TelemetryCanvasInstance.prototype.setData = function (data) {
        this.data = data || this.data;
        this.render(performance.now());
    };

    TelemetryCanvasInstance.prototype.setState = function (state) {
        this.state = state || {};
        this.render(performance.now());
    };

    TelemetryCanvasInstance.prototype.setQuality = function (quality) {
        this.quality = quality || deviceQuality();
        this.resize();
    };

    TelemetryCanvasInstance.prototype.resize = function () {
        if (this.destroyed) return;
        var rect = this.canvas.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return;
        var dpr = Math.min(window.devicePixelRatio || 1, maxDprForQuality(this.quality));
        var w = Math.max(1, Math.floor(rect.width * dpr));
        var h = Math.max(1, Math.floor(rect.height * dpr));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        this._cssWidth = rect.width || w;
        this._cssHeight = rect.height || h;
        this.render(performance.now());
    };

    TelemetryCanvasInstance.prototype.render = function (now) {
        if (this.destroyed || pageHidden) return;
        if (!isRenderableCanvas(this.canvas)) return;
        var ctx = this.ctx;
        var w = this._cssWidth || this.canvas.clientWidth || 100;
        var h = this._cssHeight || this.canvas.clientHeight || 100;
        var t = theme();
        var datasets = flattenDatasets(this.data);
        var labels = (this.data && this.data.labels) || [];
        clear(ctx, w, h, t);
        if (this.type === 'radial' || this.type === 'doughnut') drawRadial(ctx, w, h, datasets, t);
        else if (this.type === 'barMatrix' || this.type === 'bar') drawBars(ctx, w, h, datasets, labels, t);
        else if (this.type === 'heatStrip') drawHeat(ctx, w, h, datasets, t);
        else if (this.type === 'costCache') drawCostCache(ctx, w, h, datasets, t, now, this.options);
        else if (this.type === 'usageStream') {
            drawSparkline(ctx, w, h, datasets, t, now, this.options);
        } else {
            drawSparkline(ctx, w, h, datasets, t, now, this.options);
        }
        if (this.state && this.state.label) drawLabel(ctx, this.state.label, 10, 16, t, 10);
    };

    TelemetryCanvasInstance.prototype.update = function () {
        this.render(performance.now());
    };

    TelemetryCanvasInstance.prototype.destroy = function () {
        this.destroyed = true;
        if (this._observer) this._observer.disconnect();
        unregister(this);
    };

    function mapChartType(config) {
        var type = config && config.type;
        if (!type) return 'sparkline';
        if (type === 'doughnut' || type === 'pie') return 'radial';
        if (type === 'radial' || type === 'line' || type === 'usageStream') return type;
        if (type === 'bar' || type === 'barMatrix') return 'barMatrix';
        if (type === 'heatStrip') return 'heatStrip';
        if (type === 'costCache') return 'costCache';
        return 'sparkline';
    }

    function ChartShim(canvas, config) {
        canvas.style.display = canvas.style.display || 'block';
        canvas.style.width = canvas.style.width || '100%';
        canvas.style.height = canvas.style.height || '100%';
        this.canvas = canvas;
        this.config = config || {};
        this.type = mapChartType(config);
        this.data = this.config.data || { labels: [], datasets: [] };
        this.options = this.config.options || {};
        this._tc = new TelemetryCanvasInstance(canvas, {
            type: this.type,
            data: this.data,
            options: this.options,
        });
    }

    ChartShim.prototype.update = function () {
        if (this.config.type !== this.type) {
            this.type = mapChartType(this.config);
            this._tc.type = this.type;
        }
        if (this.config.data) this.data = this.config.data;
        if (this.config.options) this.options = this.config.options;
        this._tc.type = this.type;
        this._tc.options = this.options;
        this._tc.setData(this.data || this.config.data || { labels: [], datasets: [] });
        this._tc.render(performance.now());
    };
    ChartShim.prototype.setData = function (data) {
        this.data = data;
        this._tc.setData(data);
    };
    ChartShim.prototype.setState = function (state) {
        this._tc.setState(state || {});
    };
    ChartShim.prototype.setQuality = function (quality) {
        this._tc.setQuality(quality);
    };
    ChartShim.prototype.destroy = function () {
        this._tc.destroy();
    };
    ChartShim.prototype.resize = function () {
        this._tc.resize();
    };

    ChartShim.defaults = {
        color: DEFAULT_THEME.muted,
        borderColor: DEFAULT_THEME.line,
        font: { family: '"JetBrains Mono", monospace' },
        plugins: { legend: { labels: {} } },
        elements: { line: {}, point: {} },
        animation: {},
        interaction: {},
    };

    window.TelemetryCanvas = {
        create: function (canvas, config) {
            return new TelemetryCanvasInstance(canvas, config || {});
        },
        instances: function () {
            return activeInstances.slice();
        },
        refreshTheme: function () {
            activeInstances.forEach(function (inst) { inst.render(performance.now()); });
        },
    };

    window.Chart = ChartShim;
})(window);
