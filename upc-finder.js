/**
 * UPC Finder Engine v5 for BlazeTools
 * Data Entry Specialist Engine: High-accuracy UPC/GTIN/EAN lookup
 * Prioritizes Manufacturer site -> Distributors. Strictly excludes Amazon & eBay.
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
 * - 12 digits: UPC-A
 * - 13 digits: EAN-13
 * - 11 digits: missing leading 0 (e.g. 697666197450) -> returns with pad
 * - 14 digits: GTIN-14 -> extracts inner 12 or 13 digits
 */
function parseBarcode(raw) {
  if (!raw) return null;
  let clean = String(raw).replace(/[^0-9]/g, '');

  if (/^(\d)\1+$/.test(clean)) return null;
  if (clean === '123456789012') return null;

  // 12 digits
  if (clean.length === 12) {
    return { code: clean, checksumValid: checksumUPCA(clean), is12: true };
  }
  // 13 digits
  if (clean.length === 13) {
    return { code: clean, checksumValid: checksumEAN13(clean), is12: false };
  }
  // 11 digits -> pad leading zero
  if (clean.length === 11) {
    const padded = '0' + clean;
    return { code: padded, checksumValid: checksumUPCA(padded), is12: false, was11: true };
  }
  // 14 digits -> extract inner UPC/EAN
  if (clean.length === 14) {
    if (clean.startsWith('00')) {
      const inner = clean.substring(2);
      return { code: inner, checksumValid: checksumUPCA(inner), is12: true };
    }
    if (clean.startsWith('0')) {
      const inner = clean.substring(1);
      return { code: inner, checksumValid: checksumEAN13(inner), is12: false };
    }
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

  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const patterns = [
    // 1. Prefix: UPC / GTIN / Barcode / EAN prefix with optional hash/punctuation after separator
    // Matches: UPC697, UPC: 697, UPC #697, UPC: #697, UPC Code: #697, UPC/GTIN: #697, etc.
    // Also: trailing period — UPC: 697666850065.  -> lookahead allows [.,;)] as terminators
    /(?:upc(?:-?[a-z]+)?|gtin(?:-?(?:12|13|14))?|barcode|ean(?:-?(?:13|8))?|bar\s*code|universal\s*product\s*code)(?:\s*(?:\/|\band\b|\bor\b)\s*(?:upc|gtin|ean|barcode))?(?:\s*(?:code|number|num|no\.?|id|symbol))?(?:\s*\([^)]*\))?\s*[:#=\-,\s]*\s*#?\s*([0-9]{11,14})(?=[^0-9.,;)]|$)/gi,

    // 2. Trailing indicator: "697666850065. UPC" / "697666850065, UPC" / "697666850065 UPC"
    /(?:^|[^0-9])([0-9]{11,14})[.,;):\s]*(?:upc|gtin|barcode|ean)\b/gi,

    // 3. Standalone hash followed by 11-14 digits: #697666848994 or # 697666848994
    /#\s*([0-9]{11,14})(?=[^0-9]|$)/gi,

    // 4. Natural language: "UPC for this item is 697666850065" / "barcode is 697666850065."
    /(?:upc|gtin|barcode|ean|universal\s*product\s*code)(?:[^0-9]{1,80})([0-9]{11,14})(?=[^0-9]|$)/gi,
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(clean)) !== null) {
      const isStandaloneHash = pat.source.startsWith('/#') || pat.source.startsWith('#');
      const bc = parseBarcode(m[1]);
      if (bc) {
        // If captured solely by standalone '#', require either valid checksum or UPC keyword present in text
        if (isStandaloneHash && !bc.checksumValid && !/upc|gtin|barcode|ean/i.test(clean)) {
          continue;
        }
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

  // 4. HTML Table Cells
  const tdPattern = /<t[hd][^>]*>[^<]*(?:upc|gtin|ean|barcode)[^<]*<\/t[hd]>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = tdPattern.exec(html)) !== null) {
    const rawVal = m[1].replace(/<[^>]+>/g, '').trim();
    const bc = parseBarcode(rawVal);
    if (bc) candidates.push({ ...bc, source: pageUrl, sourceType: defaultSourceType, sourceName, field: 'table-cell' });
  }

  // 5. Definition Lists (e.g. <dt>UPC</dt><dd>#697666848994</dd>)
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

  const cleanItem = encodeURIComponent((itemNo || '').replace(/^(?:item\s*#?|part\s*#?|#)\s*/i, '').trim());

  // 1. Gekko-inc search
  try {
    const gekkoSearchUrl = `http://www.gekko-inc.com/store/search?orderby=position&orderway=desc&search_query=${cleanItem}`;
    const searchRes = await fetchPage(gekkoSearchUrl, 6000);
    if (searchRes) {
      const productLinkMatch = searchRes.match(/href="(http:\/\/www\.gekko-inc\.com\/store\/[a-z0-9\-_/]+\.html)"/i);
      if (productLinkMatch) {
        const prodUrl = productLinkMatch[1];
        const prodHtml = await fetchPage(prodUrl, 6000);
        if (prodHtml) {
          const upcs = extractCandidatesFromHtml(prodHtml, prodUrl, 'Distributor Site');
          candidates.push(...upcs);
        }
      }
    }
  } catch (_) {}

  return candidates;
}

// ─── Generate Smart Search Queries ───────────────────────────────────────────
function buildSearchQueries(itemNo, brand, productType) {
  const queries = [];
  const cleanItem = (itemNo || '').replace(/^(?:item\s*#?|part\s*#?|#)\s*/i, '').trim();

  if (brand) {
    const noDots = brand.replace(/\./g, '').trim(); // e.g. A.Y. McDonald -> AY McDonald
    const cleanBrand = brand.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    if (noDots && noDots !== brand) {
      queries.push(`${cleanItem} ${noDots} UPC`);
    }
    queries.push(`${cleanItem} ${cleanBrand} UPC`);
    queries.push(`${cleanItem} ${cleanBrand}`);
  } else {
    queries.push(`${cleanItem} UPC`);
  }

  if (productType) {
    queries.push(`${cleanItem} ${productType} UPC`);
  }

  return [...new Set(queries)].slice(0, 3);
}

// ─── Web Search via DuckDuckGo Lite (POST Method) ────────────────────────────
async function searchWebDistributors(brand, itemNo, productType) {
  const candidates = [];
  if (!itemNo) return candidates;

  const queries = buildSearchQueries(itemNo, brand, productType);
  const visitedUrls = new Set();

  for (const q of queries) {
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

        if (url.includes('uddg=')) {
          const uddgMatch = url.match(/uddg=([^'"&]+)/i);
          if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
        }
        if (url.startsWith('//')) url = 'https:' + url;

        if (!url || isExcludedDomain(url)) continue;

        // 1. Scan snippet from search engine
        const snipRaw = snippetMatches[i][1];
        const snipCands = extractFromCleanText(snipRaw, url, 'Distributor Site');
        for (const sc of snipCands) {
          candidates.push(sc);
        }

        // 2. If first 2 results, also visit live page
        if (i < 2 && !visitedUrls.has(url)) {
          visitedUrls.add(url);
          const pageHtml = await fetchPage(url, 6000);
          if (pageHtml) {
            const pageCands = extractCandidatesFromHtml(pageHtml, url, 'Distributor Site');
            for (const pc of pageCands) {
              candidates.push(pc);
            }
          }
        }
      }

      // If we found any candidates for this query, stop checking further queries
      if (candidates.length > 0) break;

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
        is12: cand.is12,
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
    if (cand.is12) entry.is12 = true;
  }

  // Sort: hasMfg -> (is12 && checksumValid) -> count
  const sorted = Array.from(upcMap.values()).sort((a, b) => {
    if (a.hasMfg && !b.hasMfg) return -1;
    if (!a.hasMfg && b.hasMfg) return 1;
    // 12-digit with valid checksum takes highest priority
    const aValid12 = a.is12 && a.checksumValid;
    const bValid12 = b.is12 && b.checksumValid;
    if (aValid12 && !bValid12) return -1;
    if (!aValid12 && bValid12) return 1;
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

  // STAGE 0: Check if itemNo or description already contains a formatted UPC (e.g. UPC697666848994 or #697666848994)
  if (itemNo) {
    const directBc = parseBarcode(itemNo);
    if (directBc && directBc.checksumValid) {
      allCandidates.push({
        ...directBc,
        source: 'Uploaded File',
        sourceType: 'File Data',
        sourceName: 'Item No Column',
        field: 'itemNo',
      });
    }
  }
  if (description) {
    const descCands = extractFromCleanText(description, 'Uploaded File', 'File Data');
    allCandidates.push(...descCands);
  }

  // STAGE 1: Check Manufacturer Reference Link (if provided)
  if (refLink && /^https?:\/\//i.test(refLink) && !isExcludedDomain(refLink)) {
    const mfgHtml = await fetchPage(refLink, 10000);
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
  checksumUPCA,
  checksumEAN13,
  extractFromCleanText,
  extractCandidatesFromHtml,
};
