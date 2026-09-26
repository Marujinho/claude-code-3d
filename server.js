// Bridge between Claude Code hooks and the 3D scene.
// Usage: node server.js  →  open http://localhost:4545
// The hooks (hooks.json) send POST /hook with the event JSON; the page listens on GET /events (SSE).
// The page's chat sends POST /prompt; the server runs `claude -p` and streams the answer back over the same SSE.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 4545;
const HOST = '127.0.0.1';        // this machine only: the /prompt route runs Claude
const DONE_TO_IDLE_MS = 8000;   // after "Done", go back to sleep
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();   // folder where the chat's Claude works
const PERMS_PATH = path.join(__dirname, 'chat-permissions.json');   // chosen on the page's /settings screen (per machine, not committed)
const HTML_PATH = path.join(__dirname, 'office.html');   // read on every GET /: edit the HTML and just reload the page

const clients = new Set();
let current = 'idle', idleTimer = null;

function send(event, data) {
  if (event === 'chat') remember(data);
  const msg = (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// Chat history: if the page loses the connection mid-answer (background tab, Mac went to sleep,
// reload), it gets everything again on reconnect instead of ending up with an empty chat.
const HISTORY_TYPES = ['start', 'textStart', 'delta', 'note', 'result', 'idle'];
let history = [];
function remember(d) {
  if (d.type === 'reset') { history = []; return; }
  if (!HISTORY_TYPES.includes(d.type)) return;
  const last = history[history.length - 1];
  if (d.type === 'delta' && last && last.type === 'delta') { history[history.length - 1] = { type: 'delta', text: last.text + d.text }; return; }
  history.push(d);
  if (history.length > 400) history = history.slice(-400);
}

function broadcast(mode, why) {
  if (mode === current) return;
  current = mode;
  console.log(new Date().toLocaleTimeString(), '→', mode, why ? `(${why})` : '');
  send(null, { mode });
}

function applyMode(mode, why) {
  clearTimeout(idleTimer);
  if (mode) broadcast(mode, why);
  if (mode === 'done') idleTimer = setTimeout(() => broadcast('idle', 'timeout'), DONE_TO_IDLE_MS);
}

// Claude Code event → character mode
function modeFor(ev) {
  const e = ev.hook_event_name, tool = ev.tool_name || '', pm = ev.permission_mode;
  if (e === 'SessionStart') return 'idle';
  if (e === 'SessionEnd') return 'idle';
  if (e === 'UserPromptSubmit') return pm === 'plan' ? 'planning' : 'thinking';
  if (e === 'Notification') {
    const t = ev.notification_type || '';
    if (/permission|idle|needs_input|elicitation/.test(t)) return 'waiting';
    return null;
  }
  if (e === 'PreToolUse' || e === 'PostToolUse') {
    if (pm === 'plan') return 'planning';
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'coding';
    if (/^(Bash|PowerShell)$/.test(tool)) return 'coding';
    if (/^(Read|Grep|Glob|WebFetch|WebSearch|LS)$/.test(tool)) return 'review';
    if (/^(Task|Agent|TodoWrite|TaskCreate|EnterPlanMode|ExitPlanMode|AskUserQuestion)$/.test(tool)) return tool === 'AskUserQuestion' ? 'waiting' : 'thinking';
    return 'thinking';
  }
  if (e === 'SubagentStart') return 'thinking';
  if (e === 'Stop') return 'done';
  return null;
}

/* ---------- usage limit: POST /usage (Claude Code status line) → energy bar ---------- */
let usage = null;   // { used: 0–100, resetsAt: epoch seconds }

function setUsage(used, resetsAt) {
  if (typeof used !== 'number' || !isFinite(used)) return;
  used = Math.max(0, Math.min(100, used));
  if (usage && usage.used === used && usage.resetsAt === resetsAt) return;
  usage = { used, resetsAt: resetsAt || null };
  send('usage', usage);
}

// Accepts the JSON Claude Code sends to the status line (rate_limits.five_hour) or a manual { used, resetsAt }.
function usageFrom(body) {
  const d = JSON.parse(body || '{}');
  const five = d.rate_limits && d.rate_limits.five_hour;
  if (five) return setUsage(five.used_percentage, five.resets_at);
  if (d.used != null) setUsage(Number(d.used), d.resetsAt);
}

// Same numbers as /usage, read straight from the account. /usage doesn't run under `claude -p`, so the server
// asks the Anthropic API using the login Claude Code already stored (Keychain on macOS, ~/.claude on Linux).
// It's an undocumented endpoint: if it stops responding, the bar still comes from the status line.
function readToken() {
  const parse = s => { try { return JSON.parse(s).claudeAiOauth.accessToken || null; } catch (_) { return null; } };
  const fromFile = resolve => fs.readFile(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8',
    (err, s) => resolve(err ? null : parse(s)));
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return fromFile(resolve);
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, out) => {
      const t = err ? null : parse(out);
      t ? resolve(t) : fromFile(resolve);
    });
  });
}

