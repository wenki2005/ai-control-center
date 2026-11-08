import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup, Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

function publicAddress(value) {
  if (isIP(value) === 4) { const [a,b] = value.split('.').map(Number);return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && [18,19].includes(b)) || (a === 100 && b >= 64 && b <= 127)); }
  return isIP(value) === 6 && !/^(?:::|fc|fd|fe80)/i.test(value);
}

// This lookup belongs only to the monitor's outbound requests. It never edits
// Windows DNS, hosts files, global fetch, Host headers or TLS verification.
const cache = new Map();
export async function resolveMonitorHost(hostname) {
  try {
    const addresses = await lookup(hostname, { all: true });
    cache.set(hostname, { addresses, at: Date.now() });return { addresses, source: 'system' };
  } catch (error) {
    if (!['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) throw error;
    const previous = cache.get(hostname);
    if (previous && Date.now() - previous.at < 300000) return { addresses: previous.addresses, source: 'recent-resolved-address', systemError: error.code };
    for (const address of ['223.5.5.5', '119.29.29.29']) {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });resolver.setServers([address]);
      try {
        const values = await resolver.resolve4(hostname);if (!values.length) continue;
        const addresses = values.map(value => ({ address: value, family: 4 }));
        cache.set(hostname, { addresses, at: Date.now() });return { addresses, source: 'independent-resolver', systemError: error.code };
      } catch { /* Try the next resolver, then preserve the original error. */ }
    }
    throw error;
  }
}

export function monitorFetch(input, options = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return Promise.reject(Error('监控地址无效'));
  return new Promise((resolve, reject) => {
    let dns = null;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: options.method || 'GET', headers: options.headers, signal: options.signal, agent: false,
      lookup: (hostname, opts, callback) => {
        void resolveMonitorHost(hostname).then(value => {
          if (options.monitorPublicOnly && value.addresses.some(x => !publicAddress(x.address))) { const error=Error('Non-public website address');error.code='NON_PUBLIC_ADDRESS';callback(error);return; }
          dns = { source: value.source, systemError: value.systemError || null };
          const preferred = opts.family ? value.addresses.filter(x => x.family === opts.family) : value.addresses;
          if (!preferred.length) { const error = Error('No matching address family');error.code = 'ENOTFOUND';callback(error);return; }
          if (opts.all) callback(null, preferred);else callback(null, preferred[0].address, preferred[0].family);
        }, callback);
      }
    }, response => {
      const chunks = [];let size = 0;
      response.on('data', chunk => {
        size += chunk.length;if (size > 2 * 1024 * 1024) { const error = Error('Monitor response exceeds limit');error.code = 'MONITOR_RESPONSE_LIMIT';request.destroy(error);return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const status = response.statusCode || 500;
        const result = new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers });
        Object.defineProperty(result, 'monitorDns', { value: dns });resolve(result);
      });
    });
    request.on('error', reject);if (options.body) request.write(options.body);request.end();
  });
}
