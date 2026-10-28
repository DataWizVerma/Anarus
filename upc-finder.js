/**
 * UPC Finder Engine v3 for BlazeTools
 * Data Entry Specialist Engine: High-accuracy UPC/GTIN/EAN lookup
 * Prioritizes Manufacturer site -> Distributors. Excludes Amazon & eBay.
 * 
 * Supports:
 * - 11-digit UPCs (auto-prepends leading 0 to make 12 digits, e.g. 69766619669 -> 069766619669)
 * - 12-digit UPC-A
 * - 13-digit EAN-13
 * - 14-digit GTIN-14
 * - Checksum awareness without discarding valid distributor codes
 * - Direct distributor searches (Gekko-inc, PumpCatalog, etc.)
 * - DuckDuckGo Lite multi-query search with full URL extraction
 */

const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── UPC / EAN Check-Digit Calculation ───────────────────────────────────────
function checksumUPCA(str) {
  if (!/^\d{12}$/.test(str)) return false;
  let oddSum = 0, evenSum = 0;
  for (let i = 0; i < 11; i++) {
    const d = parseInt(str[i], 10);
    if (i % 2 === 0) oddSum += d;
    else evenSum += d;
  }
  const total = (oddSum * 3) + evenSum;
  const checkDigit = (10 - (total % 10)) % 10;
  return checkDigit === parseInt(str[11], 10);
}

function checksumEAN13(str) {
  if (!/^\d{13}$/.test(str)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = parseInt(str[i], 10);
    sum += (i % 2 === 0) ? d : d * 3;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(str[12], 10);
}

/**
 * Normalizes barcode numbers:
 * - 11 digits: adds leading 0 (e.g. 69766619669 -> 069766619669)
 * - 12 digits: UPC-A
 * - 13 digits: EAN-13
 * - 14 digits: GTIN-14 -> extracts inner 12 or 13 digits
 */
function parseBarcode(raw) {
  if (!raw) return null;
  let clean = String(raw).replace(/[^0-9]/g, '');

  // Reject invalid / dummy sequences
  if (/^(\d)\1+$/.test(clean)) return null;
  if (clean === '123456789012') return null;

  // 11 digits -> pad leading zero
  if (clean.length === 11) {
    clean = '0' + clean;
  }

  // 14 digits -> extract inner UPC/EAN
  if (clean.length === 14) {
    if (clean.startsWith('00')) clean = clean.substring(2);
    else if (clean.startsWith('0')) clean = clean.substring(1);
  }

  if (clean.length === 12) {
    return { code: clean, checksumValid: checksumUPCA(clean) };
  }
  if (clean.length === 13) {
    return { code: clean, checksumValid: checksumEAN13(clean) };
  }
  return null;
}

// ─── Filter Excluded Domains (Amazon & eBay STRICTLY EXCLUDED) ────────────────
function isExcludedDomain(url) {
  if (!url) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/(?:^|\.)amazon\.[a-z.]+$/i.test(host)) return true;
    if (/(?:^|\.)ebay\.[a-z.]+$/i.test(host)) return true;
    return false;
  } catch (_) {
    return /amazon|ebay/i.test(url);
  }
}

function getHostName(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); }
  catch (_) { return url; }
}

