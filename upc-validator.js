const axios = require('axios');

// ── Checksum Validators ──
function checksumUPCA(digits11) {
  let odd = 0, even = 0;
  for (let i = 0; i < 11; i++) {
    const d = parseInt(digits11[i], 10);
    if (i % 2 === 0) odd += d;
    else even += d;
  }
  const sum = odd * 3 + even;
  return (10 - (sum % 10)) % 10;
}

function isValidUpcChecksum(cleanUpc) {
  if (cleanUpc.length === 12) {
    const expected = checksumUPCA(cleanUpc.slice(0, 11));
    return parseInt(cleanUpc[11], 10) === expected;
  }
  if (cleanUpc.length === 13) {
    let odd = 0, even = 0;
    for (let i = 0; i < 12; i++) {
      const d = parseInt(cleanUpc[i], 10);
      if (i % 2 === 0) odd += d;
      else even += d;
    }
    const sum = odd + even * 3;
    const expected = (10 - (sum % 10)) % 10;
    return parseInt(cleanUpc[12], 10) === expected;
  }
  return true;
}

function normalizeStr(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Generate sensible normalization variants for an Item/Part Number
 * Handles leading zeros, suffixes, punctuation, and uppercase/lowercase.
 */
function getItemVariants(itemNo) {
  if (!itemNo) return [];
  const raw = String(itemNo).trim();
  const variants = new Set();
  const lower = raw.toLowerCase();
  variants.add(lower);

  // Pure alphanumeric
  const alphaNum = lower.replace(/[^a-z0-9]/g, '');
  if (alphaNum) variants.add(alphaNum);

  // Strip leading zeros: e.g. "0208036" -> "208036"
  const noLeadingZero = alphaNum.replace(/^0+/, '');
  if (noLeadingZero && noLeadingZero.length >= 3) variants.add(noLeadingZero);

  // Strip single-letter packaging or revision suffixes: e.g. "208036U" -> "208036"
  const noSuffix = alphaNum.replace(/[a-z]$/i, '');
  if (noSuffix && noSuffix.length >= 4) variants.add(noSuffix);

  return Array.from(variants);
}

/**
 * Parse upcitemdb HTML into structured product data including title, specs, variations, and store listings.
 */
function extractPageData(html) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  let dbTitle = titleMatch ? titleMatch[1].replace(/\|\s*upcitemdb\.com/i, '').replace(/^UPC\s*\d+\s*-\s*/i, '').trim() : '';

  const specs = {};
  const trMatches = html.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
  const storeRows = [];
  
  for (const tr of trMatches) {
    const tdMatches = tr.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
    if (tdMatches.length >= 2) {
      const col1 = tdMatches[0].replace(/<[^>]+>/g, '').trim();
      const col2 = tdMatches[1].replace(/<[^>]+>/g, '').trim();
      const key = col1.toLowerCase().replace(/:$/, '').trim();
      if (['brand', 'model #', 'model', 'part number', 'manufacturer', 'color'].includes(key)) {
        specs[key] = col2;
      } else if (!col1.toLowerCase().includes('stores') && col2) {
        storeRows.push(col2);
      }
    }
  }

  const dbBrand = specs['brand'] || specs['manufacturer'] || '';
  const dbModel = specs['model #'] || specs['model'] || specs['part number'] || '';

  // Extract from Product Name Variations list
  const variations = [];
  const varSectionMatch = html.match(/Product Name Variations:[\s\S]*?<\/ol>/i);
  if (varSectionMatch) {
    const liMatches = varSectionMatch[0].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    for (const li of liMatches) {
      const v = li.replace(/<[^>]+>/g, '').trim();
      if (v) variations.push(v);
    }
  }

  // Include store row descriptions
  for (const s of storeRows) {
    if (s && !variations.includes(s)) variations.push(s);
  }

  // Clean visible text of page
  const cleanPageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  return {
    dbTitle,
    dbBrand,
    dbModel,
    specs,
    variations,
    cleanPageText
  };
}

