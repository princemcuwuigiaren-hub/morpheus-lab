#!/usr/bin/env node
/*
  Morpheus Lab bridge for Termux. No dependencies.

  Start it:   node morpheus-bridge.js
  It listens only on this phone (127.0.0.1), answers only the site(s) you allow,
  and needs the token it prints. It can run only node, npm and npx, in a folder per project.

  Options:
    --origin https://your.site   allow another site (can be repeated)
    --port 8787                  use another port
    --dir /path/to/folder        use another workspace folder
    --rotate                     make a new token
*/
'use strict';
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var VERSION = '1.0.0';
var DEFAULT_ORIGIN = '__ORIGIN__';
var ALLOWED_CMDS = ['node', 'npm', 'npx'];
var MAX_RUNS = 2;
var MAX_OUT = 1500000;
var MAX_BODY = 20 * 1024 * 1024;

var opt = { port: 8787, origins: [], dir: '', rotate: false };
var argv = process.argv.slice(2);
for (var i = 0; i < argv.length; i++) {
  var a = argv[i];
  if (a === '--port') opt.port = parseInt(argv[++i], 10) || 8787;
  else if (a === '--origin') opt.origins.push(String(argv[++i] || '').replace(/\/+$/, ''));
  else if (a === '--dir') opt.dir = argv[++i] || '';
  else if (a === '--rotate') opt.rotate = true;
  else if (a === '--help' || a === '-h') {
    console.log('Usage: node morpheus-bridge.js [--origin https://site] [--port 8787] [--dir folder] [--rotate]');
    process.exit(0);
  }
}
if (DEFAULT_ORIGIN.indexOf('http') === 0 && opt.origins.indexOf(DEFAULT_ORIGIN) < 0) opt.origins.push(DEFAULT_ORIGIN);
opt.origins = opt.origins.filter(function (o) { return /^https?:\/\/[^\/]+$/.test(o); });

var ROOT = path.resolve(opt.dir || path.join(os.homedir(), 'morpheus-workspace'));
fs.mkdirSync(ROOT, { recursive: true });
var REAL_ROOT = fs.realpathSync(ROOT);

