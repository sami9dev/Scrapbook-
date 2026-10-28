use scraper::{Html, Selector};
use url::Url;

#[derive(Debug, Clone)]
pub struct ExtractedLink {
    pub title: String,
    pub quality: Option<String>,
    pub scope: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub codec: Option<String>,
    pub size_display: Option<String>,
    pub mediator_url: String,
    pub provider: String,
}

#[derive(Debug, Clone)]
pub struct ParseResult {
    pub title: String,
    pub links: Vec<ExtractedLink>,
}

/// Normalizes quality strings (e.g. '2160p' -> '2160', '1080p' -> '1080')
pub fn matches_quality(actual: Option<&str>, target: &str) -> bool {
    if target == "all" || target.is_empty() {
        return true;
    }
    match actual {
        Some(q) => {
            let norm_actual = q.trim().to_lowercase().replace("p", "");
            let norm_target = target.trim().to_lowercase().replace("p", "");
            norm_actual == norm_target
        }
        None => false,
    }
}

/// Checks if a URL points to a HubCloud drive domain
pub fn is_hubcloud_url(url_str: &str) -> bool {
    if let Ok(u) = Url::parse(url_str) {
        if let Some(host) = u.host_str() {
            let h = host.to_lowercase();
            return (h.contains("hubcloud") || h.contains("greenmotors")) && u.path().contains("/drive/");
        }
    }
    false
}

/// Extracts HubCloud drive ID from a URL
pub fn extract_hubcloud_drive_id(url_str: &str) -> Option<String> {
    if let Ok(u) = Url::parse(url_str) {
        let path = u.path();
        if let Some(idx) = path.find("/drive/") {
            let sub = &path[idx + 7..];
            let id = sub.split('/').next().unwrap_or("").trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// Parses 4KHDHub or generic HTML to extract download buttons
pub fn parse_4khdhub_html(html_content: &str, base_url: &str) -> ParseResult {
    let document = Html::parse_document(html_content);
    let mut links = Vec::new();

    // Title extraction
    let title_selector = Selector::parse("h1.entry-title, h1, title").unwrap();
    let title = document
        .select(&title_selector)
        .next()
        .map(|el| el.text().collect::<Vec<_>>().join(" ").trim().to_string())
        .unwrap_or_else(|| "4KHDHub Content".to_string());

    // Link selectors for download buttons
    let a_selector = Selector::parse("a[href]").unwrap();
    for element in document.select(&a_selector) {
        if let Some(href) = element.value().attr("href") {
            let text = element.text().collect::<Vec<_>>().join(" ");
            let class = element.value().attr("class").unwrap_or("");

            let is_hubcloud_button = href.contains("hubcloud")
                || href.contains("greenmotors")
                || class.contains("hubcloud")
                || text.to_lowercase().contains("hubcloud")
                || text.to_lowercase().contains("download");

            if is_hubcloud_button && (href.starts_with("http://") || href.starts_with("https://")) {
                let quality = detect_quality(&text);
                let (season, episode, scope) = detect_season_episode(&text);

                links.push(ExtractedLink {
                    title: title.clone(),
                    quality,
                    scope: Some(scope),
                    season,
                    episode,
                    codec: detect_codec(&text),
                    size_display: None,
                    mediator_url: href.to_string(),
                    provider: "HUBCLOUD".to_string(),
                });
            }
        }
    }

    ParseResult { title, links }
}


fn detect_quality(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if lower.contains("2160p") || lower.contains("4k") {
        Some("2160p".to_string())
    } else if lower.contains("1080p") {
        Some("1080p".to_string())
    } else if lower.contains("720p") {
        Some("720p".to_string())
    } else if lower.contains("480p") {
        Some("480p".to_string())
    } else {
        None
    }
}

fn detect_codec(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if lower.contains("x265") || lower.contains("hevc") || lower.contains("10bit") {
        Some("x265 10Bit".to_string())
    } else if lower.contains("x264") || lower.contains("avc") {
        Some("x264".to_string())
    } else {
        None
    }
}

fn detect_season_episode(text: &str) -> (Option<u32>, Option<u32>, String) {
    let lower = text.to_lowercase();
    let mut season = None;
    let mut episode = None;
    let mut scope = "movie".to_string();

    if let Some(s_idx) = lower.find('s') {
        let rem = &lower[s_idx + 1..];
        if let Some(end) = rem.find(|c: char| !c.is_ascii_digit()) {
            if let Ok(num) = rem[..end].parse::<u32>() {
                season = Some(num);
                scope = "pack".to_string();
            }
        }
    }

    if let Some(e_idx) = lower.find('e') {
        let rem = &lower[e_idx + 1..];
        if let Some(end) = rem.find(|c: char| !c.is_ascii_digit()) {
            if let Ok(num) = rem[..end].parse::<u32>() {
                episode = Some(num);
                scope = "episode".to_string();
            }
        }
    }

    (season, episode, scope)
}
