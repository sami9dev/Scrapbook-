import type { ProviderAdapter, ProviderMetadata, ProviderLink, ResolveResult, ResolverContext } from '../../types.js';
import { fetchPage } from '../../http-client.js';
import { resolverLogger as log } from '../../logging/logger.js';
import { cache } from '../../cache/cache.service.js';
import { parseXDMoviesMetadata, parseXDMoviesLinks } from './parser.js';
import { resolveXDMoviesLink } from './resolver.js';

const XDMOVIES_HOSTS = new Set(['top.xdmovies.wtf', 'link.xdmovies.wtf', 'xdmovies.wtf']);
const MEDIATOR_HOSTS = new Set(['latestnewsonline.sbs']);

export class XDMoviesAdapter implements ProviderAdapter {
  readonly name = 'xdmovies' as const;

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return XDMOVIES_HOSTS.has(host) || MEDIATOR_HOSTS.has(host) || host.endsWith('.xdmovies.wtf');
  }

  async extractMetadata(url: URL, context: ResolverContext): Promise<ProviderMetadata> {
    const key = `xdm:meta:${url}`;
    const cached = cache.get<ProviderMetadata>('metadata', key);
    if (cached) return cached;
    const r = await fetchPage(url.toString(), { timeoutMs: context.options.timeouts?.http ?? 10_000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching XDMovies page`);
    const meta = parseXDMoviesMetadata(r.body, url.toString());
    cache.set('metadata', key, meta);
    return meta;
  }

  async extractLinks(url: URL, context: ResolverContext): Promise<ProviderLink[]> {
    const key = `xdm:links:${url}`;
    const cached = cache.get<ProviderLink[]>('linkMeta', key);
    if (cached) return cached;
    const r = await fetchPage(url.toString(), { timeoutMs: context.options.timeouts?.http ?? 10_000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching XDMovies links`);
    const links = await parseXDMoviesLinks(r.body, url.toString(), {
      targetQuality: context.options.targetQuality,
      targetScope: context.options.targetScope,
    });
    cache.set('linkMeta', key, links);
    return links;
  }

  async resolve(link: ProviderLink, context: ResolverContext): Promise<ResolveResult> {
    return resolveXDMoviesLink(link, context);
  }
}
