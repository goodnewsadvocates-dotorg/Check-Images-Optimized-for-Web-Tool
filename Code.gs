/**
 * Google Apps Script web app for scraping image data from any webpage.
 *
 * Features:
 * - Scrapes image URLs, alt, and title from a page
 * - Resolves relative image URLs
 * - Fetches each image to detect dimensions, byte size, and embedded PPI when available
 * - Supports JPEG JFIF density parsing and PNG pHYs parsing
 * - Returns deduplicated image data ready for table display and CSV export
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Image Optimization Checker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function analyzePage(pageUrl) {
  if (!pageUrl || !String(pageUrl).trim()) {
    throw new Error('Please provide a page URL.');
  }

  var normalizedPageUrl = normalizeUrl_(String(pageUrl).trim());
  var pageResponse;
  try {
    pageResponse = UrlFetchApp.fetch(normalizedPageUrl, {
      followRedirects: true,
      muteHttpExceptions: true,
      validateHttpsCertificates: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ImageOptimizationChecker/1.0)'
      }
    });
  } catch (err) {
    throw new Error('Unable to fetch page: ' + err.message);
  }

  var code = pageResponse.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Page request failed with HTTP ' + code + '.');
  }

  var html = pageResponse.getContentText();
  var scrapedImages = extractImgTags_(html, normalizedPageUrl);

  if (!scrapedImages.length) {
    return {
      pageUrl: normalizedPageUrl,
      scannedAt: new Date().toISOString(),
      totalImages: 0,
      rows: []
    };
  }

  var deduped = dedupeByUrl_(scrapedImages);
  var rows = [];

  for (var i = 0; i < deduped.length; i++) {
    var img = deduped[i];
    var metadata = inspectImage_(img.url);

    var ppiDisplay = metadata.ppi !== null ? metadata.ppi.toFixed(2) + ' PPI' : '';
    var optimizedForWeb = metadata.byteSize !== null ? metadata.byteSize <= 300 * 1024 : null;

    rows.push({
      filename: filenameFromUrl_(img.url),
      url: img.url,
      width: metadata.width,
      height: metadata.height,
      ppi: metadata.ppi,
      x_ppi: metadata.xPpi,
      y_ppi: metadata.yPpi,
      ppi_note: metadata.ppiNote,
      ppi_display: ppiDisplay,
      alt: img.alt,
      title: img.title,
      size_bytes: metadata.byteSize,
      size_kb: metadata.byteSize !== null ? +(metadata.byteSize / 1024).toFixed(2) : null,
      optimized_for_web: optimizedForWeb,
      optimization_note: optimizedForWeb === null
        ? 'Could not read image bytes'
        : optimizedForWeb
          ? 'Likely web-friendly size (<= 300 KB)'
          : 'Large image for web (> 300 KB)'
    });
  }

  return {
    pageUrl: normalizedPageUrl,
    scannedAt: new Date().toISOString(),
    totalImages: rows.length,
    rows: rows
  };
}

function normalizeUrl_(value) {
  if (/^https?:\/\//i.test(value)) return value;
  return 'https://' + value;
}

function extractImgTags_(html, baseUrl) {
  var out = [];
  var imgTagRegex = /<img\b[^>]*>/gi;
  var tags = html.match(imgTagRegex) || [];

  for (var i = 0; i < tags.length; i++) {
    var tag = tags[i];
    var candidateUrl = chooseBestImageUrlFromTag_(tag);
    if (!candidateUrl) continue;

    var resolved = resolveUrl_(baseUrl, candidateUrl.trim());
    if (!resolved) continue;

    resolved = decodeImageProxyUrl_(resolved, baseUrl);

    out.push({
      url: resolved,
      alt: decodeHtmlEntities_(getAttribute_(tag, 'alt') || ''),
      title: decodeHtmlEntities_(getAttribute_(tag, 'title') || '')
    });
  }

  return out;
}

function chooseBestImageUrlFromTag_(tag) {
  // Prioritize non-cached/original URL attributes first.
  var preferredAttrs = [
    'data-nitro-lazy-src',
    'data-nitro-src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-orig-file',
    'data-image',
    'src'
  ];

  for (var i = 0; i < preferredAttrs.length; i++) {
    var value = getAttribute_(tag, preferredAttrs[i]);
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }

  // Fallback to first URL in srcset/data-srcset when src is missing.
  var srcset = getAttribute_(tag, 'data-srcset') || getAttribute_(tag, 'srcset');
  if (srcset) {
    var first = parseFirstUrlFromSrcset_(srcset);
    if (first) return first;
  }

  return '';
}

function parseFirstUrlFromSrcset_(srcset) {
  var parts = String(srcset).split(',');
  if (!parts.length) return '';
  var first = String(parts[0]).trim();
  if (!first) return '';
  return first.split(/\s+/)[0] || '';
}

function decodeImageProxyUrl_(resolvedUrl, baseUrl) {
  if (!resolvedUrl) return resolvedUrl;

  // Common proxy/cached URL wrappers include the original URL in a query param.
  var wrapped = readQueryParam_(resolvedUrl, 'url')
    || readQueryParam_(resolvedUrl, 'src')
    || readQueryParam_(resolvedUrl, 'image')
    || readQueryParam_(resolvedUrl, 'img');

  if (wrapped) {
    var decoded = decodeURIComponentSafe_(wrapped);
    var nestedResolved = resolveUrl_(baseUrl, decoded);
    if (nestedResolved) return nestedResolved;
  }

  var nitroCdnDecoded = decodeNitroCdnProxyUrl_(resolvedUrl);
  if (nitroCdnDecoded) return nitroCdnDecoded;

  return normalizeNitroCachePath_(resolvedUrl);
}

function readQueryParam_(url, key) {
  var m = url.match(new RegExp('[?&]' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^&#]*)', 'i'));
  return m ? m[1] : '';
}

function decodeURIComponentSafe_(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, '%20'));
  } catch (err) {
    return value;
  }
}

function normalizeNitroCachePath_(url) {
  // NitroPack cache URLs often keep the same origin and file path but prepend cache segments.
  // Example patterns handled:
  // - /wp-content/cache/nitro/.../wp-content/uploads/.../image.jpg
  // - /wp-content/cache/nitro/.../image.jpg.webp (webp cache variant)
  var marker = '/wp-content/cache/nitro/';
  var idx = url.toLowerCase().indexOf(marker);
  if (idx === -1) return url;

  var originMatch = url.match(/^(https?:\/\/[^\/]+)/i);
  var origin = originMatch ? originMatch[1] : '';
  var path = url.substring(idx + marker.length);

  // Keep only the trailing original-like path segment when nested wp-content path is present.
  var nestedIdx = path.toLowerCase().indexOf('/wp-content/');
  if (nestedIdx !== -1) {
    return origin + path.substring(nestedIdx);
  }

  // Otherwise just strip the cache prefix and remove webp cache suffix if present.
  path = '/' + path.replace(/^\/+/, '');
  path = path.replace(/\.webp($|[?#])/i, '$1');
  return origin + path;
}

function decodeNitroCdnProxyUrl_(url) {
  // Nitro CDN optimized URLs frequently look like:
  // https://cdn-xxxxx.nitrocdn.com/<token>/assets/images/optimized/rev-<hash>/<original-host>/<original-path>
  // We recover the original by rebuilding https://<original-host>/<original-path>.
  var match = String(url).match(/\/assets\/images\/optimized\/rev-[^\/]+\/([^\/]+)\/(.+)$/i);
  if (!match) return '';

  var host = match[1] || '';
  var path = match[2] || '';
  if (!host || !path) return '';

  return 'https://' + host + '/' + path.replace(/^\/+/, '');
}

function getAttribute_(tag, attributeName) {
  var escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var patterns = [
    new RegExp('\\b' + escapedName + '\\s*=\\s*"([^"]*)"', 'i'),
    new RegExp("\\b" + escapedName + "\\s*=\\s*'([^']*)'", 'i'),
    new RegExp('\\b' + escapedName + '\\s*=\\s*([^\\s>]+)', 'i')
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = tag.match(patterns[i]);
    if (match && match[1] !== undefined) return match[1];
  }
  return '';
}

function resolveUrl_(baseUrl, maybeRelative) {
  if (!maybeRelative) return '';
  if (/^data:/i.test(maybeRelative)) return '';
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (/^\/\//.test(maybeRelative)) {
    return 'https:' + maybeRelative;
  }

  var parts = baseUrl.match(/^(https?:\/\/[^\/]+)(\/.*)?$/i);
  if (!parts) return '';
  var origin = parts[1];
  var basePath = parts[2] || '/';

  if (maybeRelative.charAt(0) === '/') {
    return origin + maybeRelative;
  }

  var dir = basePath.replace(/[^\/]*$/, '');
  var combined = dir + maybeRelative;
  return origin + normalizePath_(combined);
}

function normalizePath_(path) {
  var segments = path.split('/');
  var stack = [];

  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(seg);
  }

  return '/' + stack.join('/');
}

function dedupeByUrl_(images) {
  var seen = {};
  var out = [];
  for (var i = 0; i < images.length; i++) {
    var key = images[i].url;
    if (seen[key]) continue;
    seen[key] = true;
    out.push(images[i]);
  }
  return out;
}

function inspectImage_(imageUrl) {
  var result = {
    width: null,
    height: null,
    byteSize: null,
    ppi: null,
    xPpi: null,
    yPpi: null,
    ppiNote: ''
  };

  try {
    var response = UrlFetchApp.fetch(imageUrl, {
      followRedirects: true,
      muteHttpExceptions: true,
      validateHttpsCertificates: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ImageOptimizationChecker/1.0)'
      }
    });

    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      result.ppiNote = 'Image request failed with HTTP ' + response.getResponseCode();
      return result;
    }

    var blob = response.getBlob();
    var bytes = normalizeByteArray_(blob.getBytes());
    result.byteSize = bytes.length;

    var dimensions = getImageDimensions_(blob, bytes);
    result.width = dimensions.width;
    result.height = dimensions.height;

    var ppiInfo = extractPpiFromBlob_(blob, bytes);
    result.xPpi = ppiInfo.x;
    result.yPpi = ppiInfo.y;
    result.ppi = ppiInfo.ppi;
    result.ppiNote = ppiInfo.note;
  } catch (err) {
    result.ppiNote = 'Could not read metadata: ' + err.message;
  }

  return result;
}

function getImageDimensions_(blob, bytes) {
  var raw = bytes || normalizeByteArray_(blob.getBytes());
  var mime = (blob.getContentType() || '').toLowerCase();

  if (mime.indexOf('jpeg') !== -1 || mime.indexOf('jpg') !== -1 || looksLikeJpeg_(raw)) {
    return extractJpegDimensions_(raw);
  }
  if (mime.indexOf('png') !== -1 || looksLikePng_(raw)) {
    return extractPngDimensions_(raw);
  }
  if (mime.indexOf('gif') !== -1 || looksLikeGif_(raw)) {
    return extractGifDimensions_(raw);
  }
  if (mime.indexOf('webp') !== -1 || looksLikeWebp_(raw)) {
    return extractWebpDimensions_(raw);
  }

  return { width: null, height: null };
}

function extractPpiFromBlob_(blob, bytes) {
  var raw = bytes || normalizeByteArray_(blob.getBytes());
  var mime = blob.getContentType() || '';

  if (mime.indexOf('jpeg') !== -1 || mime.indexOf('jpg') !== -1 || looksLikeJpeg_(raw)) {
    return extractJpegPpi_(raw);
  }
  if (mime.indexOf('png') !== -1 || looksLikePng_(raw)) {
    return extractPngPpi_(raw);
  }

  return { x: null, y: null, ppi: null, note: 'No embedded DPI metadata found' };
}

function looksLikeJpeg_(bytes) {
  return bytes && bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
}

function looksLikePng_(bytes) {
  var sig = [0x89, 0x50, 0x4E, 0x47];
  if (!bytes || bytes.length < 4) return false;
  for (var i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

function extractJpegDimensions_(bytes) {
  var i = 2; // skip SOI
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xFF) {
      i++;
      continue;
    }

    var marker = bytes[i + 1];
    if (marker === 0xD9 || marker === 0xDA) break;

    var len = (bytes[i + 2] << 8) + bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) break;

    var isSof = (marker >= 0xC0 && marker <= 0xC3)
      || (marker >= 0xC5 && marker <= 0xC7)
      || (marker >= 0xC9 && marker <= 0xCB)
      || (marker >= 0xCD && marker <= 0xCF);

    if (isSof && i + 8 < bytes.length) {
      return {
        height: (bytes[i + 5] << 8) + bytes[i + 6],
        width: (bytes[i + 7] << 8) + bytes[i + 8]
      };
    }

    i += 2 + len;
  }

  return { width: null, height: null };
}

function extractPngDimensions_(bytes) {
  if (bytes.length < 24) return { width: null, height: null };
  return {
    width: readUInt32BE_(bytes, 16),
    height: readUInt32BE_(bytes, 20)
  };
}

function looksLikeGif_(bytes) {
  if (!bytes || bytes.length < 6) return false;
  var h = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  return h === 'GIF87a' || h === 'GIF89a';
}

function extractGifDimensions_(bytes) {
  if (!looksLikeGif_(bytes) || bytes.length < 10) {
    return { width: null, height: null };
  }
  return {
    width: bytes[6] + (bytes[7] << 8),
    height: bytes[8] + (bytes[9] << 8)
  };
}

function looksLikeWebp_(bytes) {
  if (!bytes || bytes.length < 12) return false;
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF'
    && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP';
}

function extractWebpDimensions_(bytes) {
  if (!looksLikeWebp_(bytes)) return { width: null, height: null };

  var i = 12;
  while (i + 8 <= bytes.length) {
    var chunkType = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    var chunkSize = readUInt32LE_(bytes, i + 4);
    var dataStart = i + 8;

    if (chunkType === 'VP8 ' && dataStart + 10 <= bytes.length) {
      return {
        width: ((bytes[dataStart + 7] << 8) | bytes[dataStart + 6]) & 0x3FFF,
        height: ((bytes[dataStart + 9] << 8) | bytes[dataStart + 8]) & 0x3FFF
      };
    }

    if (chunkType === 'VP8L' && dataStart + 5 <= bytes.length) {
      var b0 = bytes[dataStart + 1];
      var b1 = bytes[dataStart + 2];
      var b2 = bytes[dataStart + 3];
      var b3 = bytes[dataStart + 4];
      var width = 1 + (b0 | ((b1 & 0x3F) << 8));
      var height = 1 + (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10)) >>> 0);
      return { width: width, height: height };
    }

    if (chunkType === 'VP8X' && dataStart + 10 <= bytes.length) {
      var widthMinusOne = bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16);
      var heightMinusOne = bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16);
      return { width: widthMinusOne + 1, height: heightMinusOne + 1 };
    }

    i = dataStart + chunkSize + (chunkSize % 2);
  }

  return { width: null, height: null };
}

function extractJpegPpi_(bytes) {
  // Look for APP0 (JFIF) segment: density info at fixed positions.
  var i = 2; // skip SOI
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) {
      i++;
      continue;
    }

    var marker = bytes[i + 1];
    if (marker === 0xD9 || marker === 0xDA) break; // EOI or SOS

    var length = (bytes[i + 2] << 8) + bytes[i + 3];
    if (!length || i + 2 + length > bytes.length) break;

    if (marker === 0xE0) {
      var idStart = i + 4;
      if (bytes[idStart] === 0x4A && bytes[idStart + 1] === 0x46 && bytes[idStart + 2] === 0x49 && bytes[idStart + 3] === 0x46) {
        var units = bytes[idStart + 7];
        var xDensity = (bytes[idStart + 8] << 8) + bytes[idStart + 9];
        var yDensity = (bytes[idStart + 10] << 8) + bytes[idStart + 11];

        if (!xDensity || !yDensity) {
          return { x: null, y: null, ppi: null, note: 'No embedded DPI metadata found' };
        }

        var xPpi = null;
        var yPpi = null;

        if (units === 1) {
          xPpi = xDensity;
          yPpi = yDensity;
        } else if (units === 2) {
          xPpi = xDensity * 2.54;
          yPpi = yDensity * 2.54;
        } else {
          return { x: null, y: null, ppi: null, note: 'Density units unspecified in metadata' };
        }

        var avg = round2_((xPpi + yPpi) / 2);
        return {
          x: round2_(xPpi),
          y: round2_(yPpi),
          ppi: avg,
          note: ''
        };
      }
    }

    i += 2 + length;
  }

  return { x: null, y: null, ppi: null, note: 'No embedded DPI metadata found' };
}

function extractPngPpi_(bytes) {
  // PNG chunks start at byte 8. Look for pHYs chunk.
  var i = 8;
  while (i + 12 <= bytes.length) {
    var len = readUInt32BE_(bytes, i);
    var type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    var dataStart = i + 8;

    if (type === 'pHYs' && len >= 9 && dataStart + 9 <= bytes.length) {
      var xPpm = readUInt32BE_(bytes, dataStart);
      var yPpm = readUInt32BE_(bytes, dataStart + 4);
      var unit = bytes[dataStart + 8];

      if (unit === 1 && xPpm > 0 && yPpm > 0) {
        var xPpi = xPpm * 0.0254;
        var yPpi = yPpm * 0.0254;
        return {
          x: round2_(xPpi),
          y: round2_(yPpi),
          ppi: round2_((xPpi + yPpi) / 2),
          note: ''
        };
      }
      return { x: null, y: null, ppi: null, note: 'No embedded DPI metadata found' };
    }

    i += 12 + len;
  }

  return { x: null, y: null, ppi: null, note: 'No embedded DPI metadata found' };
}

function readUInt32BE_(bytes, idx) {
  return ((toUint8_(bytes[idx]) << 24) >>> 0)
    + ((toUint8_(bytes[idx + 1]) << 16) >>> 0)
    + ((toUint8_(bytes[idx + 2]) << 8) >>> 0)
    + (toUint8_(bytes[idx + 3]) >>> 0);
}

function readUInt32LE_(bytes, idx) {
  return (toUint8_(bytes[idx]) >>> 0)
    + ((toUint8_(bytes[idx + 1]) << 8) >>> 0)
    + ((toUint8_(bytes[idx + 2]) << 16) >>> 0)
    + ((toUint8_(bytes[idx + 3]) << 24) >>> 0);
}

function normalizeByteArray_(bytes) {
  var out = new Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) {
    out[i] = toUint8_(bytes[i]);
  }
  return out;
}

function toUint8_(value) {
  return value & 0xFF;
}

function round2_(num) {
  return Math.round(num * 100) / 100;
}

function filenameFromUrl_(url) {
  try {
    var clean = url.split('#')[0].split('?')[0];
    var bits = clean.split('/');
    return decodeURIComponent(bits[bits.length - 1] || '(no filename)');
  } catch (err) {
    return '(unknown)';
  }
}

function decodeHtmlEntities_(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