/* ---- the token: made once, kept in a private file, shown every time the bridge starts ---- */
var TOKEN_FILE = path.join(os.homedir(), '.morpheus-bridge-token');
function newToken() {
  var abc = 'abcdefghjkmnpqrstuvwxyz23456789', bytes = crypto.randomBytes(20), t = '';
  for (var k = 0; k < 20; k++) {
    t += abc.charAt(bytes[k] % abc.length);
    if (k % 5 === 4 && k < 19) t += '-';
  }
  return t;
}
var TOKEN = '';
try { if (!opt.rotate) TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
if (!/^[a-z2-9-]{20,}$/.test(TOKEN)) {
  TOKEN = newToken();
  try { fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 384 }); } catch (e) { console.log('Could not save the token file: ' + e.message); }
}
function tokenOk(given) {
  var a = Buffer.from(String(given)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---- small helpers ---- */
function stamp() { return new Date().toLocaleTimeString(); }
function logLine(s) { console.log(stamp() + '  ' + s); }
function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600'
  };
}
function send(res, code, obj, origin) {
  var h = corsHeaders(origin);
  h['Content-Type'] = 'application/json';
  h['Cache-Control'] = 'no-store';
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}
function readJson(req, cb) {
  var size = 0, parts = [], dead = false;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { dead = true; req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', function () {
    if (dead) return;
    var o = null;
    try { o = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (e) { return cb(null); }
    cb(o && typeof o === 'object' ? o : null);
  });
  req.on('error', function () {});
}
function cleanProject(p) {
  p = String(p || '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(p) ? p : '';
}
/* a path inside a project folder, never outside it, including through symbolic links */
function safeJoin(projDir, rel) {
  rel = String(rel || '');
  if (!rel || rel.indexOf('\0') >= 0 || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return '';
  var parts = rel.split(/[\\\/]+/).filter(function (x) { return x && x !== '.'; });
  if (!parts.length || parts.indexOf('..') >= 0) return '';
  var full = path.join(projDir, parts.join(path.sep));
  var top = path.resolve(projDir) + path.sep;
  if (full.indexOf(top) !== 0) return '';
  var probe = full;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  var real = fs.realpathSync(probe) + path.sep;
  if (real.indexOf(REAL_ROOT + path.sep) !== 0) return '';
  return full;
}
function projDirOf(name) {
  var dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---- failed password tries slow down ---- */
var fails = [];
function tooManyFails() {
  var now = Date.now();
  fails = fails.filter(function (t) { return now - t < 60000; });
  return fails.length >= 10;
}

/* ---- running commands ---- */
var runs = {};
function runCount() { return Object.keys(runs).length; }
function killRun(r) {
  if (!r || r.killed) return;
  r.killed = true;
  try { process.kill(-r.child.pid, 'SIGTERM'); } catch (e) { try { r.child.kill('SIGTERM'); } catch (e2) {} }
  setTimeout(function () {
    try { process.kill(-r.child.pid, 'SIGKILL'); } catch (e) { try { r.child.kill('SIGKILL'); } catch (e2) {} }
  }, 3000);
}
function doRun(req, res, origin, body) {
  var proj = cleanProject(body.project);
  var cmd = String(body.cmd || '');
  var cargs = Array.isArray(body.args) ? body.args.map(String) : null;
  if (!proj) return send(res, 400, { ok: false, error: 'Bad project name.' }, origin);
  if (ALLOWED_CMDS.indexOf(cmd) < 0) return send(res, 400, { ok: false, error: 'Only node, npm and npx can run here.' }, origin);
  if (!cargs || cargs.length > 60 || cargs.some(function (x) { return x.length > 4000 || x.indexOf('\0') >= 0; })) {
    return send(res, 400, { ok: false, error: 'Those arguments are not accepted.' }, origin);
  }
  if (cmd !== 'node') {
    for (var k = 0; k < cargs.length; k++) {
      var x = cargs[k];
      if (x === '-g' || x === '--global' || /^--location=global$/.test(x) || (x === '--location' && cargs[k + 1] === 'global')) {
        return send(res, 400, { ok: false, error: 'Global installs are blocked. Install inside the project instead.' }, origin);
      }
    }
  }
  if (runCount() >= MAX_RUNS) return send(res, 429, { ok: false, error: 'Two commands are already running. Stop one first.' }, origin);
  var ms = Math.min(Math.max(parseInt(body.timeout, 10) || 120000, 1000), 900000);
  var dir = projDirOf(proj);
  var env = {};
  Object.keys(process.env).forEach(function (key) { env[key] = process.env[key]; });
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.npm_config_color = 'false';
  env.npm_config_progress = 'false';
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  var id = crypto.randomBytes(6).toString('hex');
  var h = corsHeaders(origin);
  h['Content-Type'] = 'application/x-ndjson';
  h['Cache-Control'] = 'no-store';
  res.writeHead(200, h);
  var ended = false;
  function line(o) { if (!ended && !res.writableEnded) res.write(JSON.stringify(o) + '\n'); }
  var shown = cmd + ' ' + cargs.join(' ');
  logLine('run  [' + proj + ']  ' + shown.slice(0, 160));
  line({ t: 'start', id: id });
  var t0 = Date.now(), bytes = 0, truncated = false, timedOut = false, child;
  try {
    child = cp.spawn(cmd === 'node' ? process.execPath : cmd, cargs, { cwd: dir, env: env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    line({ t: 'err', d: 'Could not start ' + cmd + ': ' + e.message + '\n' });
    line({ t: 'end', code: 127, signal: '', timedOut: false, truncated: false, ms: 0 });
    ended = true; return res.end();
  }
  var r = { child: child, killed: false };
  runs[id] = r;
  var timer = setTimeout(function () { timedOut = true; killRun(r); }, ms);
  function feed(kind) {
    return function (chunk) {
      bytes += chunk.length;
      if (bytes > MAX_OUT) { if (!truncated) { truncated = true; line({ t: 'err', d: '\n[output limit reached, command stopped]\n' }); killRun(r); } return; }
      line({ t: kind, d: chunk });
    };
  }
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', feed('out'));
  child.stderr.on('data', feed('err'));
  child.on('error', function (e) {
    var msg = e && e.code === 'ENOENT' ? cmd + ' was not found. In Termux run: pkg install nodejs' : (e && e.message) || 'The command failed to start.';
    line({ t: 'err', d: msg + '\n' });
  });
  child.on('close', function (code, signal) {
    clearTimeout(timer);
    delete runs[id];
    line({ t: 'end', code: code === null ? -1 : code, signal: signal || '', timedOut: timedOut, truncated: truncated, ms: Date.now() - t0 });
    ended = true;
    res.end();
  });
  res.on('close', function () { if (!ended) { clearTimeout(timer); killRun(r); } });
}

/* ---- files ---- */
function walk(dir, base, out, depth) {
  var names;
  try { names = fs.readdirSync(dir).sort(); } catch (e) { return; }
  for (var n = 0; n < names.length && out.length < 400; n++) {
    var name = names[n];
    if (name === '.git') continue;
    var rel = base ? base + '/' + name : name, st;
    try { st = fs.lstatSync(path.join(dir, name)); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (name === 'node_modules') { out.push({ path: rel + '/', dir: true, note: 'not listed' }); continue; }
      if (depth < 6) walk(path.join(dir, name), rel, out, depth + 1);
    } else {
      out.push({ path: rel, size: st.size });
    }
  }
}
var npmVersion = null;
function getNpm(cb) {
  if (npmVersion !== null) return cb(npmVersion);
  cp.execFile('npm', ['-v'], { timeout: 15000 }, function (err, stdout) {
    npmVersion = err ? '' : String(stdout).trim();
    cb(npmVersion);
  });
}

/* ---- the server ---- */
var server = http.createServer(function (req, res) {
  var origin = req.headers.origin || '';
  var host = String(req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { ok: false, error: 'Bad host.' }, '');
  if (origin && opt.origins.indexOf(origin) < 0) {
    logLine('BLOCKED a request from ' + origin + '  (to allow it: --origin ' + origin + ')');
    return send(res, 403, { ok: false, error: 'This site is not allowed.' }, '');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(origin)); return res.end(); }
  var url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(res, 400, { ok: false, error: 'Bad address.' }, origin); }
  var route = url.pathname;

  if (req.method === 'GET' && route === '/health') {
    return send(res, 200, { name: 'morpheus-termux', version: VERSION, node: process.version }, origin);
  }

  if (tooManyFails()) return send(res, 429, { ok: false, error: 'Too many wrong tokens. Wait a minute.' }, origin);
  var m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
  if (!m || !tokenOk(m[1].trim())) {
    fails.push(Date.now());
    logLine('wrong token from ' + (origin || 'a local program'));
    return send(res, 401, { ok: false, error: 'unauthorized' }, origin);
  }

  if (req.method === 'GET' && route === '/info') {
    return getNpm(function (npm) {
      send(res, 200, { ok: true, version: VERSION, node: process.version, npm: npm, workspace: ROOT, platform: process.platform, termux: /com\.termux/.test(process.env.PREFIX || '') || !!process.env.TERMUX_VERSION }, origin);
    });
  }

  if (req.method === 'GET' && route === '/list') {
    var lp = cleanProject(url.searchParams.get('project'));
    if (!lp) return send(res, 400, { ok: false, error: 'Bad project name.' }, origin);
    var items = [];
    walk(projDirOf(lp), '', items, 0);
    return send(res, 200, { ok: true, files: items }, origin);
  }

  if (req.method === 'GET' && route === '/read') {
    var rp = cleanProject(url.searchParams.get('project'));
    if (!rp) return send(res, 400, { ok: false, error: 'Bad project name.' }, origin);
    var full = safeJoin(projDirOf(rp), url.searchParams.get('path'));
    if (!full) return send(res, 400, { ok: false, error: 'That path is not allowed.' }, origin);
    var st;
    try { st = fs.statSync(full); } catch (e) { return send(res, 404, { ok: false, error: 'No such file.' }, origin); }
    if (!st.isFile()) return send(res, 400, { ok: false, error: 'That is not a file.' }, origin);
    var fd = fs.openSync(full, 'r'), buf = Buffer.alloc(Math.min(st.size, 1000000));
    fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    return send(res, 200, { ok: true, text: buf.toString('utf8'), size: st.size, truncated: st.size > buf.length }, origin);
  }

  if (req.method === 'POST' && (route === '/write' || route === '/run' || route === '/kill' || route === '/reset')) {
    return readJson(req, function (body) {
      if (!body) return send(res, 400, { ok: false, error: 'The request was not understood.' }, origin);
      if (route === '/run') return doRun(req, res, origin, body);
      if (route === '/kill') {
        var r = runs[String(body.id || '')];
        if (!r) return send(res, 404, { ok: false, error: 'No such command is running.' }, origin);
        killRun(r);
        return send(res, 200, { ok: true }, origin);
      }
      var proj = cleanProject(body.project);
      if (!proj) return send(res, 400, { ok: false, error: 'Bad project name.' }, origin);
      if (route === '/reset') {
        var dir = path.join(ROOT, proj);
        if (runCount() > 0) return send(res, 409, { ok: false, error: 'Stop the running commands first.' }, origin);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return send(res, 500, { ok: false, error: e.message }, origin); }
        logLine('reset [' + proj + ']');
        return send(res, 200, { ok: true }, origin);
      }
      var files = Array.isArray(body.files) ? body.files : null;
      if (!files || !files.length || files.length > 500) return send(res, 400, { ok: false, error: 'Send between 1 and 500 files.' }, origin);
      var pd = projDirOf(proj), written = [];
      for (var f = 0; f < files.length; f++) {
        var item = files[f] || {};
        var target = safeJoin(pd, item.path);
        if (!target) return send(res, 400, { ok: false, error: 'This path is not allowed: ' + String(item.path).slice(0, 80) }, origin);
        var text = String(item.text === undefined ? '' : item.text);
        if (Buffer.byteLength(text) > 5 * 1024 * 1024) return send(res, 400, { ok: false, error: 'A file is over 5 MB.' }, origin);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, 'utf8');
        written.push({ path: path.relative(pd, target).split(path.sep).join('/'), size: Buffer.byteLength(text) });
      }
      logLine('write [' + proj + ']  ' + written.length + ' file' + (written.length === 1 ? '' : 's'));
      return send(res, 200, { ok: true, written: written }, origin);
    });
  }

  send(res, 404, { ok: false, error: 'Unknown request.' }, origin);
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') console.log('Port ' + opt.port + ' is already in use. Is the bridge already running? Use --port to pick another.');
  else console.log('Server error: ' + e.message);
  process.exit(1);
});
server.listen(opt.port, '127.0.0.1', function () {
  console.log('');
  console.log('Morpheus bridge ' + VERSION);
  console.log('  Address   http://127.0.0.1:' + opt.port);
  console.log('  Workspace ' + ROOT);
  console.log('  Allowed   ' + (opt.origins.join(', ') || 'no site yet: start with --origin https://your.site'));
  console.log('  Token     ' + TOKEN);
  console.log('');
  console.log('Paste the token into the Lab (Settings > Termux). Press Ctrl+C to stop.');
  console.log('');
  try { var wl = cp.spawn('termux-wake-lock', [], { stdio: 'ignore' }); wl.on('error', function () {}); } catch (e) {}
});
process.on('SIGINT', function () {
  Object.keys(runs).forEach(function (id) { killRun(runs[id]); });
  console.log('\nStopped.');
  setTimeout(function () { process.exit(0); }, 200);
});
