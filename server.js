const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const sharp = require('sharp');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// ─── BG Removal setup ────────────────────────────────────────────────────────
// Use smallest/fastest model: isnet_quint8 (~10MB, 5x faster than default 40MB)
// This is critical for Render free tier (512MB RAM, 30s idle timeout)
let removeBackground = null;
let bgModelReady    = false;
let bgModelError    = null;
let bgModelLoading  = false;

const BG_CONFIG = {
  model: 'isnet_quint8',          // Smallest + fastest model
  output: { format: 'image/png', quality: 1.0 }
};

// Tiny 1×1 transparent PNG used to warm up the model on startup
const WARMUP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ' +
  'AAbjjQ3MAAAAASUVORK5CYII=', 'base64'
);

async function loadBgModel() {
  if (bgModelReady || bgModelLoading) return;
  bgModelLoading = true;
  try {
    console.log('[BG] Loading @imgly/background-removal-node (isnet_quint8)...');
    const mod = require('@imgly/background-removal-node');
    removeBackground = mod.removeBackground;

    // Warm up: run a tiny image through so the model is ready before first user request
    const warmBlob = new Blob([WARMUP_PNG], { type: 'image/png' });
    await removeBackground(warmBlob, BG_CONFIG);

    bgModelReady  = true;
    bgModelLoading = false;
    console.log('[BG] Model ready ✓');
  } catch (e) {
    bgModelError   = e.message;
    bgModelLoading = false;
    console.error('[BG] Model load failed:', e.message);
  }
}

// Start loading immediately when server starts (non-blocking)
loadBgModel();

// ─── Image / File Proxy (CORS bypass for browser canvas) ─────────────────────
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const response = await axios({
      method: 'GET', url, responseType: 'stream', timeout: 30000,
      maxContentLength: 200 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': url
      }
    });
    const ct = response.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.message, originalStatus: status });
  }
});

// ─── BG Model status (frontend polls this to know when model is ready) ────────
app.get('/api/bg-status', (req, res) => {
  res.json({
    ready:   bgModelReady,
    loading: bgModelLoading,
    error:   bgModelError
  });
});

