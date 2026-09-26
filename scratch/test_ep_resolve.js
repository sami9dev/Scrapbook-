import { resolveMediatorFlow } from '../src/resolvers/mediator/browser.js';
import { fetchHubCloudMetadata } from '../src/providers/hubcloud/validator.js';

async function main() {
  const mediatorUrl = 'https://greenmotors.club/?id=Q1dxTzFnbjhrQm5kMG5lL01tQzcvdEhwZ0JtZVdjNUEvbXdPRHcyWGVHVUhQT0VCWld5OUJmTTJYVG1jeER3OWhvQWtXYnZPV2tTdlFLYkxCMThzRnc9PQ==';
  console.log('Resolving Episode 1 mediator...');
  const res = await resolveMediatorFlow(mediatorUrl, {
    countdownTimeout: 35000,
    navigationTimeout: 20000,
    headless: true,
  });
  console.log('Resolution:', res.success, res.destination);
  if (res.destination) {
    const meta = await fetchHubCloudMetadata(res.destination);
    console.log('HubCloud meta:', meta);
  }
}

main().catch(console.error);
