/**
 * Parses a human-readable file size string and converts it into integer bytes.
 * Handles GB, MB, KB, TB, Bytes (case-insensitive, optional decimal point).
 * 
 * @param {string} sizeStr - E.g. "39.47 GB", "1024 MB", "500 KB"
 * @returns {number|null} Bytes as integer, or null if cannot be parsed
 */
export function parseSizeToBytes(sizeStr) {
  if (!sizeStr || typeof sizeStr !== 'string') return null;

  const match = sizeStr.trim().match(/^([\d,]+(?:\.\d+)?)\s*(bytes|b|kb|mb|gb|tb)$/i);
  if (!match) return null;

  const num = parseFloat(match[1].replace(/,/g, ''));
  const unit = match[2].toLowerCase();

  if (isNaN(num)) return null;

  const multipliers = {
    bytes: 1,
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };

  const multiplier = multipliers[unit] || 1;
  return Math.round(num * multiplier);
}

/**
 * Normalizes size into both bytes and formatted display string.
 * 
 * @param {string|number} input
 * @returns {{ sizeBytes: number|null, sizeDisplay: string|null }}
 */
export function normalizeSize(input) {
  if (typeof input === 'number') {
    let display = null;
    if (input >= 1024 * 1024 * 1024 * 1024) {
      display = `${(input / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
    } else if (input >= 1024 * 1024 * 1024) {
      display = `${(input / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (input >= 1024 * 1024) {
      display = `${(input / (1024 * 1024)).toFixed(2)} MB`;
    } else if (input >= 1024) {
      display = `${(input / 1024).toFixed(2)} KB`;
    } else {
      display = `${input} Bytes`;
    }
    return {
      sizeBytes: input,
      sizeDisplay: display,
    };
  }

  if (typeof input === 'string') {
    const bytes = parseSizeToBytes(input);
    return {
      sizeBytes: bytes,
      sizeDisplay: input.trim(),
    };
  }

  return {
    sizeBytes: null,
    sizeDisplay: null,
  };
}

/**
 * Robust quality matching that handles resolutions, prefixes, and common abbreviations.
 * e.g. 2160p <-> 4K/UHD, 1080p <-> FHD, 720p <-> HD, 480p <-> SD.
 * 
 * @param {string} linkQuality
 * @param {string} targetQuality
 * @returns {boolean}
 */
export function matchesQuality(linkQuality, targetQuality) {
  if (!targetQuality || targetQuality === 'all') return true;
  if (!linkQuality) return false;
  const l = String(linkQuality).toLowerCase().trim();
  const t = String(targetQuality).toLowerCase().trim();
  if (l === t) return true;
  const normL = l.replace(/p$/, '');
  const normT = t.replace(/p$/, '');
  if (normL === normT) return true;

  // 2160p / 4K / UHD
  if (/2160|4k|uhd/i.test(t) && /2160|4k|uhd/i.test(l)) return true;
  // 1080p / FHD
  if (/1080|fhd/i.test(t) && /1080|fhd/i.test(l)) return true;
  // 720p / HD
  if (/720|hd/i.test(t) && /720|hd/i.test(l) && !/1080|fhd/i.test(l)) return true;
  // 480p / SD
  if (/480|sd/i.test(t) && /480|sd/i.test(l)) return true;

  return l.includes(normT);
}

