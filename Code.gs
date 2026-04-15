/**
 * Google Apps Script web app that scrapes image metadata from a target webpage.
 * Deploy as Web App, then open the URL and enter a page to audit.
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Image Inventory + PPI Checker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Scrape image data from a webpage, download each image, and extract
 * dimensions + embedded PPI metadata when available.
 *
 * @param {string} pageUrl
 * @return {Object}
 */
function scrapePageImages(pageUrl) {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
    throw new Error('Please provide a valid http(s) URL.');
  }

  var html = UrlFetchApp.fetch(pageUrl, { muteHttpExceptions: true }).getContentText();
  var images = parseImagesFromHtml(html, pageUrl);

  var dedup = {};
  var rows = [];

  images.forEach(function (img) {
    if (dedup[img.url]) return;
    dedup[img.url] = true;

    var row = {
      filename: getFilenameFromUrl(img.url),
      url: img.url,
      width: img.width || '',
      height: img.height || '',
      ppi: null,
      ppiDisplay: '',
      ppiNote: '',
      alt: img.alt || '',
      title: img.title || '',
      bytes: null,
      kb: null,
      optimized: '',
      fetchStatus: 'ok',
    };

    try {
      var response = UrlFetchApp.fetch(img.url, {
        muteHttpExceptions: true,
        followRedirects: true,
      });

      var code = response.getResponseCode();
      if (code >= 400) {
        row.fetchStatus = 'HTTP ' + code;
        row.ppiNote = 'Image could not be downloaded';
        rows.push(row);
        return;
      }

      var blob = response.getBlob();
      var bytes = blob.getBytes();
      row.bytes = bytes.length;
      row.kb = Math.round((bytes.length / 1024) * 100) / 100;

      var type = (response.getHeaders()['Content-Type'] || '').toString().toLowerCase();
      var sizeData = extractDimensions(bytes, type, img.url);
      if (!row.width && sizeData.width) row.width = sizeData.width;
      if (!row.height && sizeData.height) row.height = sizeData.height;

      var ppiData = extractPpi(bytes, type, img.url);
      row.ppi = ppiData.ppi;
      row.ppiDisplay = ppiData.ppi ? ppiData.ppi.toFixed(2) + ' PPI' : '';
      row.ppiNote = ppiData.note || '';

      row.optimized = getOptimizationStatus(row.kb, row.width, row.height);
    } catch (err) {
      row.fetchStatus = 'error';
      row.ppiNote = 'Could not read metadata: ' + err.message;
    }

    rows.push(row);
  });

  return {
    sourceUrl: pageUrl,
    scannedAt: new Date().toISOString(),
    totalImages: images.length,
    uniqueImages: rows.length,
    rows: rows,
  };
}

/**
 * Optional helper: write latest run into a sheet tab.
 */
function writeResultsToSheet(payload) {
  if (!payload || !payload.rows) throw new Error('No payload rows found.');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this project from a bound spreadsheet to use sheet export.');

  var name = 'Image Audit';
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();

  var header = [
    'Filename', 'Image URL', 'Width', 'Height', 'File KB',
    'Resolution', 'Resolution Note', 'Optimized?', 'Alt text', 'Title', 'Fetch Status'
  ];

  var values = [header].concat(payload.rows.map(function (r) {
    return [
      r.filename,
      r.url,
      r.width,
      r.height,
      r.kb,
      r.ppiDisplay || '',
      r.ppiNote || '',
      r.optimized || '',
      r.alt || '',
      r.title || '',
      r.fetchStatus || ''
    ];
  }));

  sh.getRange(1, 1, values.length, header.length).setValues(values);
  sh.autoResizeColumns(1, header.length);

  return {
    sheetName: name,
    rowsWritten: payload.rows.length,
  };
}

function parseImagesFromHtml(html, baseUrl) {
  var regex = /<img\b[^>]*>/gi;
  var srcRegex = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;

  var out = [];
  var match;
  while ((match = regex.exec(html)) !== null) {
    var tag = match[0];
    var srcMatch = tag.match(srcRegex);
    if (!srcMatch) continue;

    var src = srcMatch[1] || srcMatch[2] || srcMatch[3] || '';
    if (!src || /^data:/i.test(src)) continue;

    out.push({
      url: toAbsoluteUrl(src, baseUrl),
      width: getAttr(tag, 'width'),
      height: getAttr(tag, 'height'),
      alt: decodeHtmlEntities(getAttr(tag, 'alt') || ''),
      title: decodeHtmlEntities(getAttr(tag, 'title') || ''),
    });
  }

  return out;
}

