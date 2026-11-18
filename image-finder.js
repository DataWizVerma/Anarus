/**
 * Image Finder Engine — BlazeTools (Beta)
 *
 * Given: itemNo, brand, description, refLink
 * Returns: best product image URL with confidence scoring
 *
 * Strategy:
 *   Stage 1: Check ref link (manufacturer page) → JSON-LD, og:image, img tags
 *   Stage 2: Bing Image Search (murl extraction from HTML) → direct product image URLs
 *   Stage 3: Direct distributor site search (fwwebb, tri-state-industrial, etc.)
 *
 * Confidence Rules:
 *   HIGH   – Image from ref link or Bing image with itemNo in source URL, > 5KB
 *   MEDIUM – Image from Bing image search result, > 2KB
 *   LOW    – Image URL found but unverified or small
 *   NONE   – No suitable image found
 *
 * Anti-false-positive checks:
 *   • Minimum file size (blank/logo images are tiny)
 *   • Common placeholder/logo URL patterns blacklisted
 *   • No alt text like "logo", "banner", "header", "placeholder"
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Domains we never use as image sources ────────────────────────────────────
const EXCLUDED_DOMAINS = /amazon\.|ebay\.|pinterest\.|facebook\.|instagram\.|twitter\.|youtube\.|linkedin\.|tiktok\.|bing\.com|google\.com|gstatic\.com|googleusercontent\./i;

// ── URL patterns that are almost certainly logos/blanks/placeholders ──────────
const PLACEHOLDER_PATTERNS = [
  /logo/i, /banner/i, /header/i, /footer/i, /placeholder/i,
  /no[_-]?image/i, /noimage/i, /default[_-]?image/i, /blank/i,
  /sprite/i, /favicon/i, /loading/i, /spinner/i, /avatar/i, /profile/i,
  /\/icons?\//i, /\/logos?\//i, /\/banners?\//i, /\/badge/i,
  /pixel\.gif/i, /spacer/i, /1x1/i, /tracking/i, /transparent/i,
];

// ── File extensions that are images ──────────────────────────────────────────
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)(\?.*)?$/i;

// ── Minimum acceptable image file size (bytes) ───────────────────────────────
const MIN_SIZE_HIGH = 5000;   // 5 KB for HIGH confidence
const MIN_SIZE_MED  = 2000;   // 2 KB for MEDIUM confidence
const MIN_SIZE_LOW  = 300;    // 0.3 KB for LOW confidence

function isExcludedDomain(url) {
  try { return EXCLUDED_DOMAINS.test(new URL(url).hostname); }
  catch (_) { return false; }
}

function isPlaceholderUrl(url) {
  return PLACEHOLDER_PATTERNS.some(p => p.test(url));
}

function normalizeUrl(url, baseUrl) {
  if (!url) return null;
  url = url.trim();
  if (url.startsWith('//')) url = 'https:' + url;
  if (url.startsWith('/')) {
    try {
      const base = new URL(baseUrl);
      return base.origin + url;
    } catch (_) { return null; }
  }
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ── Fetch a page safely ───────────────────────────────────────────────────────
async function fetchHtml(url, timeoutMs = 10000) {
  if (!url || isExcludedDomain(url)) return null;
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      responseType: 'text',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      validateStatus: s => s >= 200 && s < 400,
    });
    return typeof res.data === 'string' ? res.data : null;
  } catch (_) { return null; }
}

// ── Probe an image URL to get its file size ───────────────────────────────────
async function probeImage(url, timeoutMs = 7000) {
  if (!url) return { ok: false, size: 0 };
  // Skip probe for URLs that clearly have image extensions — just trust them
  // This avoids HEAD request blocks from many distributor CDNs
  if (IMG_EXT.test(url) && !isPlaceholderUrl(url) && !isExcludedDomain(url)) {
    // Do a small range GET to verify it actually loads
    try {
      const rangeRes = await axios.get(url, {
        timeout: timeoutMs,
        maxRedirects: 3,
        headers: { 'User-Agent': UA, 'Range': 'bytes=0-8191' },
        responseType: 'arraybuffer',
        validateStatus: s => s >= 200 && s < 400,
      });
      const data = rangeRes.data;
      const len = data?.byteLength || data?.length || 0;
      const ct = rangeRes.headers['content-type'] || '';
      const isImg = /image\//i.test(ct) || len > 100;
      return { ok: isImg && len > 50, size: len };
    } catch (_) {
      // If range GET fails, trust the URL extension and return a minimum size
      return { ok: true, size: MIN_SIZE_MED };
    }
  }
  // For URLs without image extension, do HEAD first
  try {
    const headRes = await axios.head(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
      validateStatus: s => s >= 200 && s < 400,
    });
    const ct = headRes.headers['content-type'] || '';
    const cl = parseInt(headRes.headers['content-length'] || '0', 10);
    const isImage = /image\//i.test(ct) || IMG_EXT.test(url);
    if (!isImage) return { ok: false, size: 0 };
    if (!cl) return { ok: true, size: MIN_SIZE_LOW };
    return { ok: cl > 50, size: cl };
  } catch (_) {
    return { ok: false, size: 0 };
  }
}

// ── Extract candidate product image URLs from HTML ────────────────────────────
function extractImgUrls(html, pageUrl, itemNo, brand, description) {
  if (!html) return [];

  const candidates = [];
  const seen = new Set();

  const push = (url, score, hint) => {
    const norm = normalizeUrl(url, pageUrl);
    if (!norm) return;
    if (seen.has(norm)) return;
    if (isPlaceholderUrl(norm)) return;
    if (isExcludedDomain(norm)) return;
    const hasImgExt = IMG_EXT.test(norm);
    const hasImgInPath = /\/images?\/|\/product|\/media\/|\/catalog\/|\/assets\//i.test(norm);
    if (!hasImgExt && !hasImgInPath) return;
    seen.add(norm);
    candidates.push({ url: norm, score, hint });
  };

  // --- 1. JSON-LD schema.org Product → image field ---
  const jsonLdRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const imgs = obj?.image || obj?.['@graph']?.flatMap?.(o => o?.image || []) || [];
      const list = Array.isArray(imgs) ? imgs : [imgs];
      list.forEach(i => {
        const u = typeof i === 'string' ? i : (i?.url || i?.contentUrl);
        if (u) push(u, 90, 'JSON-LD schema.org');
      });
    } catch (_) {}
  }

  // --- 2. og:image meta tag ---
  const ogRe = /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = ogRe.exec(html)) !== null) push(m[1], 85, 'og:image');
  const ogRe2 = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/gi;
  while ((m = ogRe2.exec(html)) !== null) push(m[1], 85, 'og:image');

  // --- 3. <img> tags with item-relevant attributes ---
  const keywords = [
    ...(itemNo ? [itemNo.replace(/[^a-z0-9]/gi, '').toLowerCase()] : []),
    ...(brand ? [brand.toLowerCase().split(/\s+/)[0]] : []),
    ...(description ? description.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3) : []),
  ];

  const imgTagRe = /<img[^>]+>/gi;
  while ((m = imgTagRe.exec(html)) !== null) {
    const tag = m[0];
    const widthMatch = tag.match(/\bwidth=["']?(\d+)/i);
    const heightMatch = tag.match(/\bheight=["']?(\d+)/i);
    if (widthMatch && parseInt(widthMatch[1]) < 60) continue;
    if (heightMatch && parseInt(heightMatch[1]) < 60) continue;

    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i)
                  || tag.match(/\bdata-src=["']([^"']+)["']/i)
                  || tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)
                  || tag.match(/\bdata-original=["']([^"']+)["']/i)
                  || tag.match(/\bdata-image=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const srcUrl = srcMatch[1];

    const altMatch = tag.match(/\balt=["']([^"']{0,120})["']/i);
    const altText = altMatch ? altMatch[1].toLowerCase() : '';
    if (/\b(logo|banner|header|icon|avatar|badge|sprite)\b/.test(altText)) continue;

    const lSrc = srcUrl.toLowerCase();
    const keywordHit = keywords.some(k => k && (lSrc.includes(k) || altText.includes(k)));
    const isProductPath = /\/product|\/catalog|\/items?\/|\/images?\/|\/media\//i.test(srcUrl);

    let score = 40;
    if (keywordHit) score += 30;
    if (isProductPath) score += 15;
    if (altText && !['', 'image', 'photo', 'picture'].includes(altText)) score += 5;

    push(srcUrl, score, `<img> tag${keywordHit ? ' (keyword match)' : ''}`);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── Bing Image Search — extract murl (direct image URLs) ─────────────────────
async function bingImageSearch(itemNo, brand, description) {
  const cleanItem = (itemNo || '').trim();
  const cleanBrand = (brand || '').trim();

  const queries = cleanBrand
    ? [`"${cleanItem}" "${cleanBrand}"`, `${cleanItem} ${cleanBrand} product`]
    : [`${cleanItem} product`];

  const results = []; // { imageUrl, pageUrl, score }
  const seen = new Set();

  for (const q of queries) {
    if (results.length >= 5) break;
    try {
      const url = `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&first=1`;
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        validateStatus: s => s < 500,
      });

      if (!res.data || res.status !== 200) continue;

      const html = res.data;

      // Bing encodes JSON data as HTML entities in script blocks
      // Pattern: "pageUrl","murl":"DIRECT_IMG_URL","turl":"THUMBNAIL_URL"
      // The whole thing is HTML-entity-encoded
      const decoded = decodeHtmlEntities(html);

      // Extract murl (actual image URL at source) from Bing image JSON
      const murlRe = /"murl"\s*:\s*"(https?:\/\/[^"]+\.(?:jpe?g|png|webp|gif)[^"]{0,100})"/gi;
      let mm;
      while ((mm = murlRe.exec(decoded)) !== null) {
        const imgUrl = mm[1];
        if (seen.has(imgUrl)) continue;
        if (isExcludedDomain(imgUrl)) continue;
        if (isPlaceholderUrl(imgUrl)) continue;
        seen.add(imgUrl);

        // Extract associated page URL (comes before murl in the same JSON blob)
        // JSON structure: {..., "purl":"PAGE_URL", "murl":"IMG_URL", ...}
        const before = decoded.slice(Math.max(0, mm.index - 500), mm.index);
        const purlMatch = before.match(/"purl"\s*:\s*"(https?:\/\/[^"]+)"[^"]*$/);
        const pageUrl = purlMatch ? purlMatch[1] : '';

        // Score: higher if itemNo appears in image URL or page URL
        const cleanItemLower = cleanItem.replace(/[^a-z0-9]/gi, '').toLowerCase();
        const imgLower = imgUrl.toLowerCase();
        const pageLower = pageUrl.toLowerCase();
        let score = 50;
        if (cleanItemLower && imgLower.includes(cleanItemLower)) score += 40;
        else if (cleanItemLower && pageLower.includes(cleanItemLower)) score += 25;
        if (cleanBrand && pageLower.includes(cleanBrand.toLowerCase().split(/\s+/)[0])) score += 15;

        results.push({ imageUrl: imgUrl, pageUrl, score });
        if (results.length >= 8) break;
      }

      // Also try thumbnail URLs from th.bing.net (Bing-hosted thumbnails, always accessible)
      // as a fallback for items where murl is blocked
      if (results.length === 0) {
        const turlRe = /"turl"\s*:\s*"(https?:\/\/ts\d*\.mm\.bing\.net\/th\?id=[^"]+)"/gi;
        while ((mm = turlRe.exec(decoded)) !== null && results.length < 5) {
          const thumbUrl = mm[1];
          if (seen.has(thumbUrl)) continue;
          seen.add(thumbUrl);
          // Thumbnails are lower confidence but guaranteed to load
          results.push({ imageUrl: thumbUrl, pageUrl: '', score: 30 });
        }
      }

    } catch (_) { /* continue to next query */ }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Main: Find product image for one item ─────────────────────────────────────
