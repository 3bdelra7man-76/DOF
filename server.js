import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load .env.local before importing the handler
function loadEnv() {
  const envPath = resolve(__dirname, '.env.local');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const PROFILE_ROUTE_RESERVED = new Set([
  'api',
  'assets',
  'adm',
  'admin',
  'dashboard',
  'index',
  'homepage',
  'explore',
  'publicprofile',
  'photographerdashboard',
  'client',
  'clientdashboard',
  'reset',
  'favicon',
  'robots',
  'sitemap'
]);
const CLEAN_ROUTES = new Map([
  ['/explore', 'explore.html'],
  ['/dashboard', 'photographerdashboard.html'],
  ['/client', 'clientdashboard.html'],
  ['/adm', 'admin.html'],
  ['/reset', 'reset.html']
]);
const LEGACY_REDIRECTS = new Map([
  ['/index.html', '/'],
  ['/homepage.html', '/'],
  ['/explore.html', '/explore'],
  ['/photographerdashboard.html', '/dashboard'],
  ['/admin.html', '/adm'],
  ['/reset.html', '/reset']
]);

// pathToFileURL handles the [ ] in the filename safely
const { default: apiHandler } = await import(
  pathToFileURL(resolve(__dirname, 'api/[...path].js')).href
);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    try {
      // Replicate Vercel's req.query.path shape
      const pathParts = pathname.slice('/api/'.length).split('/').filter(Boolean);
      req.query = { path: pathParts };
      // Also forward any other query params (e.g. ?date=&packageId=)
      for (const [key, value] of url.searchParams) {
        if (key !== 'path') req.query[key] = value;
      }
      return await apiHandler(req, res);
    } catch (error) {
      console.error('API handler error:', error);
      // تأكد أن الاستجابة هي JSON صحيح
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ 
          error: { 
            message: 'Internal server error',
            details: error.message
          } 
        }));
      }
    }
  }

  if (LEGACY_REDIRECTS.has(pathname)) {
    res.writeHead(308, { Location: LEGACY_REDIRECTS.get(pathname) + url.search });
    return res.end();
  }

  // Static file serving
  let filePath = pathname === '/'
    ? resolve(__dirname, 'index.html')
    : CLEAN_ROUTES.has(pathname)
      ? resolve(__dirname, CLEAN_ROUTES.get(pathname))
      : resolve(__dirname, pathname.slice(1));

  if (!extname(filePath)) {
    if (existsSync(filePath + '.html')) filePath += '.html';
    else {
      const cleanSlug = pathname.replace(/^\/+|\/+$/g, '');
      const isProfileSlug = cleanSlug
        && !cleanSlug.includes('/')
        && !cleanSlug.includes('.')
        && !PROFILE_ROUTE_RESERVED.has(cleanSlug.toLowerCase());
      filePath = resolve(__dirname, isProfileSlug ? 'publicprofile.html' : 'index.html');
    }
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!DOCTYPE html><html><head><title>404 - Page Not Found</title></head><body><h1>404 - Page Not Found</h1><p>The requested page could not be found.</p></body></html>');
  }

  try {
    if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch (error) {
    console.error('Server file error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Server error' } }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nDOF Studios → http://localhost:${PORT}`);
  console.log(`API health → http://localhost:${PORT}/api/health\n`);
});
