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
  return true; // don't fail length check here
}

function normalizeStr(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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

  // 3. Query upcitemdb.com
  const url = `https://www.upcitemdb.com/upc/${cleanUpc}`;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.upcitemdb.com/'
      },
      timeout: 12000,
      validateStatus: () => true
    });

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
        dbModel: ''
      };
    }

    const html = res.data;

    // Extract title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    let dbTitle = titleMatch ? titleMatch[1].replace(/\|\s*upcitemdb\.com/i, '').replace(/^UPC\s*\d+\s*-\s*/i, '').trim() : '';

    // Extract table info
    const info = {};
    const trMatches = html.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const tdMatches = tr.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
      if (tdMatches.length >= 2) {
        const key = tdMatches[0].replace(/<[^>]+>/g, '').trim().toLowerCase();
        const val = tdMatches[1].replace(/<[^>]+>/g, '').trim();
        if (key && val) info[key] = val;
      }
    }

    const dbBrand = info['brand:'] || info['brand'] || '';
    const dbModel = info['model #:'] || info['model'] || info['part number'] || '';

    // 4. Compare with user's Item No
    const normItemNo = normalizeStr(itemNo);
    const normDbModel = normalizeStr(dbModel);
    const normDbTitle = normalizeStr(dbTitle);

    let isMatch = false;
    let matchReason = '';

    if (normItemNo) {
      if (normDbModel && (normDbModel === normItemNo || normDbModel.includes(normItemNo) || normItemNo.includes(normDbModel))) {
        isMatch = true;
        matchReason = `Exact model match: "${dbModel || itemNo}"`;
      } else if (normDbTitle && normDbTitle.includes(normItemNo)) {
        isMatch = true;
        matchReason = `Item No found in title: "${dbTitle}"`;
      } else if (dbModel && normDbModel !== normItemNo) {
        // DB explicitly has a DIFFERENT model number
        isMatch = false;
        matchReason = `Mismatch: UPC belongs to model "${dbModel}", expected "${itemNo}"`;
      } else {
        // Model not listed in DB, check if title or brand gives any clue
        const normBrand = normalizeStr(brand);
        const normDbBrand = normalizeStr(dbBrand);
        if (normBrand && normDbBrand && normDbBrand.includes(normBrand)) {
          isMatch = true;
          matchReason = `Brand match (${dbBrand}) but exact model not specified in title: "${dbTitle}"`;
        } else {
          isMatch = false;
          matchReason = `Item No "${itemNo}" not found in title "${dbTitle}"`;
        }
      }
    } else {
      // If no itemNo provided, we can only confirm UPC exists in DB
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