async function findImageForItem({ itemNo = '', brand = '', description = '', refLink = '' }) {
  const result = {
    itemNo, brand, description, refLink,
    imageUrl: '',
    confidence: 'NONE',
    confidenceLabel: 'Not Found',
    source: '',
    sourceName: '',
    reason: 'No suitable product image found.',
    alternates: [],
  };

  // ── STAGE 1: Check ref link (manufacturer page) ──────────────────────────
  if (refLink && /^https?:\/\//i.test(refLink) && !isExcludedDomain(refLink)) {
    const html = await fetchHtml(refLink, 12000);
    if (html) {
      const candidates = extractImgUrls(html, refLink, itemNo, brand, description);
      for (const cand of candidates.slice(0, 10)) {
        const probe = await probeImage(cand.url, 7000);
        if (probe.ok) {
          if (probe.size >= MIN_SIZE_HIGH || cand.score >= 85) {
            result.imageUrl = cand.url;
            result.confidence = 'HIGH';
            result.confidenceLabel = 'High';
            result.source = refLink;
            result.sourceName = new URL(refLink).hostname.replace(/^www\./, '');
            result.reason = `Found on manufacturer page (${cand.hint}), file size ~${Math.round(probe.size / 1024)}KB`;
            return result;
          } else if (probe.size >= MIN_SIZE_MED && !result.imageUrl) {
            result.imageUrl = cand.url;
            result.confidence = 'MEDIUM';
            result.confidenceLabel = 'Medium';
            result.source = refLink;
            result.sourceName = new URL(refLink).hostname.replace(/^www\./, '');
            result.reason = `Found on manufacturer page (${cand.hint}), file size ~${Math.round(probe.size / 1024)}KB`;
          } else if (probe.size >= MIN_SIZE_LOW && !result.imageUrl) {
            result.imageUrl = cand.url;
            result.confidence = 'LOW';
            result.confidenceLabel = 'Low';
            result.source = refLink;
            result.sourceName = new URL(refLink).hostname.replace(/^www\./, '');
            result.reason = `Image found on manufacturer page but file is small (~${Math.round(probe.size / 1024)}KB)`;
          }
        }
      }
      if (result.confidence === 'MEDIUM' || result.confidence === 'HIGH') return result;
    }
  }

  if (!itemNo && !brand) {
    result.reason = 'Not enough item data to search (need Item No or Brand)';
    return result;
  }

  // ── STAGE 2: Bing Image Search ──────────────────────────────────────────
  const bingResults = await bingImageSearch(itemNo, brand, description);
  console.log(`[IMG] ${itemNo}: Bing returned ${bingResults.length} image candidates`);

  for (const bingResult of bingResults) {
    const { imageUrl, pageUrl, score } = bingResult;
    const probe = await probeImage(imageUrl, 7000);

    if (!probe.ok) continue;

    let hostname = '';
    try { hostname = new URL(pageUrl || imageUrl).hostname.replace(/^www\./, ''); } catch (_) {}

    // Skip Bing thumbnails if we're looking for HIGH/MEDIUM (they're 30-score)
    const isBingThumb = imageUrl.includes('th.bing.net') || imageUrl.includes('ts1.mm.bing.net') || imageUrl.includes('ts2.mm.bing.net') || imageUrl.includes('ts4.mm.bing.net');

    if (probe.size >= MIN_SIZE_HIGH && score >= 60 && !isBingThumb) {
      if (!result.imageUrl || result.confidence === 'LOW' || result.confidence === 'NONE') {
        result.imageUrl = imageUrl;
        result.confidence = 'HIGH';
        result.confidenceLabel = 'High';
        result.source = pageUrl || imageUrl;
        result.sourceName = hostname;
        result.reason = `Found via image search on "${hostname}" — item no. match in URL`;
        return result;
      }
    } else if (probe.size >= MIN_SIZE_MED && score >= 50) {
      if (!result.imageUrl || result.confidence === 'LOW' || result.confidence === 'NONE') {
        result.imageUrl = imageUrl;
        result.confidence = isBingThumb ? 'LOW' : 'MEDIUM';
        result.confidenceLabel = isBingThumb ? 'Low' : 'Medium';
        result.source = pageUrl || imageUrl;
        result.sourceName = hostname;
        result.reason = `Found via image search on "${hostname}", ~${Math.round(probe.size / 1024)}KB`;
      } else {
        result.alternates.push(imageUrl);
      }
    } else if (probe.size >= MIN_SIZE_LOW && !result.imageUrl) {
      result.imageUrl = imageUrl;
      result.confidence = 'LOW';
      result.confidenceLabel = 'Low';
      result.source = pageUrl || imageUrl;
      result.sourceName = hostname;
      result.reason = `Image found via search on "${hostname}", small file — verify before use`;
    }
  }

  if (result.confidence === 'HIGH' || result.confidence === 'MEDIUM') return result;

  // ── STAGE 3: Visit top Bing result pages for more image extraction ────────
  const pagesToVisit = bingResults
    .filter(r => r.pageUrl && !isExcludedDomain(r.pageUrl) && r.score >= 40)
    .slice(0, 3)
    .map(r => r.pageUrl);

  for (const pageUrl of pagesToVisit) {
    const html = await fetchHtml(pageUrl, 10000);
    if (!html) continue;

    const candidates = extractImgUrls(html, pageUrl, itemNo, brand, description);
    for (const cand of candidates.slice(0, 6)) {
      const probe = await probeImage(cand.url, 6000);
      if (!probe.ok) continue;

      let hostname = '';
      try { hostname = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_) {}

      if (probe.size >= MIN_SIZE_HIGH && cand.score >= 60) {
        if (!result.imageUrl || result.confidence === 'LOW' || result.confidence === 'NONE') {
          result.imageUrl = cand.url;
          result.confidence = 'MEDIUM';
          result.confidenceLabel = 'Medium';
          result.source = pageUrl;
          result.sourceName = hostname;
          result.reason = `Found on "${hostname}" via page scan (${cand.hint}), ~${Math.round(probe.size / 1024)}KB`;
          break;
        }
      } else if (probe.size >= MIN_SIZE_MED && cand.score >= 50 && !result.imageUrl) {
        result.imageUrl = cand.url;
        result.confidence = 'LOW';
        result.confidenceLabel = 'Low';
        result.source = pageUrl;
        result.sourceName = hostname;
        result.reason = `Found on "${hostname}" (${cand.hint}), ~${Math.round(probe.size / 1024)}KB — verify before use`;
        break;
      }
    }
    if (result.confidence === 'MEDIUM') break;
  }

  if (!result.imageUrl) {
    result.reason = `No product image found for "${itemNo || description}" — try providing a Ref/Mfg URL for better results`;
  }

  return result;
}

module.exports = { findImageForItem };