// ─── Fetch web page safely ───────────────────────────────────────────────────
async function fetchPage(url, timeoutMs = 9000) {
  if (isExcludedDomain(url)) return null;
  try {
    const res = await axios({
      method: 'GET',
      url,
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      responseType: 'text',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return typeof res.data === 'string' ? res.data : String(res.data);
  } catch (_) {
    return null;
  }
}

// ─── Extract candidate barcodes from HTML ────────────────────────────────────
function extractCandidatesFromHtml(html, pageUrl, defaultSourceType) {
  const candidates = [];
  if (!html) return candidates;
  const sourceName = getHostName(pageUrl);

  // 1. JSON-LD structured data (schema.org Product)
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const traverse = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(traverse); return; }
        for (const [k, v] of Object.entries(obj)) {
          const lk = k.toLowerCase();
          if (['gtin', 'gtin12', 'gtin13', 'gtin14', 'upc', 'ean', 'barcode'].includes(lk)) {
            const bc = parseBarcode(v);
            if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: k });
          } else if (typeof v === 'object') {
            traverse(v);
          }
        }
      };
      traverse(JSON.parse(m[1]));
    } catch (_) {}
  }

  // 2. Meta tags
  const metaRe = /<meta[^>]+(?:property|name|itemprop)=["']([^"']*?)["'][^>]+content=["']([^"']+?)["']/gi;
  while ((m = metaRe.exec(html)) !== null) {
    if (/upc|gtin|ean|barcode/i.test(m[1])) {
      const bc = parseBarcode(m[2]);
      if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: m[1] });
    }
  }

  // 3. Data attributes
  const dataAttrRe = /data-(?:upc|gtin|ean|barcode)=["']([^"']+)["']/gi;
  while ((m = dataAttrRe.exec(html)) !== null) {
    const bc = parseBarcode(m[1]);
    if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: 'data-attr' });
  }

  // 4. Text near UPC / Barcode / GTIN keywords (supports 11-14 digits)
  const keywordPatterns = [
    /(?:upc(?:-?a)?|gtin(?:-?12|-?13|-?14)?|barcode|ean(?:-?13)?|universal\s*product\s*code)\s*[:#=\-,\s]+\s*([0-9]{11,14})\b/gi,
    /\b([0-9]{11,14})\s*[:#=\-,\s]+\s*(?:upc|gtin|barcode|ean)\b/gi,
    /<t[hd][^>]*>[^<]*(?:upc|gtin|ean|barcode)[^<]*<\/t[hd]>\s*<td[^>]*>\s*([0-9]{11,14})\s*<\/td>/gi,
    /<(?:span|div|dd|p|li)[^>]*>[^<]*(?:upc|gtin|ean|barcode)[^<]*<\/(?:span|div|dd|p|li)>\s*(?:<[^>]+>\s*)*([0-9]{11,14})\b/gi,
  ];

  for (const pat of keywordPatterns) {
    while ((m = pat.exec(html)) !== null) {
      const bc = parseBarcode(m[1]);
      if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: 'text-pattern' });
    }
  }

  return candidates;
}

// ─── Direct Industrial Distributor Check ─────────────────────────────────────
async function checkDirectDistributors(brand, itemNo) {
  const candidates = [];
  if (!itemNo) return candidates;

  const cleanItem = encodeURIComponent(itemNo.trim());

  // 1. Gekko-inc search (contains massive industrial & pump catalog with exact UPCs)
  try {
    const gekkoSearchUrl = `http://www.gekko-inc.com/store/search?orderby=position&orderway=desc&search_query=${cleanItem}`;
    const searchRes = await fetchPage(gekkoSearchUrl, 7000);
    if (searchRes) {
      // Find direct product link
      const productLinkMatch = searchRes.match(/href="(http:\/\/www\.gekko-inc\.com\/store\/[a-z0-9\-_/]+\.html)"/i);
      if (productLinkMatch) {
        const prodUrl = productLinkMatch[1];
        const prodHtml = await fetchPage(prodUrl, 7000);
        if (prodHtml) {
          const upcs = extractCandidatesFromHtml(prodHtml, prodUrl, 'Distributor Site');
          candidates.push(...upcs);
        }
      }
    }
  } catch (_) {}

  // 2. WaterPumpsPro search
  try {
    const wppSearchUrl = `https://waterpumpspro.com/search?q=${cleanItem}`;
    const wppHtml = await fetchPage(wppSearchUrl, 7000);
    if (wppHtml) {
      const wppUpcs = extractCandidatesFromHtml(wppHtml, wppSearchUrl, 'Distributor Site');
      candidates.push(...wppUpcs);
    }
  } catch (_) {}

  return candidates;
}

