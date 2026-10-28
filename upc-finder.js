/**
 * UPC Finder Engine for BlazeTools
 * Data Entry Specialist Tool: High-accuracy UPC/GTIN/EAN lookup
 * Prioritizes Manufacturer site -> Distributers. Excludes Amazon & eBay.
 * Includes check-digit validation and multi-source consensus/review flagging.
 */

const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── UPC / EAN Check-Digit Validation ────────────────────────────────────────
function isValidUPCA(str) {
  if (!str) return false;
  const clean = String(str).trim();
  if (!/^\d{12}$/.test(clean)) return false;
  if (/^(\d)\1{11}$/.test(clean)) return false; // Rejects 000000000000, 111111111111
  if (clean === '123456789012' || clean === '012345678905') {
    // Note: 012345678905 actually has a valid check digit, but test dummy sequences
  }
  let oddSum = 0, evenSum = 0;
  for (let i = 0; i < 11; i++) {
    const d = parseInt(clean[i], 10);
    if (i % 2 === 0) oddSum += d; // 1st, 3rd, 5th, 7th, 9th, 11th digit
    else evenSum += d;
  }
  const total = (oddSum * 3) + evenSum;
  const checkDigit = (10 - (total % 10)) % 10;
  return checkDigit === parseInt(clean[11], 10);
}

function isValidEAN13(str) {
  if (!str) return false;
  const clean = String(str).trim();
  if (!/^\d{13}$/.test(clean)) return false;
  if (/^(\d)\1{12}$/.test(clean)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = parseInt(clean[i], 10);
    sum += (i % 2 === 0) ? d : d * 3;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(clean[12], 10);
}

function normalizeAndValidateUPC(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/[^0-9]/g, '');
  if (clean.length === 12 && isValidUPCA(clean)) return clean;
  if (clean.length === 13 && isValidEAN13(clean)) return clean;
  if (clean.length === 14) {
    if (clean.startsWith('00') && isValidUPCA(clean.substring(2))) return clean.substring(2);
    if (clean.startsWith('0') && isValidEAN13(clean.substring(1))) return clean.substring(1);
  }
  return null;
}

// ─── Filter Excluded Domains (Amazon & eBay STRICTLY EXCLUDED) ────────────────
function isExcludedDomain(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (/(?:^|\.)amazon\.[a-z.]+$/i.test(host)) return true;
    if (/(?:^|\.)ebay\.[a-z.]+$/i.test(host)) return true;
    if (/amazon|ebay/i.test(host)) return true;
    return false;
  } catch (_) {
    return /amazon|ebay/i.test(url);
  }
}

function getHostName(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '');
  } catch (_) {
    return url;
  }
}

