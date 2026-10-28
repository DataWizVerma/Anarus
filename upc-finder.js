/**
 * UPC Finder Engine v4 for BlazeTools
 * Data Entry Specialist Engine: High-accuracy UPC/GTIN/EAN lookup
 * Prioritizes Manufacturer site -> Distributors. Strictly excludes Amazon & eBay.
 * 
 * Features:
 * - Snippet + Live Page extraction (captures UPCs even when sites require login/JS)
 * - HTML tag stripping before matching so <b>UPC</b> or <span class="label">UPC</span> matches
 * - Handles all UPC formats: UPC123456789012, UPC: ..., UPC #..., UPC-A, GTIN, EAN, Barcode
 * - Normalizes 11-digit codes with leading zero (e.g. 697666197450 or 69766619669 -> 069766619669)
 * - Multi-query search via POST to DuckDuckGo Lite (avoids 202 bot challenges)
 * - Direct industrial distributor search (Gekko-inc, etc.)
 * - Consensus voting & conflict detection
 */

const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

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
async function fetchPage(url, timeoutMs = 8000) {
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

// ─── Extract candidate barcodes from Clean Text (Snippets / Elements) ────────
function extractFromCleanText(text, sourceUrl, defaultSourceType) {
  const candidates = [];
  if (!text) return candidates;
  const sourceName = getHostName(sourceUrl);

  // Strip all HTML tags & normalize whitespace
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const patterns = [
    // UPC 123456789012, UPC: 123456789012, UPC#123456789012, UPC123456789012 (no space)
    /(?:upc(?:-?a)?|gtin(?:-?12|-?13|-?14)?|barcode|ean(?:-?13)?|universal\s*product\s*code)\s*[:#=\-,\s]*\s*([0-9]{11,14})\b/gi,
    // 123456789012 UPC
    /\b([0-9]{11,14})\s*[:#=\-,\s]*\s*(?:upc|gtin|barcode|ean)\b/gi,
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(clean)) !== null) {
      const bc = parseBarcode(m[1]);
      if (bc) {
        candidates.push({
          ...bc,
          source: sourceUrl,
          sourceType: defaultSourceType,
          sourceName,
          field: 'text-pattern',
        });
      }
    }
  }

  return candidates;
}

// ─── Extract candidate barcodes from Full HTML Page ──────────────────────────
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
  const metaRe2 = /<meta[^>]+content=["']([^"']+?)["'][^>]+(?:property|name|itemprop)=["']([^"']*?)["']/gi;
  while ((m = metaRe2.exec(html)) !== null) {
    if (/upc|gtin|ean|barcode/i.test(m[2])) {
      const bc = parseBarcode(m[1]);
      if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: m[2] });
    }
  }

  // 3. Data attributes
  const dataAttrRe = /data-(?:upc|gtin|ean|barcode)=["']([^"']+)["']/gi;
  while ((m = dataAttrRe.exec(html)) !== null) {
    const bc = parseBarcode(m[1]);
    if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: 'data-attr' });
  }

  // 4. HTML Table Cells (e.g. <th>UPC</th><td>697666197450</td>)
  const tdPattern = /<t[hd][^>]*>[^<]*(?:upc|gtin|ean|barcode)[^<]*<\/t[hd]>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = tdPattern.exec(html)) !== null) {
    const rawVal = m[1].replace(/<[^>]+>/g, '').trim();
    const bc = parseBarcode(rawVal);
    if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: 'table-cell' });
  }

  // 5. Definition Lists (e.g. <dt>UPC</dt><dd>697666197450</dd>)
  const dlPattern = /<dt[^>]*>[^<]*(?:upc|gtin|ean|barcode)[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  while ((m = dlPattern.exec(html)) !== null) {
    const rawVal = m[1].replace(/<[^>]+>/g, '').trim();
    const bc = parseBarcode(rawVal);
    if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: 'def-list' });
  }

  // 6. Clean text pattern scan across entire page body
  const textCands = extractFromCleanText(html, pageUrl, defaultSourceType);
  candidates.push(...textCands);

  return candidates;
}

// ─── Direct Industrial Distributor Check ─────────────────────────────────────
async function checkDirectDistributors(brand, itemNo) {
  const candidates = [];
  if (!itemNo) return candidates;

  const cleanItem = encodeURIComponent(itemNo.trim());

  // 1. Gekko-inc search (massive distributor catalog with exact UPCs)
  try {
    const gekkoSearchUrl = `http://www.gekko-inc.com/store/search?orderby=position&orderway=desc&search_query=${cleanItem}`;
    const searchRes = await fetchPage(gekkoSearchUrl, 7000);
    if (searchRes) {
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

  return candidates;
}

// ─── Web Search via DuckDuckGo Lite (POST Method) ────────────────────────────
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
    if (candidates.length > 0) break; // If already found, stop early to maintain speed

    try {
      const postBody = `q=${encodeURIComponent(q)}`;
      const ddgRes = await axios.post('https://lite.duckduckgo.com/lite/', postBody, {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
      });

      if (!ddgRes.data) continue;

      const html = ddgRes.data;
      const linkMatches = [...html.matchAll(/<a[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
      const snippetMatches = [...html.matchAll(/<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/gi)];

      const maxResults = Math.min(linkMatches.length, snippetMatches.length);

      for (let i = 0; i < maxResults; i++) {
        const linkTag = linkMatches[i][0];
        const rawHrefMatch = linkTag.match(/href=['"]([^'"]+)['"]/i);
        let url = rawHrefMatch ? rawHrefMatch[1] : '';

        // Decode uddg if wrapped in DuckDuckGo redirect
        if (url.includes('uddg=')) {
          const uddgMatch = url.match(/uddg=([^'"&]+)/i);
          if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
        }
        if (url.startsWith('//')) url = 'https:' + url;

        // Skip excluded domains (Amazon & eBay)
        if (!url || isExcludedDomain(url)) continue;

        // 1. Check Snippet directly! (Captures UPC from search engine index even if live page blocks)
        const snipRaw = snippetMatches[i][1];
        const snipCands = extractFromCleanText(snipRaw, url, 'Distributor Site');
        if (snipCands.length) {
          candidates.push(...snipCands);
          break; // Found high-accuracy snippet match, stop checking further results for this query
        }

        // 2. If not in snippet, visit live distributor page (top 3 results)
        if (i < 3 && !visitedUrls.has(url)) {
          visitedUrls.add(url);
          const pageHtml = await fetchPage(url, 7000);
          if (pageHtml) {
            const pageCands = extractCandidatesFromHtml(pageHtml, url, 'Distributor Site');
            if (pageCands.length) {
              candidates.push(...pageCands);
              break;
            }
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

  // STAGE 2: Direct Industrial / Distributor Check (Gekko-inc, etc.)
  if (allCandidates.length === 0) {
    try {
      const directUpcs = await checkDirectDistributors(brand, itemNo);
      allCandidates.push(...directUpcs);
    } catch (_) {}
  }

  // STAGE 3: Web Search via DuckDuckGo Lite (Snippets + Live Pages)
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