// ─── AI Background Removal ────────────────────────────────────────────────────
app.post('/api/remove-bg', async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // If model not ready yet, wait up to 90s for it
  if (!bgModelReady) {
    if (bgModelError) {
      return res.status(503).json({ error: 'BG model failed to load: ' + bgModelError });
    }
    console.log('[BG] Model still loading, waiting...');
    const waited = await new Promise(resolve => {
      let elapsed = 0;
      const iv = setInterval(() => {
        elapsed += 500;
        if (bgModelReady || bgModelError || elapsed >= 90000) {
          clearInterval(iv);
          resolve(bgModelReady);
        }
      }, 500);
    });
    if (!waited) {
      return res.status(503).json({ error: 'BG model not ready yet. Please retry in a moment.' });
    }
  }

  try {
    console.log('[BG] Downloading:', url);
    const imgResp = await axios({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 30000,
      maxContentLength: 30 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url }
    });

    const inputBlob = new Blob([imgResp.data], {
      type: imgResp.headers['content-type'] || 'image/jpeg'
    });

    console.log('[BG] Removing background...');
    const resultBlob = await removeBackground(inputBlob, BG_CONFIG);
    const buffer     = Buffer.from(await resultBlob.arrayBuffer());

    console.log('[BG] Done! Size:', (buffer.length / 1024).toFixed(1), 'KB');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (e) {
    console.error('[BG] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Image Enhancement (server-side, sharp) ───────────────────────────────
// Enhances image quality: upscale 2x + strong sharpen + colour boost
// Returns X-Enhancement-Percent header so frontend shows per-image stats
app.post('/api/enhance-img', async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    console.log('[Enhance] Downloading:', url);
    const imgResponse = await axios({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url }
    });

    const inputBuffer = Buffer.from(imgResponse.data);
    const meta = await sharp(inputBuffer).metadata();
    const origW = meta.width || 800;
    const origH = meta.height || 800;
    console.log(`[Enhance] Original: ${origW}x${origH}, format: ${meta.format}`);

    // ── Measure sharpness BEFORE (std-dev of greyscale pixels) ───────────────
    const beforeRaw = await sharp(inputBuffer).greyscale().raw().toBuffer();
    let bSum = 0, bSq = 0;
    for (let i = 0; i < beforeRaw.length; i++) { bSum += beforeRaw[i]; bSq += beforeRaw[i] * beforeRaw[i]; }
    const bMean = bSum / beforeRaw.length;
    const beforeSD = Math.sqrt(bSq / beforeRaw.length - bMean * bMean);

    // ── Enhancement pipeline ──────────────────────────────────────────────────
    const outputBuffer = await sharp(inputBuffer)
      .resize(origW * 2, origH * 2, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
      .sharpen({ sigma: 2.0, m1: 3.0, m2: 1.5, x1: 3, y2: 15, y3: 25 })
      .modulate({ brightness: 1.02, saturation: 1.10 })
      .normalise()
      .withMetadata()
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();

    // ── Measure sharpness AFTER (downsample back to orig size for fair compare)
    const afterRaw = await sharp(outputBuffer)
      .resize(origW, origH, { kernel: sharp.kernel.lanczos3 })
      .greyscale().raw().toBuffer();
    let aSum = 0, aSq = 0;
    for (let i = 0; i < afterRaw.length; i++) { aSum += afterRaw[i]; aSq += afterRaw[i] * afterRaw[i]; }
    const aMean = aSum / afterRaw.length;
    const afterSD = Math.sqrt(aSq / afterRaw.length - aMean * aMean);

    // ── Enhancement % ─────────────────────────────────────────────────────────
    let pct = beforeSD > 0 ? Math.round(((afterSD - beforeSD) / beforeSD) * 100) : 0;
    pct = Math.max(-5, Math.min(250, pct));

    console.log(`[Enhance] Done! ${origW}x${origH}→${origW*2}x${origH*2} | SD: ${beforeSD.toFixed(1)}→${afterSD.toFixed(1)} (${pct>=0?'+':''}${pct}%) | ${(outputBuffer.length/1024).toFixed(1)} KB`);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', outputBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Expose-Headers', 'X-Enhancement-Percent,X-Original-Resolution,X-Enhanced-Resolution,X-Original-Size,X-Enhanced-Size');
    res.setHeader('X-Enhancement-Percent',  String(pct));
    res.setHeader('X-Original-Resolution',  `${origW}x${origH}`);
    res.setHeader('X-Enhanced-Resolution',  `${origW*2}x${origH*2}`);
    res.setHeader('X-Original-Size',        String(Math.round(inputBuffer.length  / 1024)));
    res.setHeader('X-Enhanced-Size',        String(Math.round(outputBuffer.length / 1024)));
    res.send(outputBuffer);
  } catch (e) {
    console.error('[Enhance] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const CONCURRENCY = 15;        // parallel checks
const REQUEST_TIMEOUT = 18000; // 18 seconds

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Per-URL link check ──────────────────────────────────────────────────────
async function checkLink(url, cancelled) {
  if (cancelled.value) return { url, isBroken: true, statusMessage: 'Cancelled' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  // Watch for cancellation signal
  const cancelCheck = setInterval(() => {
    if (cancelled.value) controller.abort();
  }, 200);

  try {
    let response = await axios({
      method: 'HEAD',
      url,
      timeout: REQUEST_TIMEOUT,
      signal: controller.signal,
      validateStatus: null,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT },
    });

    // Some servers don't support HEAD — retry with GET + Range
    if (response.status === 405 || response.status === 501) {
      response = await axios({
        method: 'GET',
        url,
        timeout: REQUEST_TIMEOUT,
        signal: controller.signal,
        headers: { 'Range': 'bytes=0-0', 'User-Agent': USER_AGENT },
        validateStatus: null,
        maxRedirects: 5,
      });
    }

    clearTimeout(timeoutId);
    clearInterval(cancelCheck);

    const isWorking = response.status >= 200 && response.status < 400;
    return {
      url,
      isBroken: !isWorking,
      statusMessage: `${response.status} ${response.statusText || ''}`.trim(),
    };
  } catch (error) {
    clearTimeout(timeoutId);
    clearInterval(cancelCheck);

    if (cancelled.value) return { url, isBroken: true, statusMessage: 'Cancelled' };

    let errorMsg = 'Network error';
    const code = error.code || '';

    if (error.name === 'AbortError' || code === 'ECONNABORTED' || error.name === 'CanceledError') {
      errorMsg = 'Timeout (>18s)';
    } else if (code === 'ENOTFOUND') {
      errorMsg = 'DNS not found';
    } else if (code === 'ECONNREFUSED') {
      errorMsg = 'Connection refused';
    } else if (code === 'ECONNRESET') {
      errorMsg = 'Connection reset';
    } else if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error.message?.includes('certificate')) {
      errorMsg = 'SSL certificate error';
    } else if (error.response) {
      errorMsg = `HTTP ${error.response.status}`;
    } else if (error.request) {
      errorMsg = 'No response (server down)';
    } else {
      errorMsg = error.message || 'Unknown error';
    }

    return { url, isBroken: true, statusMessage: errorMsg };
  }
}

// ─── Process all links with concurrency ─────────────────────────────────────
async function processLinks(socket, links, cancelled) {
  const total = links.length;
  let checked = 0;
  let brokenCount = 0;
  let workingCount = 0;
  const brokenLinks = [];
  const startTime = Date.now();

  const queue = [...links];
  let activeWorkers = 0;
  let resolveAll = null;
  const allDone = new Promise(resolve => { resolveAll = resolve; });

  function emitProgress(currentLink) {
    const percent = (checked / total) * 100;
    const elapsed = Date.now() - startTime;
    const avgTime = elapsed / (checked || 1);
    const remaining = (total - checked) * avgTime;

    socket.emit('progress', {
      checked,
      total,
      brokenCount,
      workingCount,
      currentLink: currentLink || 'finalizing',
      percent,
      etaMs: remaining,
      avgTimeMs: avgTime,
    });
  }

  async function worker() {
    while (queue.length > 0 && !cancelled.value) {
      const url = queue.shift();
      emitProgress(url);
      const result = await checkLink(url, cancelled);

      if (cancelled.value) break;

      checked++;
      if (result.isBroken) {
        brokenCount++;
        brokenLinks.push({ url: result.url, status: result.statusMessage });
        socket.emit('brokenLinkFound', { url: result.url, error: result.statusMessage });
      } else {
        workingCount++;
      }
      emitProgress(null);
    }
    activeWorkers--;
    if (activeWorkers === 0 && resolveAll) resolveAll();
  }

  activeWorkers = Math.min(CONCURRENCY, total);
  for (let i = 0; i < activeWorkers; i++) worker();
  await allDone;

  if (cancelled.value) {
    socket.emit('checkCancelled', { checked, brokenCount, workingCount, brokenLinks });
  } else {
    socket.emit('checkComplete', {
      totalLinks: total,
      brokenCount,
      workingCount,
      brokenLinks,
    });
  }
}

// ─── Socket connections ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let isScanning = false;
  const cancelled = { value: false };

  socket.on('startCheck', async (data) => {
    if (isScanning) return;
    const links = data.links;
    if (!links || !links.length) {
      socket.emit('error', { message: 'No links provided' });
      return;
    }
    isScanning = true;
    cancelled.value = false;
    try {
      await processLinks(socket, links, cancelled);
    } catch (err) {
      socket.emit('error', { message: err.message });
    } finally {
      isScanning = false;
    }
  });

  socket.on('stopCheck', () => {
    if (isScanning) {
      cancelled.value = true;
      console.log('Scan stopped by client:', socket.id);
    }
  });

  socket.on('disconnect', () => {
    cancelled.value = true;
    console.log('Client disconnected:', socket.id);
  });
});

// ─── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🚀 BlazeTools running at http://localhost:${PORT}\n`);
});