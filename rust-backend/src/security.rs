use std::net::IpAddr;
use url::Url;

/// Validates that a URL is safe to fetch (protects against SSRF).
/// Blocks private IPv4/IPv6, localhost, cloud metadata endpoints, and non-http schemes.
pub fn validate_url(raw_url: &str) -> Result<Url, String> {
    if raw_url.trim().is_empty() {
        return Err("URL cannot be empty.".to_string());
    }

    let parsed = Url::parse(raw_url).map_err(|e| format!("Invalid URL format: {}", e))?;

    // Only allow http and https schemes
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Blocked forbidden scheme: '{}'. Only http/https allowed.", other)),
    }

    let host_str = match parsed.host_str() {
        Some(h) => h.to_lowercase(),
        None => return Err("URL has no host.".to_string()),
    };

    // Block localhost names
    if host_str == "localhost"
        || host_str.ends_with(".localhost")
        || host_str.ends_with(".local")
        || host_str.ends_with(".internal")
    {
        return Err(format!("SSRF blocked: Host '{}' resolves to localhost/internal.", host_str));
    }

    // Check if host is direct IP address
    if let Ok(ip) = host_str.parse::<IpAddr>() {
        if is_private_ip(&ip) {
            return Err(format!("SSRF blocked: IP address '{}' is in private/reserved range.", ip));
        }
    }

    Ok(parsed)
}

/// Checks whether an IP address belongs to loopback, private, link-local, or cloud metadata ranges.
pub fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback()                           // 127.0.0.0/8
                || ipv4.is_private()                     // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
                || ipv4.is_link_local()                  // 169.254.0.0/16
                || ipv4.is_broadcast()                   // 255.255.255.255
                || ipv4.octets()[0] == 0                 // 0.0.0.0/8
                || (ipv4.octets()[0] == 100 && (ipv4.octets()[1] & 0xC0) == 64) // 100.64.0.0/10 Carrier-grade NAT
                || ipv4.octets() == [169, 254, 169, 254] // AWS/GCP/Azure metadata
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() // ::1
                || ipv6.is_unspecified() // ::
                // Unique Local Addresses (fc00::/7)
                || (ipv6.segments()[0] & 0xfe00) == 0xfc00
                // Link-local Unicast (fe80::/10)
                || (ipv6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}
