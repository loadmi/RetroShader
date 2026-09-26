// Minimal static file server for the test harness. Serves the repo root so the harness can load ../extension/*.
// Usage: node test/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2]) || 8787;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.glsl': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
};

const captures = path.join(__dirname, 'captures');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // POST /__save?name=foo.png  -> writes the request body to test/captures/foo.png (harness screenshots).
  if (req.method === 'POST' && url.pathname === '/__save') {
    const name = path.basename(url.searchParams.get('name') || 'capture.png');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(captures, { recursive: true });
      fs.writeFileSync(path.join(captures, name), Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(path.join(captures, name));
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/test/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, () => console.log(`test harness: http://localhost:${port}/`));
