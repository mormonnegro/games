#!/usr/bin/env node
// Tiny zero-dep server. Serves index.html on http://localhost:PORT and
// exposes /api/usage with cumulative Claude Code token counts for this cwd,
// read from ~/.claude/projects/<encoded-cwd>/*.jsonl. The HTML polls this
// endpoint and uses token deltas to grow vegetation.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = process.cwd();

// Claude Code encodes the project cwd by replacing every "/" with "-".
function transcriptsDir() {
  const encoded = ROOT.replaceAll('/', '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

// Scan all *.jsonl in the project's transcript dir, sum token usage from
// `type:"assistant"` lines, dedup by message.id so resumed sessions don't
// double-count. Cheap enough to run on every request, but we cache for 1.5s.
let cache = { ts: 0, data: null };
function readUsage() {
  const now = Date.now();
  if (cache.data && now - cache.ts < 1500) return cache.data;

  const dir = transcriptsDir();
  const totals = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    messages: 0,
    models: {},
  };
  const seen = new Set();

  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
  catch { /* dir may not exist yet */ }

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant') continue;
      const msg = o.message;
      if (!msg || !msg.usage) continue;
      const id = msg.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const u = msg.usage;
      totals.input       += u.input_tokens || 0;
      totals.output      += u.output_tokens || 0;
      totals.cacheCreate += u.cache_creation_input_tokens || 0;
      totals.cacheRead   += u.cache_read_input_tokens || 0;
      totals.messages    += 1;
      if (msg.model) totals.models[msg.model] = (totals.models[msg.model] || 0) + 1;
    }
  }

  totals.total = totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
  totals.cwd = ROOT;
  totals.transcriptsDir = dir;
  totals.transcriptsFound = files.length;

  cache = { ts: now, data: totals };
  return totals;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/usage') {
    const data = readUsage();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
    return;
  }

  // Default route serves index.html
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  // Prevent path traversal
  const safe = path.normalize(path.join(ROOT, rel));
  if (!safe.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  serveFile(res, safe);
});

server.listen(PORT, () => {
  const d = transcriptsDir();
  const exists = fs.existsSync(d);
  console.log(`city-game running at http://localhost:${PORT}`);
  console.log(`transcripts: ${d}${exists ? '' : '  (not found yet — will appear after first Claude Code message)'}`);
});