/**
 * Validate a single UPC against Item No / Brand / Description using upcitemdb.com
 */
async function validateUpcItem({ upc, itemNo, brand, description }) {
  const rawUpc = String(upc || '').trim();
  const cleanUpc = rawUpc.replace(/\D/g, '');

  if (!cleanUpc) {
    return {
      upc: rawUpc,
      itemNo,
      status: 'EMPTY',
      isValid: false,
      message: 'UPC is empty or missing'
    };
  }

  // 1. Length check
  if (cleanUpc.length < 12) {
    return {
      upc: rawUpc,
      cleanUpc,
      itemNo,
      status: 'INVALID_LENGTH',
      isValid: false,
      message: `UPC has ${cleanUpc.length} digits (expected 12 digits)`
    };
  }

  // 2. Checksum check
  if (cleanUpc.length === 12 && !isValidUpcChecksum(cleanUpc)) {
    const expected = checksumUPCA(cleanUpc.slice(0, 11));
    return {
      upc: rawUpc,
      cleanUpc,
      itemNo,
      status: 'INVALID_CHECKSUM',
      isValid: false,
      message: `Invalid checksum digit ${cleanUpc[11]} (expected ${expected})`
    };
  }

  // 3. Query upcitemdb.com (with retry on rate-limit)
  const url = `https://www.upcitemdb.com/upc/${cleanUpc}`;

  // Helper: check if the response is a rate-limit page (HTTP 200 but "Too Fast" body)
  function isRateLimitResponse(status, html) {
    if (status === 429) return true;
    if (typeof html !== 'string') return false;
    const lower = html.toLowerCase();
    if (lower.includes('too fast') || lower.includes('too many requests') || lower.includes('rate limit')) return true;
    // Title-only "Too Fast" page
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1].toLowerCase().trim() === 'too fast') return true;
    return false;
  }

  const MAX_RETRIES = 4;
  let res = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.upcitemdb.com/'
        },
        timeout: 20000,
        validateStatus: () => true
      });
    } catch (netErr) {
      if (attempt === MAX_RETRIES) throw netErr;
      await new Promise(r => setTimeout(r, attempt * 2000));
      continue;
    }

    if (isRateLimitResponse(res.status, res.data)) {
      if (attempt === MAX_RETRIES) {
        // All retries exhausted → return RATE_LIMITED status (never MISMATCH)
        return {
          upc: rawUpc,
          cleanUpc,
          itemNo,
          status: 'RATE_LIMITED',
          isValid: false,
          message: 'Database rate limit hit — retry later or reduce batch speed',
          dbTitle: '',
          dbBrand: '',
          dbModel: '',
          url
        };
      }
      // Wait exponentially: 3s, 6s, 9s before retrying
      const waitMs = attempt * 3000;
      console.log(`[upc-validator] Rate limited on attempt ${attempt} for ${cleanUpc}. Waiting ${waitMs}ms…`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Got a real response — break out of retry loop
    break;
  }

  try {
    if (res.status === 404 || res.data.includes('Page Not Found') || res.data.includes('No product found')) {
      return {
        upc: rawUpc,
        cleanUpc,
        itemNo,
        status: 'NOT_FOUND_IN_DB',
        isValid: false,
        message: 'UPC not found in database',
        dbTitle: '',
        dbBrand: '',
        dbModel: '',
        url
      };
    }

    const { dbTitle, dbBrand, dbModel, variations, cleanPageText } = extractPageData(res.data);
    const normDbModel = normalizeStr(dbModel);
    const normDbTitle = normalizeStr(dbTitle);
    const normPageText = normalizeStr(cleanPageText);

    let isMatch = false;
    let matchReason = '';

    const itemVariants = getItemVariants(itemNo);

    if (itemVariants.length > 0) {
      // Tier 1: Direct model check
      for (const v of itemVariants) {
        if (normDbModel && (normDbModel === v || normDbModel.includes(v) || v.includes(normDbModel))) {
          isMatch = true;
          matchReason = `Exact model match: "${dbModel || itemNo}"`;
          break;
        }
      }

      // Tier 2: Title check
      if (!isMatch) {
        for (const v of itemVariants) {
          if (normDbTitle && normDbTitle.includes(v)) {
            isMatch = true;
            matchReason = `Item No found in title: "${dbTitle}"`;
            break;
          }
        }
      }

      // Tier 3: Variations & Store Listings check (Build.com, Newegg, Walmart, etc.)
      if (!isMatch) {
        for (const v of itemVariants) {
          if (v.length >= 3) {
            const matchedVar = variations.find(varStr => normalizeStr(varStr).includes(v));
            if (matchedVar) {
              isMatch = true;
              matchReason = `Item No verified in product listings: "${matchedVar.slice(0, 60)}"`;
              break;
            }
          }
        }
      }

      // Tier 4: Page full text check (specifications, dimensions, descriptions)
      if (!isMatch) {
        for (const v of itemVariants) {
          if (v.length >= 4 && normPageText.includes(v)) {
            isMatch = true;
            matchReason = `Item No "${itemNo}" verified in database product data`;
            break;
          }
        }
      }

      // Tier 5: Description & Brand Match (Smart Fallback)
      if (!isMatch && (description || brand)) {
        const normBrand = normalizeStr(brand);
        const normDbBrand = normalizeStr(dbBrand);
        const brandMatches = normBrand && (normDbBrand.includes(normBrand) || normBrand.includes(normDbBrand) || normPageText.includes(normBrand));

        if (description) {
          const userWords = String(description).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !['the','and','for','with','each','inch','type','size'].includes(w));
          let matchCount = 0;
          for (const w of userWords) {
            if (normDbTitle.includes(w) || variations.some(v => v.toLowerCase().includes(w))) {
              matchCount++;
            }
          }
          const overlapRatio = userWords.length > 0 ? (matchCount / userWords.length) : 0;
          if (overlapRatio >= 0.5 || (brandMatches && matchCount >= 2)) {
            isMatch = true;
            matchReason = `Product & description match: "${dbTitle}"`;
          }
        } else if (brandMatches && !dbModel) {
          isMatch = true;
          matchReason = `Brand match (${dbBrand}) for UPC: "${dbTitle}"`;
        }
      }

      // If STILL not matched, then and only then flag MISMATCH
      if (!isMatch) {
        matchReason = `Mismatch: UPC belongs to "${dbTitle || dbModel || 'different product'}" (${dbBrand ? 'Brand: ' + dbBrand + ', ' : ''}Model: ${dbModel || 'N/A'}), does not match "${itemNo}"`;
      }

    } else if (description) {
      // No itemNo provided, but description provided
      const userWords = String(description).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
      let matchCount = 0;
      for (const w of userWords) {
        if (normDbTitle.includes(w) || variations.some(v => v.toLowerCase().includes(w))) {
          matchCount++;
        }
      }
      if (matchCount >= 2 || (userWords.length === 1 && matchCount === 1)) {
        isMatch = true;
        matchReason = `Description match: "${dbTitle}"`;
      } else {
        isMatch = true;
        matchReason = `UPC verified in DB: "${dbTitle}"`;
      }
    } else {
      // Neither itemNo nor description provided - check if UPC exists in DB
      isMatch = true;
      matchReason = `UPC verified in DB: "${dbTitle}"`;
    }

    return {
      upc: rawUpc,
      cleanUpc,
      itemNo,
      status: isMatch ? 'VALID' : 'MISMATCH',
      isValid: isMatch,
      message: matchReason,
      dbTitle,
      dbBrand,
      dbModel,
      url
    };

  } catch (err) {
    return {
      upc: rawUpc,
      cleanUpc,
      itemNo,
      status: 'LOOKUP_ERROR',
      isValid: false,
      message: `Error connecting to database: ${err.message}`
    };
  }
}

module.exports = {
  validateUpcItem,
  isValidUpcChecksum,
  checksumUPCA
};