function getAttr(tag, attr) {
  var re = new RegExp('\\b' + attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  var m = tag.match(re);
  return m ? (m[1] || m[2] || m[3] || '') : '';
}

function toAbsoluteUrl(raw, base) {
  try {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^\/\//.test(raw)) return 'https:' + raw;

    var b = new URL(base);
    if (raw.charAt(0) === '/') {
      return b.protocol + '//' + b.host + raw;
    }

    var path = b.pathname;
    if (path.lastIndexOf('/') >= 0) {
      path = path.substring(0, path.lastIndexOf('/') + 1);
    }

    return b.protocol + '//' + b.host + path + raw;
  } catch (e) {
    return raw;
  }
}

function getFilenameFromUrl(url) {
  try {
    var noQuery = url.split('?')[0].split('#')[0];
    var parts = noQuery.split('/');
    var name = parts[parts.length - 1];
    return name || '(unnamed)';
  } catch (e) {
    return '(unnamed)';
  }
}

function getOptimizationStatus(kb, width, height) {
  if (!kb) return 'Unknown';

  var px = Number(width || 0) * Number(height || 0);
  if (!px || isNaN(px)) {
    return kb <= 250 ? 'Likely OK' : 'Potentially heavy';
  }

  if (kb <= 200 && px <= 1200000) return 'Good';
  if (kb <= 500) return 'Acceptable';
  return 'Needs optimization';
}

function extractPpi(bytes, type, url) {
  if (isPng(type, url, bytes)) return extractPpiFromPng(bytes);
  if (isJpeg(type, url, bytes)) return extractPpiFromJpeg(bytes);
  return { ppi: null, note: 'Format not parsed for PPI metadata' };
}

function extractDimensions(bytes, type, url) {
  if (isPng(type, url, bytes)) return extractDimensionsFromPng(bytes);
  if (isJpeg(type, url, bytes)) return extractDimensionsFromJpeg(bytes);
  return { width: null, height: null };
}

function isJpeg(type, url, bytes) {
  if ((type || '').indexOf('jpeg') > -1 || (url || '').toLowerCase().match(/\.jpe?g($|\?)/)) return true;
  return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isPng(type, url, bytes) {
  if ((type || '').indexOf('png') > -1 || (url || '').toLowerCase().match(/\.png($|\?)/)) return true;
  return bytes && bytes.length > 7 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
}

function extractDimensionsFromPng(bytes) {
  if (!bytes || bytes.length < 24) return { width: null, height: null };
  return {
    width: readUInt32BE(bytes, 16),
    height: readUInt32BE(bytes, 20),
  };
}

function extractPpiFromPng(bytes) {
  var i = 8;
  while (i + 12 <= bytes.length) {
    var len = readUInt32BE(bytes, i);
    var type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    var dataStart = i + 8;

    if (type === 'pHYs' && len >= 9 && dataStart + len <= bytes.length) {
      var xPpm = readUInt32BE(bytes, dataStart);
      var yPpm = readUInt32BE(bytes, dataStart + 4);
      var unit = bytes[dataStart + 8];
      if (unit === 1 && xPpm) {
        var xPpi = xPpm * 0.0254;
        var yPpi = yPpm * 0.0254;
        var ppi = Math.round(((xPpi + yPpi) / 2) * 100) / 100;
        return { ppi: ppi, note: '' };
      }
      return { ppi: null, note: 'PNG has pHYs chunk without meter units' };
    }

    i += 12 + len;
  }

  return { ppi: null, note: 'No embedded DPI/PPI metadata found' };
}

function extractDimensionsFromJpeg(bytes) {
  var i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }

    var marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }

    if (i + 3 >= bytes.length) break;
    var len = readUInt16BE(bytes, i + 2);
    if (len < 2) break;

    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (i + 8 < bytes.length) {
        return {
          height: readUInt16BE(bytes, i + 5),
          width: readUInt16BE(bytes, i + 7),
        };
      }
      break;
    }

    i += 2 + len;
  }

  return { width: null, height: null };
}

function extractPpiFromJpeg(bytes) {
  var i = 2;
  while (i + 10 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }

    var marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }

    if (i + 3 >= bytes.length) break;
    var len = readUInt16BE(bytes, i + 2);
    if (len < 2 || i + 2 + len > bytes.length) break;

    // APP0 JFIF
    if (marker === 0xe0 && len >= 16) {
      var id = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7], bytes[i + 8]);
      if (id === 'JFIF\u0000') {
        var units = bytes[i + 11]; // 0=no units, 1=dpi, 2=dpcm
        var xDensity = readUInt16BE(bytes, i + 12);
        var yDensity = readUInt16BE(bytes, i + 14);

        if (units === 1 && xDensity && yDensity) {
          return { ppi: round2((xDensity + yDensity) / 2), note: '' };
        }
        if (units === 2 && xDensity && yDensity) {
          var xPpi = xDensity * 2.54;
          var yPpi = yDensity * 2.54;
          return { ppi: round2((xPpi + yPpi) / 2), note: '' };
        }
        return { ppi: null, note: 'JFIF present but no absolute DPI units' };
      }
    }

    i += 2 + len;
  }

  return { ppi: null, note: 'No embedded DPI/PPI metadata found' };
}

function readUInt16BE(bytes, pos) {
  return ((bytes[pos] & 255) << 8) + (bytes[pos + 1] & 255);
}

function readUInt32BE(bytes, pos) {
  return ((bytes[pos] & 255) * 16777216) + ((bytes[pos + 1] & 255) << 16) + ((bytes[pos + 2] & 255) << 8) + (bytes[pos + 3] & 255);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function decodeHtmlEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