let usageBusy = false;
async function refreshUsage(why) {
  if (usageBusy) return;
  usageBusy = true;
  try {
    const token = await readToken();
    if (!token) throw new Error('Claude Code login not found (run `claude` and log in)');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const five = (await r.json()).five_hour;
    if (!five || five.utilization == null) throw new Error('response has no five_hour');
    setUsage(Number(five.utilization), five.resets_at ? Math.round(Date.parse(five.resets_at) / 1000) || null : null);
    console.log(new Date().toLocaleTimeString(), `usage limit: ${Math.round(usage.used)}% used (${why})`);
  } catch (e) {
    console.log(new Date().toLocaleTimeString(), `couldn't read the usage limit: ${e.message} (${why})`);
  } finally {
    usageBusy = false;
  }
}

/* ---------- skills: folders with SKILL.md in the project (.claude/skills); global ones (~/.claude/skills) are left out ---------- */
// Read on every page connection: create a skill and just reload.
function listSkills() {
  const dirs = [path.join(CLAUDE_CWD, '.claude', 'skills')];
  const seen = new Map();
  for (const dir of dirs) {
    let names = []; try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      let md; try { md = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8'); } catch (_) { continue; }
      const fm = (md.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
      const field = k => ((fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
      const name = field('name') || n;
      if (field('user-invocable') === 'false' || seen.has(name) || !/^[\w.:-]+$/.test(name)) continue;   // only ones callable as /name
      seen.set(name, { name, description: field('description') });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- MCP servers available in the project: .mcp.json (project) + ~/.claude.json (local and user scopes) ---------- */
// Plus whatever `claude mcp list` reports that isn't in those files (claude.ai connectors, plugins): see checkMcps().
// Read on every page connection, like the skills. Only name, type and scope go to the page: env and headers can hold secrets.
let mcpListed = [];   // servers from the last `claude mcp list` run
function listMcps() {
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (_) { return {}; } };
  const cfg = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'));
  const sources = [   // same precedence as Claude Code: local > project > user
    ['local', ((cfg.projects || {})[CLAUDE_CWD] || {}).mcpServers],
    ['project', readJson(path.join(CLAUDE_CWD, '.mcp.json')).mcpServers],
    ['user', cfg.mcpServers],
  ];
  const seen = new Map();
  for (const [scope, servers] of sources)
    for (const [name, s] of Object.entries(servers || {})) {
      if (seen.has(name) || !s || typeof s !== 'object') continue;
      const type = s.type || (s.url ? 'http' : 'stdio');
      // command without args and URL without query: both can carry API keys
      seen.set(name, { name, scope, type, target: type === 'stdio' ? String(s.command || '') : String(s.url || '').split('?')[0] });
    }
  for (const s of mcpListed) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).map(s => ({ ...s, status: mcpStatus[s.name] || 'checking' }));
}

// Connection/login status comes from `claude mcp list`, which health-checks every server (can take a few seconds).
// Lines look like "name: target (HTTP) - ✔ Connected" / "- ⚠ Needs authentication" / "- ✗ Failed to connect".
// 'checking' (not known yet) → yellow, 'ok' → green, 'auth' / 'error' → red on the page.
let mcpStatus = {}, mcpChecking = false, mcpCheckedAt = 0;
function checkMcps(why) {
  if (mcpChecking || Date.now() - mcpCheckedAt < 15000) return;
  mcpChecking = true;
  execFile('claude', ['mcp', 'list'], { cwd: CLAUDE_CWD, timeout: 60000 }, (err, out) => {
    mcpChecking = false; mcpCheckedAt = Date.now();
    const statusOf = st => /✓|✔|connected/i.test(st) && !/fail/i.test(st) ? 'ok' : /auth/i.test(st) ? 'auth' : 'error';
    const lines = String(out || '').split('\n').map(l => l.match(/^(.+?): (.+) - (.+)$/)).filter(Boolean);
    mcpListed = lines.map(([, name, target]) => {
      const url = /^https?:\/\//.test(target);
      // URL without query, command without args: both can carry API keys
      return { name, scope: name.startsWith('claude.ai ') ? 'claude.ai' : 'other', type: url ? 'http' : 'stdio', target: url ? target.split(/[?\s]/)[0] : target.split(' ')[0] };
    });
    const next = {};
    for (const s of listMcps()) {
      const line = lines.find(m => m[1] === s.name);
      next[s.name] = statusOf(line ? line[3] : '');
    }
    mcpStatus = next;
    console.log(new Date().toLocaleTimeString(), `MCP status: ${Object.entries(next).map(([n, s]) => n + '=' + s).join(', ') || 'none'} (${why})`);
    send('chat', { type: 'mcps', mcps: listMcps() });
  });
}

/* ---------- past conversations: ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session id>.jsonl ---------- */
// Same folder Claude Code uses, so the list has both the page's chats and the ones from your terminal in CLAUDE_CWD.
const SESSIONS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', CLAUDE_CWD.replace(/[^a-zA-Z0-9]/g, '-'));

// One transcript line → what the chat shows: { me } for a typed prompt, { ai } for text Claude wrote, null for the rest.
function transcriptEntry(m) {
  if (!m.message || m.isSidechain || m.isMeta || m.isCompactSummary) return null;
  const c = m.message.content;
  if (m.type === 'user') {
    if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return null;
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '').trim();
    const cmd = text.match(/<command-name>(.*?)<\/command-name>/);   // slash commands are stored as tags
    if (cmd) { const a = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1]; return { me: (cmd[1] + (a ? ' ' + a : '')).trim() }; }
    if (!text || /^<(local-command|system-reminder|bash-)/.test(text)) return null;
    return { me: text };
  }
  if (m.type === 'assistant' && Array.isArray(c)) {
    const text = c.filter(b => b.type === 'text').map(b => b.text).join('');
    return text.trim() ? { ai: text } : null;
  }
  return null;
}

function readTranscript(id) {
  const entries = []; let title = '';
  for (const line of fs.readFileSync(path.join(SESSIONS_DIR, id + '.jsonl'), 'utf8').split('\n')) {
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.type === 'custom-title' && m.customTitle) title = m.customTitle;   // set with /rename
    const e = transcriptEntry(m); if (e) entries.push(e);
  }
  const first = entries.find(e => e.me);
  return { entries, title: title || (first ? first.me.replace(/\s+/g, ' ').slice(0, 80) : '') };
}

// The 10 most recent conversations that have at least one prompt.
function listSessions() {
  let files = []; try { files = fs.readdirSync(SESSIONS_DIR).filter(f => /^[\w-]+\.jsonl$/.test(f)); } catch (_) { return []; }
  const byDate = files.map(f => { try { return { id: f.slice(0, -6), time: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }; } catch (_) { return null; } })
    .filter(Boolean).sort((a, b) => b.time - a.time);
  const out = [];
  for (const s of byDate) {
    if (out.length >= 10) break;
    let title = ''; try { title = readTranscript(s.id).title; } catch (_) {}
    if (title) out.push({ ...s, title });
  }
  return out;
}

/* ---------- chat: POST /prompt → claude -p ---------- */
let chatProc = null, sessionId = null;
let permMode = 'normal';   // 'plan' = /plan (read and plan only); 'normal' = the mode chosen in /settings

/* ---------- chat permissions: chat-permissions.json, written by POST /permissions ---------- */
// Groups the user turns on in /settings. Reading files is always on; the defaults match the old fixed setup.
const PERM_GROUPS = { edit: 'Edit,Write', bash: 'Bash', web: 'WebFetch,WebSearch' };
const PERM_MODES = ['acceptEdits', 'auto'];   // run everything checked / auto mode reviews each action, like the terminal
const PERM_DEFAULTS = { edit: true, bash: false, web: false, mcp: false, mode: 'acceptEdits' };

// Only booleans for the groups and a known mode: anything else is rejected, never passed on to `claude`.
function validPermissions(d) {
  if (!d || typeof d !== 'object') return null;
  const out = { version: 1 };
  for (const k of [...Object.keys(PERM_GROUPS), 'mcp']) { if (typeof d[k] !== 'boolean') return null; out[k] = d[k]; }
  if (!PERM_MODES.includes(d.mode)) return null;
  out.mode = d.mode;
  return out;
}

// null = not chosen yet (the page shows the onboarding). Read on every run, so saving applies to the next message.
function readPermissions() {
  try { return validPermissions(JSON.parse(fs.readFileSync(PERMS_PATH, 'utf8'))); } catch (_) { return null; }
}

function chatArgs(perms) {
  const tools = ['Read,Grep,Glob', ...Object.keys(PERM_GROUPS).filter(k => perms[k]).map(k => PERM_GROUPS[k])].join(',');
  // --tools = what exists; --allowedTools = pre-approved. In auto mode nothing is pre-approved: the classifier reviews each action.
  return ['--tools', tools, ...(perms.mode === 'auto' ? [] : ['--allowedTools', tools]), ...(perms.mcp ? [] : ['--strict-mcp-config']),
    '--permission-mode', permMode === 'plan' ? 'plan' : perms.mode];
}

function runPrompt(text, perms) {
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...chatArgs(perms)];
  if (sessionId) args.push('--resume', sessionId);   // continues the chat's conversation, not your terminal's
  const proc = chatProc = spawn('claude', args, { cwd: CLAUDE_CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  send('chat', { type: 'start', text });
  const pm = permMode, thinkMode = pm === 'plan' ? 'planning' : 'thinking';
  applyMode(thinkMode, 'chat');

  let buf = '', errBuf = '', gotResult = false, gotText = false;
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');   // don't split multi-byte characters between chunks
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.session_id) sessionId = m.session_id;
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_start' && e.content_block.type === 'tool_use')
          applyMode(modeFor({ hook_event_name: 'PreToolUse', tool_name: e.content_block.name, permission_mode: pm }), 'chat:' + e.content_block.name);
        else if (e.type === 'content_block_start' && e.content_block.type === 'text') send('chat', { type: 'textStart' });
        else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') { gotText = true; send('chat', { type: 'delta', text: e.delta.text }); }
      } else if (m.type === 'assistant') {
        for (const b of m.message.content || [])
          if (b.type === 'tool_use') send('chat', { type: 'tool', name: b.name, target: b.input.file_path || b.input.pattern || b.input.command || '' });
      } else if (m.type === 'user') {
        applyMode(thinkMode, 'chat');   // tool result came back; Claude is thinking again
      } else if (m.type === 'system' && m.subtype === 'status') {
        if (m.status === 'compacting') send('chat', { type: 'activity', text: 'compacting the conversation…' });
        if (m.compact_result === 'success') send('chat', { type: 'note', text: 'Conversation compacted.' });
      } else if (m.type === 'result') {
        gotResult = true;
        // commands like /context only answer in the result, with no streamed text
        if (!gotText && !m.is_error) send('chat', { type: 'note', text: m.result || 'Claude finished without writing a reply.' });
        send('chat', { type: 'result', ok: !m.is_error, error: m.is_error ? (m.result || m.subtype) : null });
      }
    }
  });
  proc.stderr.on('data', c => { errBuf += c; });
  proc.on('error', err => { errBuf += err.message; });
  proc.on('close', (code, signal) => {
    if (chatProc === proc) chatProc = null;
    if (!gotResult) send('chat', { type: 'result', ok: false, error: signal ? 'interrupted' : (errBuf.trim() || `claude exited with code ${code}`) });
    applyMode(gotResult && !signal ? 'done' : 'idle', 'chat');
    send('chat', { type: 'idle' });
    refreshUsage('chat finished');   // done executing/planning: refresh the bar
  });
}