// ─── Fetch web page safely ───────────────────────────────────────────────────
async function fetchPage(url, timeoutMs = 12000) {
  if (isExcludedDomain(url)) return null;
  try {
    const res = await axios({
      method: 'GET',
      url,
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  } catch (_) {
    return null;
  }
}

// ─── Extract candidate UPCs from HTML / Structured Data ──────────────────────
function extractCandidatesFromHtml(html, pageUrl, defaultSourceType = 'Distributor Site') {
  const candidates = [];
  if (!html) return candidates;

  const sourceName = getHostName(pageUrl);

  // 1. JSON-LD structured data
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const traverse = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          const lk = k.toLowerCase();
          if (['gtin', 'gtin12', 'gtin13', 'gtin14', 'upc', 'ean', 'barcode'].includes(lk)) {
            const valid = normalizeAndValidateUPC(v);
            if (valid) {
              candidates.push({
                upc: valid,
                source: pageUrl,
                sourceType: defaultSourceType,
                sourceName,
                field: k,
              });
            }
          } else if (typeof v === 'object') {
            traverse(v);
          }
        }
      };
      traverse(parsed);
    } catch (_) {}
  }

  // 2. Meta tags
  const metaRegex = /<meta\s+[^>]*(?:property|name|itemprop)=["']([^"']*(?:upc|gtin|ean|barcode)[^"']*)["'][^>]*content=["']([^"']+)["']/gi;
  while ((match = metaRegex.exec(html)) !== null) {
    const valid = normalizeAndValidateUPC(match[2]);
    if (valid) {
      candidates.push({
        upc: valid,
        source: pageUrl,
        sourceType: defaultSourceType,
        sourceName,
        field: match[1],
      });
    }
  }

  // Content before property variation
  const metaRegex2 = /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']([^"']*(?:upc|gtin|ean|barcode)[^"']*)["']/gi;
  while ((match = metaRegex2.exec(html)) !== null) {
    const valid = normalizeAndValidateUPC(match[1]);
    if (valid) {
      candidates.push({
        upc: valid,
        source: pageUrl,
        sourceType: defaultSourceType,
        sourceName,
        field: match[2],
      });
    }
  }

  // 3. Data attributes
  const dataAttrRegex = /data-(?:upc|gtin|ean|barcode)=["']([^"']+)["']/gi;
  while ((match = dataAttrRegex.exec(html)) !== null) {
    const valid = normalizeAndValidateUPC(match[1]);
    if (valid) {
      candidates.push({
        upc: valid,
        source: pageUrl,
        sourceType: defaultSourceType,
        sourceName,
        field: 'data-attr',
      });
    }
  }

  // 4. HTML text regex patterns near keywords
  const textPattern = /(?:upc(?:-a)?|gtin(?:-12|-13)?|barcode|ean(?:-13)?)\s*[:#\-\s]+\s*([0-9]{12,14})\b/gi;
  while ((match = textPattern.exec(html)) !== null) {
    const valid = normalizeAndValidateUPC(match[1]);
    if (valid) {
      candidates.push({
        upc: valid,
        source: pageUrl,
        sourceType: defaultSourceType,
        sourceName,
        field: 'text-pattern',
      });
    }
  }

  return candidates;
}

// ─── UpcItemDb Trial Search ──────────────────────────────────────────────────
async function searchUpcItemDb(brand, itemNo, desc) {
  const candidates = [];
  // Build query
  const parts = [brand, itemNo].filter(Boolean);
  if (!parts.length) return candidates;
  const q = parts.join(' ').trim();

  try {
    const url = `https://api.upcitemdb.com/prod/trial/lookup?s=${encodeURIComponent(q)}`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      validateStatus: (s) => s === 200,
    });

    const items = res.data?.items;
    if (Array.isArray(items)) {
      for (const it of items) {
        const valid = normalizeAndValidateUPC(it.upc || it.ean);
        if (valid) {
          const itemUrl = `https://www.upcitemdb.com/upc/${valid}`;
          candidates.push({
            upc: valid,
            source: itemUrl,
            sourceType: 'Distributor / Barcode DB',
            sourceName: 'UpcItemDb',
            field: 'api-match',
            title: it.title || '',
          });
        }
      }
    }
  } catch (_) {}

  return candidates;
}

