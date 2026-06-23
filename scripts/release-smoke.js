/* Release smoke checks for Pulse's pure-Web runtime. */

const http = require('http');
const path = require('path');
const Module = require('module');

const BASE_URL = process.env.PULSE_BASE_URL || 'http://127.0.0.1:8080';
const STORE_URL = process.env.PULSE_STORE_URL || 'http://127.0.0.1:8081';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (firstError) {
    const candidates = [];
    if (process.env.PLAYWRIGHT_NODE_MODULES) {
      candidates.push(process.env.PLAYWRIGHT_NODE_MODULES);
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(
        process.env.USERPROFILE,
        '.cache',
        'codex-runtimes',
        'codex-primary-runtime',
        'dependencies',
        'node',
        'node_modules'
      ));
    }

    for (const root of candidates) {
      try {
        const pnpmNodeModules = path.join(root, '.pnpm', 'node_modules');
        process.env.NODE_PATH = process.env.NODE_PATH
          ? `${process.env.NODE_PATH}${path.delimiter}${pnpmNodeModules}`
          : pnpmNodeModules;
        Module._initPaths();
        return require(path.join(root, 'playwright'));
      } catch (_) {
        // Try the next candidate.
      }
    }

    throw new Error(
      `Unable to load Playwright. Install it locally or set PLAYWRIGHT_NODE_MODULES. Original error: ${firstError.message}`
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function urlFor(pathname) {
  return new URL(pathname, BASE_URL).toString();
}

function isAllowedConsoleError(text) {
  return (
    text.includes('127.0.0.1:8081') ||
    text.includes('localhost:8081') ||
    text.includes(STORE_URL) ||
    text.includes('ERR_CONNECTION_REFUSED')
  );
}

function isStoreReachable() {
  return new Promise((resolve) => {
    const req = http.get(`${STORE_URL}/v1/themes`, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function canvasStats(page, id) {
  return page.$eval(`#${id}`, (canvas) => {
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    if (!ctx || width < 1 || height < 1) {
      return {
        id: canvas.id,
        width,
        height,
        clientWidth: rect.width,
        clientHeight: rect.height,
        nonEmptyPixels: 0,
        hash: 0,
      };
    }

    const data = ctx.getImageData(0, 0, width, height).data;
    let nonEmptyPixels = 0;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > 0) nonEmptyPixels += 1;
      hash ^= r + (g << 8) + (b << 16) + (a << 24);
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    return {
      id: canvas.id,
      width,
      height,
      clientWidth: rect.width,
      clientHeight: rect.height,
      nonEmptyPixels,
      hash,
    };
  });
}

async function waitCanvasNonEmpty(page, id, timeoutMs = 10000) {
  const started = Date.now();
  let lastStats = null;
  while (Date.now() - started < timeoutMs) {
    lastStats = await canvasStats(page, id);
    if (
      lastStats.width > 1 &&
      lastStats.height > 1 &&
      lastStats.clientWidth > 1 &&
      lastStats.clientHeight > 1 &&
      lastStats.nonEmptyPixels > 0
    ) {
      return lastStats;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Canvas ${id} stayed empty: ${JSON.stringify(lastStats)}`);
}

async function waitTextMatch(page, selector, pattern, timeoutMs = 10000) {
  const started = Date.now();
  let text = '';
  while (Date.now() - started < timeoutMs) {
    text = (await page.textContent(selector)) || '';
    if (pattern.test(text)) return text;
    await page.waitForTimeout(250);
  }
  throw new Error(`Text ${selector} did not match ${pattern}: ${text}`);
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!isAllowedConsoleError(text)) consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  try {
    await page.goto(urlFor('/?tab=dashboard'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[data-tab="dashboard"].active');
    await page.waitForSelector('#tab-dashboard.active');

    const dashboardCanvases = [
      'heroAiCanvas',
      'heroSystemCanvas',
      'heroFreshnessCanvas',
      'dashboardSystemStream',
      'dashboardUsageStream',
      'dashboardHeatStrip',
    ];
    for (const id of dashboardCanvases) {
      const stats = await waitCanvasNonEmpty(page, id);
      console.log(`[ok] ${id}`, stats);
    }

    await page.goto(urlFor('/?tab=hardware'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[data-tab="hardware"].active');
    await page.waitForSelector('#tab-hardware.active');
    const cpuA = await waitCanvasNonEmpty(page, 'hwCpuCoresChart');
    await page.waitForTimeout(1500);
    const cpuB = await canvasStats(page, 'hwCpuCoresChart');
    assert(cpuB.width > 1 && cpuB.height > 1, `Hardware CPU canvas is 1x1: ${JSON.stringify(cpuB)}`);
    assert(
      cpuB.nonEmptyPixels > 0 || cpuA.hash !== cpuB.hash,
      `Hardware CPU canvas did not render: before=${JSON.stringify(cpuA)} after=${JSON.stringify(cpuB)}`
    );
    console.log('[ok] hwCpuCoresChart', { before: cpuA, after: cpuB });

    await page.goto(urlFor('/?tab=analysis'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[data-tab="analysis"].active');
    await page.waitForSelector('#tab-analysis.active');
    console.log('[ok] analysis tab URL');

    await page.goto(urlFor('/#plugins'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[data-tab="plugins"].active');
    await page.waitForSelector('#tab-plugins.active');
    console.log('[ok] plugins hash URL');

    const storeOnline = await isStoreReachable();
    await page.goto(urlFor('/?tab=settings'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tab-settings.active');
    if (!storeOnline) {
      const status = await waitTextMatch(
        page,
        '#marketplace-status',
        /主题商店离线|离线|8081|本地可用主题/,
        10000
      );
      console.log('[ok] marketplace offline state', status.trim());
    } else {
      console.log('[skip] marketplace offline state because store is reachable');
    }

    assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
