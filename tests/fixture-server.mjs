import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function startFixtureServer() {
  const requests = [];
  const fixture = name => readFile(new URL(`fixtures/opencc/${name}`, import.meta.url));
  const [govConfig, compatibilityText, tgPhrases, tgCharacters, compatibility, stPhrases, generatedPhrases, stCharacters] = await Promise.all([
    fixture('gov/t2gov.json'), fixture('gov/CJK_Compatibility_Ideographs.txt'), fixture('gov/TGPhrases.txt'), fixture('gov/TGCharacters.txt'),
    fixture('s2twp/CJK_Compatibility_Ideographs.ocd2'), fixture('s2twp/STPhrases.ocd2'), fixture('s2twp/STPhrases_GeneratedFromRegionalPhrases.ocd2'), fixture('s2twp/STCharacters.ocd2'),
  ]);
  const s2tConfig = JSON.stringify({
    normalization: [{ dict: { type: 'ocd2', file: 'CJK_Compatibility_Ideographs.ocd2' } }],
    conversion_chain: [{ dict: { type: 'group', match_policy: 'short_circuit', dicts: [
      { type: 'group', match_policy: 'union', dicts: [{ type: 'ocd2', file: 'STPhrases.ocd2' }, { type: 'ocd2', file: 'STPhrases_GeneratedFromRegionalPhrases.ocd2' }] },
      { type: 'ocd2', file: 'STCharacters.ocd2' },
    ] } }],
  });
  const routes = new Map([
    ['/config.json', ['application/json', JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: 'dict.txt' } }] })]],
    ['/dict.txt', ['text/plain; charset=utf-8', '软件\t軟體\n']],
    ['/bad-config.json', ['application/json', JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: 'missing.txt' } }] })]],
    ['/gov/t2gov.json', ['application/json', govConfig]],
    ['/gov/CJK_Compatibility_Ideographs.txt', ['text/plain; charset=utf-8', compatibilityText]],
    ['/gov/TGPhrases.txt', ['text/plain; charset=utf-8', tgPhrases]],
    ['/gov/TGCharacters.txt', ['text/plain; charset=utf-8', tgCharacters]],
    ['/official/s2t.json', ['application/json', s2tConfig]],
    ['/official/assets/CJK_Compatibility_Ideographs.ocd2', ['application/octet-stream', compatibility]],
    ['/official/assets/STPhrases.ocd2', ['application/octet-stream', stPhrases]],
    ['/official/assets/STPhrases_GeneratedFromRegionalPhrases.ocd2', ['application/octet-stream', generatedPhrases]],
    ['/official/assets/STCharacters.ocd2', ['application/octet-stream', stCharacters]],
  ]);
  const server = createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (request.url === '/requests') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(requests));
      return;
    }
    requests.push({ method: request.method, path: request.url });
    const route = routes.get(request.url);
    if (!route) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': route[0] }).end(route[1]);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind loopback');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