// ─── DuckDuckGo Lite / HTML Web & Distributor Search ─────────────────────────
async function searchWebAndDistributors(brand, itemNo, productType, desc) {
  const candidates = [];
  const queryTerms = [brand, itemNo, productType, 'UPC'].filter(Boolean).join(' ');
  if (!queryTerms.trim()) return candidates;

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryTerms)}`;
  const html = await fetchPage(searchUrl, 10000);
  if (!html) return candidates;

  // Extract result links & snippets
  // DuckDuckGo HTML format:
  // <a class="result__url" href="..."> or <a class="result__snippet" ...>
  const resultRegex = /<a[^>]*class=["'][^"']*result__url[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const linksToVisit = [];
  let match;

  while ((match = resultRegex.exec(html)) !== null) {
    let rawUrl = match[1];
    // DDG redirect wrapper: //duckduckgo.com/l/?uddg=URL
    if (rawUrl.includes('uddg=')) {
      try {
        const u = new URL('https:' + (rawUrl.startsWith('//') ? rawUrl : '//' + rawUrl));
        rawUrl = decodeURIComponent(u.searchParams.get('uddg') || rawUrl);
      } catch (_) {}
    }

    if (isExcludedDomain(rawUrl)) continue;

    const snippet = (match[3] || '').replace(/<[^>]+>/g, ' ');

    // Check snippet directly for UPC
    const snippetCandidates = extractCandidatesFromHtml(snippet, rawUrl, 'Distributor / Web');
    for (const c of snippetCandidates) {
      candidates.push(c);
    }

    if (rawUrl.startsWith('http') && linksToVisit.length < 2) {
      linksToVisit.push(rawUrl);
    }
  }

  // Also check top 2 non-excluded distributor links directly
  for (const visitUrl of linksToVisit) {
    if (isExcludedDomain(visitUrl)) continue;
    const pageHtml = await fetchPage(visitUrl, 8000);
    if (pageHtml) {
      const pageCandidates = extractCandidatesFromHtml(pageHtml, visitUrl, 'Distributor Site');
      for (const c of pageCandidates) {
        candidates.push(c);
      }
    }
  }

  return candidates;
}

// ─── Consensus & Conflict Resolution ─────────────────────────────────────────
function resolveConsensus(candidates, refLinkProvided) {
  if (!candidates || candidates.length === 0) {
    return {
      upc: '',
      status: 'Not Found',
      statusType: 'not_found', // not_found, found, verified, review
      confidence: 'None',
      sourceLink: '',
      sourceType: '—',
      sourceName: '—',
      reviewNotes: 'No valid UPC found on Manufacturer or distributor sites.',
      allSources: [],
      alternatives: [],
    };
  }

  // Deduplicate and group by UPC
  const upcMap = new Map();

  for (const cand of candidates) {
    if (!upcMap.has(cand.upc)) {
      upcMap.set(cand.upc, {
        upc: cand.upc,
        count: 0,
        sources: [],
        hasMfg: false,
      });
    }
    const entry = upcMap.get(cand.upc);
    entry.count++;
    // Avoid duplicate source URL in entry
    if (!entry.sources.some(s => s.source === cand.source)) {
      entry.sources.push({
        source: cand.source,
        sourceType: cand.sourceType,
        sourceName: cand.sourceName,
      });
    }
    if (cand.sourceType === 'Manufacturer Site') {
      entry.hasMfg = true;
    }
  }

  // Sort UPCs by frequency descending, then by hasMfg
  const sorted = Array.from(upcMap.values()).sort((a, b) => {
    if (a.hasMfg && !b.hasMfg) return -1;
    if (!a.hasMfg && b.hasMfg) return 1;
    return b.count - a.count;
  });

  const top = sorted[0];
  const distinctUpcCount = sorted.length;

  // Best source link for top UPC
  let bestSource = top.sources[0]?.source || '';
  let bestSourceType = top.sources[0]?.sourceType || 'Web';
  let bestSourceName = top.sources[0]?.sourceName || '';

  // If manufacturer source exists, use it as primary source link
  const mfgSource = top.sources.find(s => s.sourceType === 'Manufacturer Site');
  if (mfgSource) {
    bestSource = mfgSource.source;
    bestSourceType = mfgSource.sourceType;
    bestSourceName = mfgSource.sourceName;
  }

  // Conflict detection: Multiple different UPCs found
  if (distinctUpcCount > 1) {
    const altDescriptions = sorted.slice(1).map(
      s => `${s.upc} (${s.count} source${s.count > 1 ? 's' : ''} on ${s.sources.map(src => src.sourceName).join(', ')})`
    );

    return {
      upc: top.upc,
      status: 'Need to Review',
      statusType: 'review',
      confidence: top.count > 1 ? 'Medium (Conflict)' : 'Low (Conflict)',
      sourceLink: bestSource,
      sourceType: bestSourceType,
      sourceName: bestSourceName,
      reviewNotes: `Conflict detected! Recommended: ${top.upc} (${top.count} vote${top.count > 1 ? 's' : ''}), Alternatives: ${altDescriptions.join('; ')}`,
      allSources: top.sources,
      alternatives: sorted,
    };
  }

  // Single distinct UPC found across sources
  if (top.hasMfg) {
    return {
      upc: top.upc,
      status: 'Verified (Mfg)',
      statusType: 'verified',
      confidence: 'High',
      sourceLink: bestSource,
      sourceType: 'Manufacturer Site',
      sourceName: bestSourceName,
      reviewNotes: `Verified directly on Manufacturer site${top.count > 1 ? ` (+${top.count - 1} distributor)` : ''}.`,
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
      reviewNotes: `Matched across ${top.count} independent sources (${srcNames}).`,
      allSources: top.sources,
      alternatives: [],
    };
  }

  // Single source
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

  // STAGE 1: Check Manufacturer Reference Link if provided
  if (refLink && /^https?:\/\//i.test(refLink) && !isExcludedDomain(refLink)) {
    const mfgHtml = await fetchPage(refLink, 12000);
    if (mfgHtml) {
      const mfgCandidates = extractCandidatesFromHtml(mfgHtml, refLink, 'Manufacturer Site');
      allCandidates.push(...mfgCandidates);
    }
  }

  // STAGE 2: Search UpcItemDb API
  try {
    const dbCandidates = await searchUpcItemDb(brand, itemNo, description);
    allCandidates.push(...dbCandidates);
  } catch (_) {}

  // STAGE 3: Search Web / Distributors (if needed or to cross-verify)
  // If we already have a verified manufacturer UPC, we still do a quick web search to confirm consensus or conflicts
  try {
    const webCandidates = await searchWebAndDistributors(brand, itemNo, productType, description);
    allCandidates.push(...webCandidates);
  } catch (_) {}

  // Filter out any candidates from Amazon or eBay that may have slipped in
  const safeCandidates = allCandidates.filter(c => !isExcludedDomain(c.source));

  // Resolve consensus and return final record
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
  isValidUPCA,
  isValidEAN13,
  normalizeAndValidateUPC,
  isExcludedDomain,
  findUpcForItem,
};