// ─── Web Search via DuckDuckGo Lite ──────────────────────────────────────────
async function searchWebDistributors(brand, itemNo, productType) {
  const candidates = [];
  if (!itemNo) return candidates;

  // Build clean search queries
  const queries = [];
  if (brand) {
    queries.push(`${itemNo} ${brand} UPC`);
    queries.push(`${itemNo} ${brand}`);
  } else {
    queries.push(`${itemNo} UPC`);
  }

  const visitedUrls = new Set();

  for (const q of queries) {
    if (candidates.length > 0) break; // If already found, skip additional searches to remain fast

    try {
      const ddgRes = await axios.get('https://lite.duckduckgo.com/lite/', {
        params: { q },
        timeout: 9000,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!ddgRes.data) continue;

      // Extract result URLs from DuckDuckGo uddg redirect links
      const uddgRe = /href=['"]([^'"]*uddg=([^'"&]+)[^'"]*)['"]/gi;
      let m;
      const targetUrls = [];

      while ((m = uddgRe.exec(ddgRes.data)) !== null) {
        const decoded = decodeURIComponent(m[2]);
        if (decoded.startsWith('http') && !isExcludedDomain(decoded)) {
          if (!visitedUrls.has(decoded) && targetUrls.length < 5) {
            targetUrls.push(decoded);
            visitedUrls.add(decoded);
          }
        }
      }

      // Check each distributor page
      for (const targetUrl of targetUrls) {
        const pageHtml = await fetchPage(targetUrl, 7000);
        if (pageHtml) {
          const found = extractCandidatesFromHtml(pageHtml, targetUrl, 'Distributor Site');
          if (found.length) {
            candidates.push(...found);
            break; // Found on this distributor, stop checking more pages
          }
        }
      }
    } catch (_) {}
  }

  return candidates;
}

// ─── Consensus & Conflict Resolution ─────────────────────────────────────────
function resolveConsensus(candidates, refLinkProvided) {
  if (!candidates || candidates.length === 0) {
    return {
      upc: '',
      status: 'Not Found',
      statusType: 'not_found',
      confidence: 'None',
      sourceLink: '',
      sourceType: '—',
      sourceName: '—',
      reviewNotes: 'No valid UPC found on Manufacturer or distributor sites.',
      allSources: [],
      alternatives: [],
    };
  }

  // Group by barcode value
  const upcMap = new Map();

  for (const cand of candidates) {
    if (!upcMap.has(cand.code)) {
      upcMap.set(cand.code, {
        upc: cand.code,
        count: 0,
        sources: [],
        hasMfg: false,
        checksumValid: cand.checksumValid,
      });
    }
    const entry = upcMap.get(cand.code);
    entry.count++;
    if (!entry.sources.some(s => s.source === cand.source)) {
      entry.sources.push({
        source: cand.source,
        sourceType: cand.sourceType,
        sourceName: cand.sourceName,
      });
    }
    if (cand.sourceType === 'Manufacturer Site') entry.hasMfg = true;
    if (cand.checksumValid) entry.checksumValid = true;
  }

  // Sort: hasMfg -> checksumValid -> count
  const sorted = Array.from(upcMap.values()).sort((a, b) => {
    if (a.hasMfg && !b.hasMfg) return -1;
    if (!a.hasMfg && b.hasMfg) return 1;
    if (a.checksumValid && !b.checksumValid) return -1;
    if (!a.checksumValid && b.checksumValid) return 1;
    return b.count - a.count;
  });

  const top = sorted[0];
  const distinctCount = sorted.length;

  let bestSource = top.sources[0]?.source || '';
  let bestSourceType = top.sources[0]?.sourceType || 'Distributor Site';
  let bestSourceName = top.sources[0]?.sourceName || '';

  const mfgSource = top.sources.find(s => s.sourceType === 'Manufacturer Site');
  if (mfgSource) {
    bestSource = mfgSource.source;
    bestSourceType = mfgSource.sourceType;
    bestSourceName = mfgSource.sourceName;
  }

  // Conflict: Multiple different UPCs found
  if (distinctCount > 1) {
    const altDescs = sorted.slice(1).map(
      s => `${s.upc} (${s.count} source${s.count > 1 ? 's' : ''}: ${s.sources.map(x => x.sourceName).join(', ')})`
    );
    return {
      upc: top.upc,
      status: 'Need to Review',
      statusType: 'review',
      confidence: top.count > 1 ? 'Medium (Conflict)' : 'Low (Conflict)',
      sourceLink: bestSource,
      sourceType: bestSourceType,
      sourceName: bestSourceName,
      reviewNotes: `Conflict! Recommended: ${top.upc} (${top.count} source${top.count > 1 ? 's' : ''}), Alternatives: ${altDescs.join('; ')}`,
      allSources: top.sources,
      alternatives: sorted,
    };
  }

  // Single UPC found
  if (top.hasMfg) {
    return {
      upc: top.upc,
      status: 'Verified (Mfg)',
      statusType: 'verified',
      confidence: 'High',
      sourceLink: bestSource,
      sourceType: 'Manufacturer Site',
      sourceName: bestSourceName,
      reviewNotes: `Verified on Manufacturer site${top.count > 1 ? ` (+${top.count - 1} distributor)` : ''}.`,
      allSources: top.sources,
      alternatives: [],
    };
  }

  if (top.count >= 2) {
    const srcNames = top.sources.map(s => s.sourceName).filter(Boolean).slice(0, 3).join(', ');
    return {
      upc: top.upc,
      status: 'Verified (Multi-Source)',
      statusType: 'verified',
      confidence: 'High',
      sourceLink: bestSource,
      sourceType: bestSourceType,
      sourceName: bestSourceName,
      reviewNotes: `Confirmed by ${top.count} independent sources (${srcNames}).`,
      allSources: top.sources,
      alternatives: [],
    };
  }

  return {
    upc: top.upc,
    status: 'Found',
    statusType: 'found',
    confidence: 'Medium',
    sourceLink: bestSource,
    sourceType: bestSourceType,
    sourceName: bestSourceName,
    reviewNotes: `Found on ${bestSourceName || bestSourceType}.`,
    allSources: top.sources,
    alternatives: [],
  };
}

// ─── Main Item Processing Function ───────────────────────────────────────────
async function findUpcForItem(item) {
  const {
    itemNo = '',
    productType = '',
    description = '',
    brand = '',
    refLink = '',
  } = item;

  const allCandidates = [];

  // STAGE 1: Check Manufacturer Reference Link (if provided)
  if (refLink && /^https?:\/\//i.test(refLink) && !isExcludedDomain(refLink)) {
    const mfgHtml = await fetchPage(refLink, 12000);
    if (mfgHtml) {
      const mfgUpcs = extractCandidatesFromHtml(mfgHtml, refLink, 'Manufacturer Site');
      allCandidates.push(...mfgUpcs);
    }
  }

  // STAGE 2: Direct Industrial / Distributor Check
  if (allCandidates.length === 0) {
    try {
      const directUpcs = await checkDirectDistributors(brand, itemNo);
      allCandidates.push(...directUpcs);
    } catch (_) {}
  }

  // STAGE 3: Web Search via DuckDuckGo Lite
  if (allCandidates.length === 0) {
    try {
      const webUpcs = await searchWebDistributors(brand, itemNo, productType);
      allCandidates.push(...webUpcs);
    } catch (_) {}
  }

  // Strictly filter out any Amazon / eBay sources
  const safeCandidates = allCandidates.filter(c => !isExcludedDomain(c.source));

  // Resolve consensus and format output
  const result = resolveConsensus(safeCandidates, !!refLink);

  return {
    itemNo,
    brand,
    productType,
    description,
    refLink,
    ...result,
  };
}

module.exports = {
  findUpcForItem,
  parseBarcode,
};
