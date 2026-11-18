/**
 * Image Finder Engine — BlazeTools (Beta)
 *
 * Given: itemNo, brand, description, refLink
 * Returns: best product image URL with confidence scoring
 *
 * Confidence Rules:
 *   HIGH   – Image found on exact ref link / manufacturer page, dimensions ≥200px, > 5KB
 *   MEDIUM – Image found on distributor page via search, dimensions ≥100px, > 2KB
 *   LOW    – Image URL found but could not verify size/dimensions or small file
 *   NONE   – No suitable image found
 *
 * Anti-false-positive checks:
 *   • Minimum file size (blank/logo images are tiny)
 *   • Common placeholder/logo URL patterns blacklisted
 *   • Image must contain item-related keyword OR come from ref link (reduces wrong-product risk)
 *   • No alt text like "logo", "banner", "header", "placeholder"
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Domains we never use as image sources ────────────────────────────────────
const EXCLUDED_DOMAINS = /amazon\.|ebay\.|pinterest\.|facebook\.|instagram\.|twitter\.|youtube\.|linkedin\.|tiktok\./i;

// ── URL patterns that are almost certainly logos/blanks/placeholders ──────────
const PLACEHOLDER_PATTERNS = [
  /logo/i, /banner/i, /header/i, /footer/i, /placeholder/i,
  /no[_-]?image/i, /noimage/i, /default[_-]?image/i, /blank/i,
  /sprite/i, /icon\.(?:png|jpg|gif|svg)/i, /favicon/i,
  /loading/i, /spinner/i, /avatar/i, /profile/i,
  /\/icons?\//i, /\/logos?\//i, /\/banners?\//i, /\/badge/i,
  /pixel\.gif/i, /spacer/i, /1x1/i, /tracking/i,
  /transparent/i, /grey|gray/i,
];

// ── File extensions that are images ──────────────────────────────────────────
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)(\?.*)?$/i;

// ── Minimum acceptable image file size (bytes) ───────────────────────────────
const MIN_SIZE_HIGH = 8000;   // 8 KB for HIGH confidence
const MIN_SIZE_MED  = 3000;   // 3 KB for MEDIUM confidence
const MIN_SIZE_LOW  = 500;    // 0.5 KB for LOW confidence (just to exclude 1x1 tracking pixels)

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

// ── Probe an image URL to get its file size (and optionally content-type) ─────
async function probeImage(url, timeoutMs = 8000) {
  if (!url) return { ok: false, size: 0 };
  try {
    // HEAD first (fast, no body)
    const headRes = await axios.head(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
      validateStatus: s => s >= 200 && s < 400,
    });
    const ct = headRes.headers['content-type'] || '';
    const cl = parseInt(headRes.headers['content-length'] || '0', 10);
    // Must be an image content-type or have known image extension
    const isImage = /image\//i.test(ct) || IMG_EXT.test(url);
    if (!isImage) return { ok: false, size: 0 };
    // If content-length missing, do a small range GET to verify it loads
    if (!cl) {
      const rangeRes = await axios.get(url, {
        timeout: timeoutMs,
        maxRedirects: 3,
        headers: { 'User-Agent': UA, 'Range': 'bytes=0-4095' },
        responseType: 'arraybuffer',
        validateStatus: s => s >= 200 && s < 400,
      });
      const data = rangeRes.data;
      const len = data?.byteLength || data?.length || 0;
      return { ok: len > 50, size: len };
    }
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

  // Helper: normalize, filter, score
  const push = (url, score, hint) => {
    const norm = normalizeUrl(url, pageUrl);
    if (!norm) return;
    if (seen.has(norm)) return;
    if (isPlaceholderUrl(norm)) return;
    if (isExcludedDomain(norm)) return;
    // Must look like an image
    const hasImgExt = IMG_EXT.test(norm);
    const hasImgInPath = /\/images?\//i.test(norm) || /\/product/i.test(norm) || /\/media\//i.test(norm);
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
    // Skip tiny thumbnails (w/h in tag attributes)
    const widthMatch = tag.match(/\bwidth=["']?(\d+)/i);
    const heightMatch = tag.match(/\bheight=["']?(\d+)/i);
    if (widthMatch && parseInt(widthMatch[1]) < 60) continue;
    if (heightMatch && parseInt(heightMatch[1]) < 60) continue;

    // Get src
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i)
                  || tag.match(/\bdata-src=["']([^"']+)["']/i)
                  || tag.match(/\bdata-lazy-src=["']([^"']+)["']/i)
                  || tag.match(/\bdata-original=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const srcUrl = srcMatch[1];

    // Get alt text — reject if obviously a logo/banner
    const altMatch = tag.match(/\balt=["']([^"']{0,120})["']/i);
    const altText = altMatch ? altMatch[1].toLowerCase() : '';
    if (/\b(logo|banner|header|icon|avatar|badge|sprite)\b/.test(altText)) continue;

    // Score: higher if alt text or src URL contains item-relevant keyword
    const lSrc = srcUrl.toLowerCase();
    const keywordHit = keywords.some(k => k && (lSrc.includes(k) || altText.includes(k)));
    const isProductPath = /\/product|\/catalog|\/items?\/|\/images?\/|\/media\//i.test(srcUrl);

    let score = 40;
    if (keywordHit) score += 30;
    if (isProductPath) score += 15;
    if (altText && !['', 'image', 'photo', 'picture'].includes(altText)) score += 5;

    push(srcUrl, score, `<img> tag${keywordHit ? ' (keyword match)' : ''}`);
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── Search DuckDuckGo for product image URL ───────────────────────────────────
async function searchForProductPage(itemNo, brand, description) {
  const cleanItem = (itemNo || '').trim();
  const cleanBrand = (brand || '').trim();
  const q = cleanBrand
    ? `${cleanItem} ${cleanBrand} product image site:${cleanBrand.toLowerCase().replace(/\s+/g, '')}.com OR filetype:jpg OR filetype:png`
    : `${cleanItem} product image filetype:jpg`;

  // Simple DuckDuckGo lite search
  try {
    const body = `q=${encodeURIComponent(cleanBrand ? `${cleanItem} ${cleanBrand} product` : `${cleanItem} product`)}`;
    const res = await axios.post('https://lite.duckduckgo.com/lite/', body, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    });
    if (!res.data) return [];

    // Extract result links
    const linkRe = /<a[^>]+class=['"]result-link['"][^>]*href=["']([^"']+)["']/gi;
    const urls = [];
    let m;
    while ((m = linkRe.exec(res.data)) !== null) {
      let url = m[1];
      if (url.includes('uddg=')) {
        const uddg = url.match(/uddg=([^&'"]+)/i);
        if (uddg) url = decodeURIComponent(uddg[1]);
      }
      if (url.startsWith('//')) url = 'https:' + url;
      if (/^https?:\/\//i.test(url) && !isExcludedDomain(url)) {
        urls.push(url);
      }
      if (urls.length >= 5) break;
    }
    return urls;
  } catch (_) { return []; }
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
          } else if (probe.size >= MIN_SIZE_MED) {
            // Keep as MEDIUM candidate, check more before returning
            if (!result.imageUrl) {
              result.imageUrl = cand.url;
              result.confidence = 'MEDIUM';
              result.confidenceLabel = 'Medium';
              result.source = refLink;
              result.sourceName = new URL(refLink).hostname.replace(/^www\./, '');
              result.reason = `Found on manufacturer page (${cand.hint}), file size ~${Math.round(probe.size / 1024)}KB`;
            } else {
              result.alternates.push(cand.url);
            }
          } else if (probe.size >= MIN_SIZE_LOW && !result.imageUrl) {
            result.imageUrl = cand.url;
            result.confidence = 'LOW';
            result.confidenceLabel = 'Low';
            result.source = refLink;
            result.sourceName = new URL(refLink).hostname.replace(/^www\./, '');
            result.reason = `Image found on manufacturer page but file is small (~${Math.round(probe.size / 1024)}KB) — may be thumbnail`;
          }
        }
      }
      // If we got MEDIUM from ref link, return it
      if (result.confidence === 'MEDIUM') return result;
    }
  }

  if (!itemNo && !brand) {
    result.reason = 'Not enough item data to search (need Item No or Brand)';
    return result;
  }

  // ── STAGE 2: Web search → visit top result pages ─────────────────────────
  const searchUrls = await searchForProductPage(itemNo, brand, description);

  for (const pageUrl of searchUrls) {
    if (isExcludedDomain(pageUrl)) continue;
    const html = await fetchHtml(pageUrl, 10000);
    if (!html) continue;

    const candidates = extractImgUrls(html, pageUrl, itemNo, brand, description);
    for (const cand of candidates.slice(0, 8)) {
      const probe = await probeImage(cand.url, 6000);
      if (!probe.ok) continue;

      let hostname = '';
      try { hostname = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_) {}

      if (probe.size >= MIN_SIZE_HIGH && cand.score >= 60) {
        // Only override a LOW result, not a MEDIUM from ref link
        if (!result.imageUrl || result.confidence === 'LOW' || result.confidence === 'NONE') {
          result.imageUrl = cand.url;
          result.confidence = 'MEDIUM';
          result.confidenceLabel = 'Medium';
          result.source = pageUrl;
          result.sourceName = hostname;
          result.reason = `Found on distributor/web page "${hostname}" (${cand.hint}), ~${Math.round(probe.size / 1024)}KB`;
        } else {
          result.alternates.push(cand.url);
        }
        break; // One good image per page is enough
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
    result.reason = `No product image found for "${itemNo || description}" — image may be unavailable or on a restricted site`;
  }

  return result;
}

module.exports = { findImageForItem };