// Only accept commands from the page itself: blocks outside sites (CSRF) and DNS rebinding.
function sameOrigin(req) {
  const host = req.headers.host || '';
  if (!new RegExp(`^(localhost|127\\.0\\.0\\.1):${PORT}$`).test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return /application\/json/.test(req.headers['content-type'] || '');
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => cb(body));
}

function json(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/settings' || req.url.startsWith('/#'))) {   // /settings = same page, settings screen open
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(HTML_PATH));
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ mode: current })}\n\n`);
    res.write(`event: chat\ndata: ${JSON.stringify({ type: 'hello', busy: !!chatProc, cwd: CLAUDE_CWD, permMode, hasSession: !!sessionId, permissions: readPermissions(), permDefaults: PERM_DEFAULTS, skills: listSkills(), mcps: listMcps() })}\n\n`);
    for (const d of history) res.write(`event: chat\ndata: ${JSON.stringify({ ...d, replay: true })}\n\n`);
    if (usage) res.write(`event: usage\ndata: ${JSON.stringify(usage)}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    checkMcps('page connected');
    const ping = setInterval(() => res.write(': ping\n\n'), 25000); req.on('close', () => clearInterval(ping));
    return;
  }
  if (req.method === 'POST' && ['/prompt', '/command'].includes(req.url)) {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin not allowed' });
    return readBody(req, body => {
      let data = {}; try { data = JSON.parse(body) || {}; } catch (_) {}
      const perms = readPermissions();
      const runsClaude = req.url === '/prompt' || ['skill', 'compact', 'init', 'context'].includes(data.name);
      if (runsClaude && !perms) return json(res, 409, { error: 'set permissions first (Settings)' });
      if (req.url === '/command') {
        // "Commands" panel buttons: same as typing /plan, /clear… in Claude Code
        const name = String(data.name || '');
        if (name === 'stop') { if (chatProc) chatProc.kill('SIGTERM'); return json(res, 200, {}); }
        if (name === 'plan' || name === 'normal') {
          permMode = name === 'plan' ? 'plan' : 'normal';
          send('chat', { type: 'perm', permMode });
          return json(res, 200, {});
        }
        if (name === 'sessions') return json(res, 200, { sessions: listSessions(), current: sessionId });   // "Talk to Claude" dropdown
        if (chatProc) return json(res, 409, { error: 'wait for Claude to finish' });
        if (name === 'resume') {   // loads a past conversation into the chat; the next message continues it (--resume)
          const id = String(data.session || '');
          let t; try { if (!/^[\w-]+$/.test(id)) throw 0; t = readTranscript(id); } catch (_) { return json(res, 404, { error: 'conversation not found' }); }
          sessionId = id;
          send('chat', { type: 'reset' });
          send('chat', { type: 'note', text: 'Resumed: ' + (t.title || id) });
          for (const e of t.entries) {
            if (e.me) send('chat', { type: 'start', text: e.me });
            else { send('chat', { type: 'textStart' }); send('chat', { type: 'delta', text: e.ai }); }
          }
          send('chat', { type: 'result', ok: true });
          send('chat', { type: 'idle' });
          return json(res, 200, {});
        }
        if (name === 'skill') {   // "Skills" panel: runs /skill-name
          const skill = String(data.skill || '');
          if (!listSkills().some(s => s.name === skill)) return json(res, 404, { error: 'skill not found' });
          runPrompt('/' + skill, perms); return json(res, 200, {});
        }
        if (name === 'clear') { sessionId = null; send('chat', { type: 'reset' }); return json(res, 200, {}); }
        if (['compact', 'init', 'context'].includes(name)) {
          if (name !== 'init' && !sessionId) return json(res, 409, { error: 'no conversation yet' });
          runPrompt('/' + name, perms); return json(res, 200, {});
        }
        return json(res, 400, { error: 'unknown command' });
      }
      const text = String(data.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      if (chatProc) return json(res, 409, { error: 'Claude is still working' });
      runPrompt(text, perms);
      json(res, 200, {});
    });
  }
  if (req.method === 'POST' && req.url === '/permissions') {   // "Save" on the /settings screen
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin not allowed' });
    return readBody(req, body => {
      let perms = null; try { perms = validPermissions(JSON.parse(body)); } catch (_) {}
      if (!perms) return json(res, 400, { error: 'invalid permissions' });
      if (chatProc) return json(res, 409, { error: 'wait for Claude to finish' });
      fs.writeFileSync(PERMS_PATH, JSON.stringify(perms, null, 2) + '\n');
      console.log(new Date().toLocaleTimeString(), `chat permissions: ${JSON.stringify(perms)}`);
      send('chat', { type: 'permissions', permissions: perms });
      json(res, 200, { permissions: perms });
    });
  }
  if (req.method === 'POST' && req.url === '/usage') {
    return readBody(req, body => {
      try { usageFrom(body); } catch (_) {}
      // the response becomes the status line text in the terminal
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(usage ? `⚡ ${Math.round(100 - usage.used)}% energy` : '');
    });
  }
  if (req.method === 'POST' && (req.url === '/hook' || req.url.startsWith('/mode/'))) {
    return readBody(req, body => {
      let mode = null, why = '';
      if (req.url.startsWith('/mode/')) mode = req.url.slice(6);                 // POST /mode/coding (manual)
      else { try {
        const ev = JSON.parse(body || '{}'); mode = modeFor(ev); why = ev.hook_event_name + (ev.tool_name ? ':' + ev.tool_name : '');
        if (ev.hook_event_name === 'Stop') refreshUsage('Stop in terminal');   // a task finished in the terminal's Claude Code
      } catch (_) {} }
      applyMode(mode, why);
      json(res, 200, {});
    });
  }
  res.writeHead(404); res.end();
}).listen(PORT, HOST, () => {
  console.log(`3D Office at http://localhost:${PORT}  (waiting for Claude Code hooks; chat works in ${CLAUDE_CWD})`);
  refreshUsage('server started');
});
