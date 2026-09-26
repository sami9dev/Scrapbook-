import net from 'node:net';

/**
 * Checks if an IPv4 address is in a private, loopback, or reserved range.
 */
export function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [p0, p1, p2] = parts;

  // 0.0.0.0/8 (Current network)
  if (p0 === 0) return true;

  // 10.0.0.0/8 (Private)
  if (p0 === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (p0 === 127) return true;

  // 169.254.0.0/16 (Link-local / APIPA)
  if (p0 === 169 && p1 === 254) return true;

  // 172.16.0.0/12 (Private: 172.16.0.0 – 172.31.255.255)
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (p0 === 192 && p1 === 168) return true;

  // 100.64.0.0/10 (Shared address space / Carrier-grade NAT)
  if (p0 === 100 && p1 >= 64 && p1 <= 127) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (p0 === 192 && p1 === 0 && p2 === 0) return true;

  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET-1, 2, 3)
  if (p0 === 192 && p1 === 0 && p2 === 2) return true;
  if (p0 === 198 && p1 === 51 && p2 === 100) return true;
  if (p0 === 203 && p1 === 0 && p2 === 113) return true;

  // 224.0.0.0/4 (Multicast)
  if (p0 >= 224 && p0 <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use)
  if (p0 >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, or reserved range.
 */
export function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();

  // ::1 (Loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // :: (Unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // fc00::/7 (Unique Local Address, ULA)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // fe80::/10 (Link-local)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or normalized hex ::ffff:hhhh:hhhh)
  if (normalized.includes('::ffff:')) {
    const part = normalized.split('::ffff:')[1];
    if (part) {
      if (net.isIPv4(part)) {
        return isPrivateIPv4(part);
      }
      const hexParts = part.split(':');
      if (hexParts.length === 2) {
        const h0 = parseInt(hexParts[0], 16);
        const h1 = parseInt(hexParts[1], 16);
        if (!isNaN(h0) && !isNaN(h1)) {
          const ipv4Str = `${(h0 >> 8) & 0xff}.${h0 & 0xff}.${(h1 >> 8) & 0xff}.${h1 & 0xff}`;
          return isPrivateIPv4(ipv4Str);
        }
      }
    }
  }

  return false;
}

/**
 * Checks if a hostname or IP string represents an internal/private address.
 */
export function isInternalAddress(hostname) {
  const cleanHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (cleanHost === 'localhost') return true;
  if (cleanHost.endsWith('.local') || cleanHost.endsWith('.internal') || cleanHost.endsWith('.localhost')) return true;

  if (net.isIPv4(cleanHost)) {
    return isPrivateIPv4(cleanHost);
  }

  if (net.isIPv6(cleanHost)) {
    return isPrivateIPv6(cleanHost);
  }

  return false;
}

/**
 * Validates a target URL against protocol restrictions, SSRF checks, and domain allowlists.
 * @param {string} inputUrl
 * @param {object} options
 * @param {string[]} [options.allowedDomains]
 * @param {boolean} [options.allowInternal] - For tests only
 * @returns {{ valid: boolean, url?: URL, normalizedUrl?: string, error?: string }}
 */
export function validateUrl(inputUrl, options = {}) {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { valid: false, error: 'URL must be a non-empty string' };
  }

  let parsed;
  try {
    parsed = new URL(inputUrl.trim());
  } catch {
    return { valid: false, error: `Invalid URL format: ${inputUrl}` };
  }

  // Only allow http: and https: protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: `Disallowed protocol: '${parsed.protocol}'. Only http: and https: are allowed.`,
    };
  }

  // Strip credentials embedded in URL
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'URLs containing embedded credentials (user:password) are rejected.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // SSRF Protection: block private/loopback addresses unless explicitly allowed (for testing)
  if (!options.allowInternal && isInternalAddress(hostname)) {
    return {
      valid: false,
      error: `SSRF blocked: Hostname or IP '${hostname}' resolves to an internal/private address.`,
    };
  }

  // Optional domain allowlist enforcement
  const allowed = options.allowedDomains || [];
  if (allowed.length > 0) {
    const isAllowed = allowed.some((domain) => {
      const d = domain.toLowerCase();
      return hostname === d || hostname.endsWith(`.${d}`);
    });

    if (!isAllowed) {
      return {
        valid: false,
        error: `Domain '${hostname}' is not in the authorized domain allowlist.`,
      };
    }
  }

  return {
    valid: true,
    url: parsed,
    normalizedUrl: parsed.toString(),
  };
}

/**
 * Resolves a relative or absolute URL against a base URL.
 * Handles edge cases such as protocol-relative URLs (//example.com), root paths (/path), and relative paths (../path).
 * @param {string} baseUrl
 * @param {string} relativeUrl
 * @returns {string|null}
 */
export function resolveRelativeUrl(baseUrl, relativeUrl) {
  if (!relativeUrl || typeof relativeUrl !== 'string') return null;
  const trimmed = relativeUrl.trim();
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('mailto:') || trimmed.startsWith('#')) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    return resolved.toString();
  } catch {
    return null;
  }
}
