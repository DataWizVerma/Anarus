const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// ─── Image / File Proxy (CORS bypass for browser canvas) ─────────────────────
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 30000,
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

const CONCURRENCY = 15;
const REQUEST_TIMEOUT = 18000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Per-URL link check ──────────────────────────────────────────────────────
async function checkLink(url, cancelled) {
  if (cancelled.value) return { url, isBroken: true, statusMessage: 'Cancelled' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

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

if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n  🚀 BlazeTools running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;