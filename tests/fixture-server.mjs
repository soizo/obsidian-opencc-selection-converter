import { createServer } from 'node:http';

export async function startFixtureServer() {
  const requests = [];
  const routes = new Map([
    ['/config.json', ['application/json', JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: 'dict.txt' } }] })]],
    ['/dict.txt', ['text/plain; charset=utf-8', '软件\t軟體\n']],
    ['/bad-config.json', ['application/json', JSON.stringify({ conversion_chain: [{ dict: { type: 'text', file: 'missing.txt' } }] })]],
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
