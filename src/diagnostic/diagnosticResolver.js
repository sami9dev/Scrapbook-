#!/usr/bin/env node

import { extract4KHDHubLinks } from '../providers/4khdhub/extractor.js';
import { resolveMediatorFlow } from '../resolvers/mediator/browser.js';
import { isHubCloudDriveUrl, extractHubCloudDriveId } from '../providers/hubcloud/validator.js';
import { fetchWithControls } from '../discovery/http-client.js';

async function getPageHtml(url) {
  try {
    const res = await fetchWithControls(url);
    if (res && res.body) return res.body;
  } catch {}
  const res = await fetch(url);
  return await res.text();
}

/**
 * Diagnostic runner adhering strictly to Section 25:
 * 
 * SOURCE URL
 * ↓
 * EXTRACTED HUBCLOUD BUTTON
 * ↓
 * MEDIATOR URL
 * ↓
 * MEDIATOR STATES
 * ↓
 * GET LINK DETECTED
 * ↓
 * FINAL NAVIGATION URL
 * ↓
 * VALIDATED HUBCLOUD URL
 */
export async function runDiagnostic(inputUrlOrHtml, options = {}) {
  console.log('\n========================================================================');
  console.log('4KHDHub → Mediator → HubCloud Diagnostic Resolver (Section 25)');
  console.log('========================================================================');

  let sourceUrl = '';
  let html = '';
  let isDirectMediator = false;

  if (inputUrlOrHtml.startsWith('http://') || inputUrlOrHtml.startsWith('https://')) {
    sourceUrl = inputUrlOrHtml;
    // Check if user passed a mediator URL directly
    if (sourceUrl.includes('drive/') && isHubCloudDriveUrl(sourceUrl)) {
      console.log(`[INPUT] Already a validated HubCloud drive URL: ${sourceUrl}`);
      return { success: true, destination: sourceUrl };
    }

    if (
      (!sourceUrl.includes('4k') && !sourceUrl.includes('hub4u') && (sourceUrl.includes('?') || sourceUrl.includes('/r/') || sourceUrl.includes('greenmotors') || sourceUrl.includes('homelander') || sourceUrl.includes('mediator'))) ||
      options.isMediator
    ) {
      isDirectMediator = true;
    } else {
      console.log(`SOURCE URL: ${sourceUrl}`);
      try {
        html = await getPageHtml(sourceUrl);
      } catch (err) {
        console.error(`[ERROR] Failed to fetch source page: ${err.message}`);
        return { success: false, error: err.message };
      }
    }
  } else {
    // Raw HTML provided
    html = inputUrlOrHtml;
    sourceUrl = options.sourceUrl || 'https://4khdhub.example/content/';
    console.log(`SOURCE URL: ${sourceUrl} (Provided via raw HTML)`);
  }

  let mediatorCandidate = null;

  if (isDirectMediator) {
    mediatorCandidate = {
      title: options.title || 'Direct Mediator Test',
      quality: options.quality || '1080p',
      provider: 'HubCloud',
      mediatorUrl: sourceUrl,
      sourceUrl,
    };
    console.log(`↓\nDIRECT MEDIATOR URL PROVIDED: ${mediatorCandidate.mediatorUrl}`);
  } else {
    console.log('↓\nEXTRACTED HUBCLOUD BUTTON(S):');
    const extracted = extract4KHDHubLinks(html, sourceUrl);
    console.log(`  Page Title: "${extracted.title}"`);
    console.log(`  Total Buttons Discovered: ${extracted.links.length}`);

    if (extracted.links.length === 0) {
      console.error('  [ERROR] No HubCloud download buttons found on page.');
      return { success: false, error: 'HUBCLOUD_BUTTON_NOT_FOUND' };
    }

    extracted.links.forEach((l, idx) => {
      console.log(`  [${idx + 1}] Quality: ${l.quality} | Season: ${l.season ?? '-'} | Episode: ${l.episode ?? '-'} | URL: ${l.mediatorUrl}`);
    });

    // Select candidate matching quality or first available
    const targetQ = options.quality ? options.quality.toLowerCase().replace(/p$/, '') : null;
    mediatorCandidate = targetQ
      ? extracted.links.find((l) => l.quality && l.quality.toLowerCase().replace(/p$/, '') === targetQ) || extracted.links[0]
      : extracted.links[0];

    console.log('↓');
    console.log(`SELECTED MEDIATOR URL: ${mediatorCandidate.mediatorUrl} (${mediatorCandidate.quality})`);
  }

  console.log('↓\nMEDIATOR STATES (Browser Automation State Machine):');

  const resolution = await resolveMediatorFlow(mediatorCandidate.mediatorUrl, {
    meta: mediatorCandidate,
    headless: options.headless !== undefined ? options.headless : true,
    openTimeout: options.openTimeout || 25000,
    countdownTimeout: options.countdownTimeout || 35000,
    navigationTimeout: options.navigationTimeout || 20000,
  });

  for (const step of resolution.history) {
    const info = step.details.info ? ` - ${step.details.info}` : '';
    const err = step.details.error ? ` [ERROR: ${step.details.error}]` : '';
    console.log(`  • [${step.timestamp}] ${step.to} (${step.elapsedMs}ms)${info}${err}`);
  }

  console.log('↓');
  const getLinkStep = resolution.history.find((h) => h.to === 'LINK_READY' || h.to === 'GET_LINK_ACTION');
  if (getLinkStep) {
    console.log(`GET LINK DETECTED: [${getLinkStep.details.type || 'Button'}] "${getLinkStep.details.text || 'Get Link'}"`);
    if (getLinkStep.details.href) {
      console.log(`  Href: ${getLinkStep.details.href}`);
    }
  } else {
    console.log('GET LINK DETECTED: None (Timed out, challenged, or not reached)');
  }

  console.log('↓');
  console.log(`FINAL NAVIGATION URL: ${resolution.destination || 'None'}`);

  console.log('↓');
  if (resolution.success && isHubCloudDriveUrl(resolution.destination)) {
    const driveId = extractHubCloudDriveId(resolution.destination);
    console.log(`VALIDATED HUBCLOUD URL: ${resolution.destination}`);
    console.log(`  Dynamic Drive ID: ${driveId}`);
    console.log('========================================================================\n');
    return {
      success: true,
      destination: resolution.destination,
      driveId,
      resolution,
    };
  } else {
    console.error(`[FAILURE] Outcome: ${resolution.state} | Error: ${resolution.error || 'Destination not verified'}`);
    console.log('========================================================================\n');
    return {
      success: false,
      state: resolution.state,
      error: resolution.error,
      resolution,
    };
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('diagnosticResolver.js')) {
  const target = process.argv[2];
  if (!target) {
    console.log('Usage: node src/diagnostic/diagnosticResolver.js <sourceUrl_or_mediatorUrl> [--quality=1080p]');
    process.exit(1);
  }

  const qualityArg = process.argv.find((a) => a.startsWith('--quality='));
  const quality = qualityArg ? qualityArg.split('=')[1] : null;

  runDiagnostic(target, { quality }).catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}

export default runDiagnostic;
