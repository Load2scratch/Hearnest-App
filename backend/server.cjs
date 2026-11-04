'use strict';
// Local authentication foundation. Node 24+; no third-party dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { JsonStore } = require('./json-store.cjs');
const { RedisStore } = require('./redis-store.cjs');
const {stageAccess,stageForPage} = require('./stage-access.cjs');
const {catalogFor,summarize} = require('./progress.cjs');
const scrypt = promisify(crypto.scrypt);
const DAY = 86400000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const result = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${result.toString('hex')}`;
}
async function passwordMatches(password, stored) {
  const [algorithm, salt, digest] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !digest) return false;
  return equal(await passwordHash(password, salt), stored);
}
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, profile: JSON.parse(row.profile_json), createdAt: row.created_at };
}

async function createApp(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const serverless = options.serverless ?? process.env.VERCEL === '1';
  const store = options.store || (serverless ? new RedisStore() : new JsonStore(options.dataPath || path.join(__dirname, 'data', 'hearnest.json')));
  const accessFor = row => stageAccess(row ? JSON.parse(row.profile_json) : null, number => fs.existsSync(path.join(root, 'stage-' + number + '.html')));
  const catalog=catalogFor(root);
  const progressFor=async userId=>summarize(await store.progressRows(userId),catalog);
  const dummyPassword = await passwordHash(token());
  const secret = options.secret || process.env.AUTH_SECRET;
  if (serverless && (!secret || secret.trim().length < 32)) throw Object.assign(Error('AUTH_SECRET is missing or too short. Add a random secret of at least 32 characters in Vercel Settings > Environment Variables, then redeploy.'),{code:'INVALID_AUTH_SECRET',missing:['AUTH_SECRET']});
  const csrfKey = secret ? Buffer.from(secret) : crypto.randomBytes(32);
  const rateLimits = new Map();
  const production = options.production ?? (serverless || process.env.NODE_ENV === 'production');
  const vercelHost = process.env.VERCEL_ENV === 'production' ? (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL) : process.env.VERCEL_URL;
  const originInput = options.origin || process.env.APP_ORIGIN || (serverless && vercelHost ? 'https://' + vercelHost : undefined);
  let configuredOrigin;
  if(originInput) {
    try { const parsed=new URL(originInput); if(parsed.username || parsed.password || (production && parsed.protocol!=='https:')) throw Error(); configuredOrigin=parsed.origin; }
    catch { throw Object.assign(Error('APP_ORIGIN must be your HTTPS website origin, for example https://hearnest-learn.vercel.app. Update it in Vercel and redeploy.'),{code:'INVALID_APP_ORIGIN',missing:['APP_ORIGIN']}); }
  }
  if(production && !configuredOrigin) throw Object.assign(Error('APP_ORIGIN is missing. Set it to your HTTPS website origin in Vercel and redeploy.'),{code:'INVALID_APP_ORIGIN',missing:['APP_ORIGIN']});
  const deploymentOrigins = new Set(configuredOrigin ? [configuredOrigin] : []);
  // Vercel also serves this deployment at its own exact deployment/branch URLs.
  // Trust server-provided hostnames only; never accept arbitrary vercel.app hosts.
  if (serverless) for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (host && /^[a-z0-9-]+\.vercel\.app$/i.test(host)) deploymentOrigins.add(`https://${host.toLowerCase()}`);
  }
  const sessionName = production ? '__Host-hearnest_session' : 'hearnest_session';
  const csrfName = production ? '__Host-hearnest_csrf' : 'hearnest_csrf';
  const signCsrf = value => crypto.createHmac('sha256', csrfKey).update(value).digest('base64url');

  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s)).filter(parts => parts[0] && parts[1] !== undefined).map(parts => [parts[0], parts[1]]));
  }
  function setCookie(res, name, value, maxAge) {
    const item = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${production ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
    res.setHeader('Set-Cookie', [...(res.getHeader('Set-Cookie') || []), item]);
  }
  async function getSession(req) {
    const value = cookies(req)[sessionName];
    if (!value || value.length > 100) return null;
    return store.session(hash(value), Date.now());
  }
  function csrfToken(req, res) {
    const candidate = cookies(req)[csrfName];
    if (candidate) {
      const [value, signature] = candidate.split('.');
      if (value && value.length === 43 && equal(signature, signCsrf(value))) return candidate;
    }
    const value = token();
    const signed = `${value}.${signCsrf(value)}`;
    setCookie(res, csrfName, signed);
    return signed;
  }
  function requireCsrf(req) {
    const cookie = cookies(req)[csrfName];
    const header = req.headers['x-csrf-token'];
    if (!cookie || !equal(header, cookie)) throw new ApiError(403, 'Refresh the page and try again.');
    const [value, signature] = cookie.split('.');
    if (!value || !equal(signature, signCsrf(value))) throw new ApiError(403, 'Refresh the page and try again.');
  }
  async function issueSession(req, res, userId, remember) {
    const old = cookies(req)[sessionName];
    const value = token();
    const lifetime = remember ? 7 * DAY : DAY;
    await store.replaceSession(old ? hash(old) : null, { token_hash: hash(value), user_id: userId, expires_at: Date.now() + lifetime }, Date.now());
    setCookie(res, sessionName, value, remember ? lifetime / 1000 : undefined);
  }
  async function rateLimit(req, bucket, limit = options.rateLimit || 20) {
    const address = serverless ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress) : req.socket.remoteAddress;
    const key = `${address}:${bucket}`;
    if (store.checkRateLimit) {
      if (!await store.checkRateLimit(key, limit)) throw new ApiError(429, 'Too many attempts. Try again in 15 minutes.');
      return;
    }
    const now = Date.now();
    if (rateLimits.size > 1000) for (const [key, entry] of rateLimits) if (entry.until < now) rateLimits.delete(key);
    let entry = rateLimits.get(key);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + 15 * 60000 }; rateLimits.set(key, entry); }
    if (++entry.count > limit) throw new ApiError(429, 'Too many attempts. Try again in 15 minutes.');
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'Send JSON data.');
    // Vercel may have already parsed the request body before invoking this handler.
    if (req.body !== undefined) {
      const raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
      if (Buffer.byteLength(raw) > 16384) throw new ApiError(413, 'Request is too large.');
      try { const parsed=JSON.parse(raw); if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw Error(); return parsed; }
      catch { throw new ApiError(400, 'Invalid request data.'); }
    }
    let data = '', length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 16384) throw new ApiError(413, 'Request is too large.');
      data += chunk;
    }
    try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(); return parsed; }
    catch { throw new ApiError(400, 'Invalid request data.'); }
  }
  function credentials(data, registration = false) {
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.');
    if (password.length < (registration ? 8 : 1) || password.length > 128) throw new ApiError(400, 'Use a password between 8 and 128 characters.');
    return { email, password };
  }
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const origins = configuredOrigin ? [...deploymentOrigins] : [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
      const hostOrigin = `${production ? 'https' : 'http'}://${req.headers.host}`;
      if (!origins.includes(hostOrigin)) throw new ApiError(403, 'This host is not configured for the app.');
      const url = new URL(req.url, hostOrigin);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          if (store.ping) await store.ping();
          return json(res, 200, {ok:true,storage:serverless?'redis':'json'});
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (!origins.includes(req.headers.origin)) throw new ApiError(403, 'Request origin was rejected.');
          requireCsrf(req);
        }
        if (req.method === 'GET' && url.pathname === '/api/auth/session') {
          const row=await getSession(req);
          return json(res,200,{user:publicUser(row),csrfToken:csrfToken(req,res),stageAccess:accessFor(row)});
        }
        if (req.method === 'GET' && url.pathname === '/api/stages') {
          const row=await getSession(req);
          return json(res,200,{authenticated:!!row,...accessFor(row)});
        }
        if(req.method==='GET'&&url.pathname==='/api/progress'){
          const row=await getSession(req);
          return json(res,200,{user:publicUser(row),catalog,progress:row?await progressFor(row.id):null});
        }
        if(req.method==='POST'&&url.pathname==='/api/progress'){
          const row=await getSession(req);
          if(!row)throw new ApiError(401,'Log in to save account progress.');
          await rateLimit(req,'progress',500);
          const data=await body(req);
          if(data.ownerId!==row.id)throw new ApiError(403,'Account changed. Refresh before saving activity.');
          const stage=Number(data.stage),sound=data.sound;
          if(!Number.isInteger(stage)||!catalog[stage]?.includes(sound)||typeof data.eventId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(data.eventId))throw new ApiError(400,'Invalid sound activity.');
          if(!accessFor(row).stages.find(item=>item.number===stage)?.unlocked)throw new ApiError(403,'This stage is locked.');
          // A retry with the same event ID cannot count playback twice.
          await store.addEvent({user_id:row.id,event_id:data.eventId,stage,sound_key:sound,completed_at:Date.now()});
          return json(res,200,{progress:await progressFor(row.id)});
        }
        if (req.method === 'GET' && url.pathname === '/api/auth/providers') return json(res, 200, { google: { configured: false }, apple: { configured: false } });
        if (req.method === 'POST' && /^\/api\/auth\/(google|apple)$/.test(url.pathname)) {
          const provider = url.pathname.endsWith('google') ? 'Google' : 'Apple';
          throw new ApiError(503, `${provider} sign-in is not configured yet. You can sign up or log in using your email and password.`);
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
          await rateLimit(req, 'signup');
          const data = await body(req);
          const { email, password } = credentials(data, true);
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (name.length < 2 || name.length > 100) throw new ApiError(400, 'Enter a name between 2 and 100 characters.');
          const profile = {};
          for (const field of ['age', 'hearing-age']) {
            const unit = data[`${field}-unit`];
            const raw = data[field];
            const value = raw === '' || raw === undefined || raw === null ? NaN : Number(raw);
            if (!['months', 'years'].includes(unit) || !Number.isFinite(value) || value < 0 || value * (unit === 'years' ? 12 : 1) > 1440) throw new ApiError(400, 'Enter a valid age and hearing age, with months or years.');
            profile[field] = { value, unit };
          }
          const passwordDigest = await passwordHash(password);
          const userId = crypto.randomUUID();
          try { await store.addUser({id:userId,email,name,password_hash:passwordDigest,profile_json:JSON.stringify(profile),created_at:Date.now()}); }
          catch (error) { if (error.message === 'Duplicate email') throw new ApiError(409, 'An account already uses this email. Log in instead.'); throw error; }
          await issueSession(req, res, userId, false);
          return json(res, 201, { user: publicUser(await store.userById(userId)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/login') {
          await rateLimit(req, 'login');
          const { email, password } = credentials(await body(req));
          const user = await store.userByEmail(email);
          const valid = await passwordMatches(password, user?.password_hash || dummyPassword);
          if (!user || !valid) throw new ApiError(401, 'Email or password is incorrect.');
          await issueSession(req, res, user.id, false);
          return json(res, 200, { user: publicUser(user) });
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
          const existing = cookies(req)[sessionName];
          if (existing) await store.removeSession(hash(existing));
          setCookie(res, sessionName, '', 0);
          return json(res, 200, { ok: true });
        }
        throw new ApiError(404, 'This account service is not available.');
      }
      // Serve public pages/assets only. Never expose the JSON data, environment, tools,
      // server source, package metadata, or files outside this project.
      if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'Method not allowed.');
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
      if (relative.includes('\\') || relative.split('/').some(part => part.startsWith('.'))) throw new ApiError(404, 'Not found.');
      if (!(relative.startsWith('assets/') || /^[^/]+\.(html|css|js)$/.test(relative))) throw new ApiError(404, 'Not found.');
      // Enforce stage access on the server, including direct/case-varied URLs.
      const requiredStage=stageForPage(relative);
      if(requiredStage!==null && ![1,2,3].includes(requiredStage)){
        const row=await getSession(req);
        res.setHeader('Cache-Control','no-store');
        if(!row){res.writeHead(303,{Location:'/login.html?next='+encodeURIComponent(relative)});return res.end();}
        const stage=accessFor(row).stages.find(stage=>stage.number===requiredStage);
        if(!stage?.unlocked){res.writeHead(303,{Location:'/home.html?locked-stage='+requiredStage+'#levels'});return res.end();}
      }
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ApiError(404, 'Not found.');
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new ApiError(404, 'Not found.');
      // Authorize only the exact embedded CSS/JS in this HTML response.
      // Hashes preserve CSP protection without enabling arbitrary inline scripts.
      if (path.extname(file).toLowerCase() === '.html') {
        const markup = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
        const hashesFor = tag => [...markup.matchAll(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'gi'))]
          .map(match => "'sha256-" + crypto.createHash('sha256').update(match[1]).digest('base64') + "'").join(' ');
        const policy = res.getHeader('Content-Security-Policy');
        res.setHeader('Content-Security-Policy', policy
          .replace("script-src 'self'", "script-src 'self' " + hashesFor('script'))
          .replace("style-src 'self'", "style-src 'self' " + hashesFor('style')));
      }
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
      const size = fs.statSync(file).size;
      res.setHeader('Content-Type', types[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', requiredStage === null ? 'no-cache' : 'no-store');
      res.setHeader('Accept-Ranges', 'bytes');
      let start = 0, end = size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      res.writeHead(status);
      if (req.method === 'HEAD' || size === 0) return res.end();
      fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
      if (!error.status) console.error('Request failed:', error.code || error.name);
    }
  };
  const server = http.createServer(handler);
  server.requestTimeout = 30000;
  return { server, handler, store, async close() { await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createApp };
if (require.main === module) {
  createApp().then(app => {
    const port = Number(process.env.PORT || 3000);
    app.server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`HEARNEST is running at ${process.env.APP_ORIGIN || `http://localhost:${app.server.address().port}`}`));
    const shutdown = () => app.close().then(() => process.exit());
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port is already in use. Set PORT to another port.' : error.message); process.exitCode = 1; });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
