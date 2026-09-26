// Ponte entre os hooks do Claude Code e a cena 3D.
// Uso: node server.js  →  abre http://localhost:4545
// Os hooks (hooks.json) mandam POST /hook com o JSON do evento; a página escuta GET /events (SSE).
// O chat da página manda POST /prompt; o servidor roda `claude -p` e devolve a resposta pelo mesmo SSE.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 4545;
const HOST = '127.0.0.1';        // só esta máquina: a rota /prompt executa o Claude
const DONE_TO_IDLE_MS = 8000;   // depois de "Concluído", volta a dormir
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();   // pasta onde o Claude do chat trabalha
const CHAT_TOOLS = 'Read,Grep,Glob,Edit,Write';               // ler e editar arquivos; sem Bash, web ou MCP
const HTML_PATH = path.join(__dirname, 'office.html');   // lido a cada GET /: editou o HTML, é só recarregar a página

const clients = new Set();
let current = 'idle', idleTimer = null;

function send(event, data) {
  if (event === 'chat') remember(data);
  const msg = (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// Histórico do chat: se a página perder a conexão no meio da resposta (aba em segundo plano, Mac dormiu,
// recarregou), ao reconectar ela recebe tudo de novo em vez de ficar com o chat vazio.
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

// Mapa evento do Claude Code → modo do personagem
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

/* ---------- limite de uso: POST /usage (status line do Claude Code) → barra de energia ---------- */
let usage = null;   // { used: 0–100, resetsAt: epoch em segundos }

function setUsage(used, resetsAt) {
  if (typeof used !== 'number' || !isFinite(used)) return;
  used = Math.max(0, Math.min(100, used));
  if (usage && usage.used === used && usage.resetsAt === resetsAt) return;
  usage = { used, resetsAt: resetsAt || null };
  send('usage', usage);
}

// Aceita o JSON que o Claude Code manda pra status line (rate_limits.five_hour) ou { used, resetsAt } manual.
function usageFrom(body) {
  const d = JSON.parse(body || '{}');
  const five = d.rate_limits && d.rate_limits.five_hour;
  if (five) return setUsage(five.used_percentage, five.resets_at);
  if (d.used != null) setUsage(Number(d.used), d.resetsAt);
}

// Mesmos números do /usage, lidos direto da conta. O /usage não roda no `claude -p`, então o servidor
// pergunta pra API da Anthropic com o login que o Claude Code já guardou (Keychain no macOS, ~/.claude no Linux).
// É um endpoint não documentado: se parar de responder, a barra continua vindo só da status line.
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
    if (!token) throw new Error('login do Claude Code não encontrado (rode `claude` e faça login)');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const five = (await r.json()).five_hour;
    if (!five || five.utilization == null) throw new Error('resposta sem five_hour');
    setUsage(Number(five.utilization), five.resets_at ? Math.round(Date.parse(five.resets_at) / 1000) || null : null);
    console.log(new Date().toLocaleTimeString(), `limite: ${Math.round(usage.used)}% usado (${why})`);
  } catch (e) {
    console.log(new Date().toLocaleTimeString(), `não consegui ler o limite de uso: ${e.message} (${why})`);
  } finally {
    usageBusy = false;
  }
}

/* ---------- skills: pastas com SKILL.md do projeto (.claude/skills); as globais (~/.claude/skills) ficam de fora ---------- */
// Lidas a cada conexão da página: criou uma skill, é só recarregar.
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
      if (field('user-invocable') === 'false' || seen.has(name) || !/^[\w.:-]+$/.test(name)) continue;   // só as que dá pra chamar com /nome
      seen.set(name, { name, description: field('description') });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- chat: POST /prompt → claude -p ---------- */
let chatProc = null, sessionId = null;
let permMode = 'acceptEdits';   // 'plan' = /plan (só lê e planeja); 'acceptEdits' = normal (lê e edita)

function runPrompt(text) {
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', CHAT_TOOLS, '--allowedTools', CHAT_TOOLS, '--strict-mcp-config', '--permission-mode', permMode];
  if (sessionId) args.push('--resume', sessionId);   // continua a conversa do chat, não a do seu terminal
  const proc = chatProc = spawn('claude', args, { cwd: CLAUDE_CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  send('chat', { type: 'start', text });
  const pm = permMode, thinkMode = pm === 'plan' ? 'planning' : 'thinking';
  applyMode(thinkMode, 'chat');

  let buf = '', errBuf = '', gotResult = false, gotText = false;
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');   // não quebra acentos entre pedaços
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
          if (b.type === 'tool_use') send('chat', { type: 'tool', name: b.name, target: b.input.file_path || b.input.pattern || '' });
      } else if (m.type === 'user') {
        applyMode(thinkMode, 'chat');   // resultado da ferramenta voltou; o Claude está pensando de novo
      } else if (m.type === 'system' && m.subtype === 'status') {
        if (m.status === 'compacting') send('chat', { type: 'activity', text: 'resumindo a conversa…' });
        if (m.compact_result === 'success') send('chat', { type: 'note', text: 'Conversa resumida.' });
      } else if (m.type === 'result') {
        gotResult = true;
        // comandos como /context respondem só no resultado, sem texto em streaming
        if (!gotText && !m.is_error) send('chat', { type: 'note', text: m.result || 'O Claude terminou sem escrever resposta.' });
        send('chat', { type: 'result', ok: !m.is_error, error: m.is_error ? (m.result || m.subtype) : null });
      }
    }
  });
  proc.stderr.on('data', c => { errBuf += c; });
  proc.on('error', err => { errBuf += err.message; });
  proc.on('close', (code, signal) => {
    if (chatProc === proc) chatProc = null;
    if (!gotResult) send('chat', { type: 'result', ok: false, error: signal ? 'interrompido' : (errBuf.trim() || `claude saiu com código ${code}`) });
    applyMode(gotResult && !signal ? 'done' : 'idle', 'chat');
    send('chat', { type: 'idle' });
    refreshUsage('fim do chat');   // terminou de executar/planejar: atualiza a barra
  });
}

// Só aceita comandos vindos da própria página: bloqueia sites de fora (CSRF) e DNS rebinding.
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
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/#'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(HTML_PATH));
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ mode: current })}\n\n`);
    res.write(`event: chat\ndata: ${JSON.stringify({ type: 'hello', busy: !!chatProc, cwd: CLAUDE_CWD, permMode, hasSession: !!sessionId, skills: listSkills() })}\n\n`);
    for (const d of history) res.write(`event: chat\ndata: ${JSON.stringify({ ...d, replay: true })}\n\n`);
    if (usage) res.write(`event: usage\ndata: ${JSON.stringify(usage)}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000); req.on('close', () => clearInterval(ping));
    return;
  }
  if (req.method === 'POST' && ['/prompt', '/command'].includes(req.url)) {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origem não permitida' });
    return readBody(req, body => {
      let data = {}; try { data = JSON.parse(body) || {}; } catch (_) {}
      if (req.url === '/command') {
        // botões do painel "Comandos": equivalem a digitar /plan, /clear… no Claude Code
        const name = String(data.name || '');
        if (name === 'stop') { if (chatProc) chatProc.kill('SIGTERM'); return json(res, 200, {}); }
        if (name === 'plan' || name === 'normal') {
          permMode = name === 'plan' ? 'plan' : 'acceptEdits';
          send('chat', { type: 'perm', permMode });
          return json(res, 200, {});
        }
        if (chatProc) return json(res, 409, { error: 'espere o Claude terminar' });
        if (name === 'skill') {   // painel "Skills": roda /nome-da-skill
          const skill = String(data.skill || '');
          if (!listSkills().some(s => s.name === skill)) return json(res, 404, { error: 'skill não encontrada' });
          runPrompt('/' + skill); return json(res, 200, {});
        }
        if (name === 'clear') { sessionId = null; send('chat', { type: 'reset' }); return json(res, 200, {}); }
        if (['compact', 'init', 'context'].includes(name)) {
          if (name !== 'init' && !sessionId) return json(res, 409, { error: 'ainda não tem conversa' });
          runPrompt('/' + name); return json(res, 200, {});
        }
        return json(res, 400, { error: 'comando desconhecido' });
      }
      const text = String(data.text || '').trim();
      if (!text) return json(res, 400, { error: 'mensagem vazia' });
      if (chatProc) return json(res, 409, { error: 'o Claude ainda está trabalhando' });
      runPrompt(text);
      json(res, 200, {});
    });
  }
  if (req.method === 'POST' && req.url === '/usage') {
    return readBody(req, body => {
      try { usageFrom(body); } catch (_) {}
      // a resposta vira o texto da status line no terminal
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(usage ? `⚡ ${Math.round(100 - usage.used)}% de energia` : '');
    });
  }
  if (req.method === 'POST' && (req.url === '/hook' || req.url.startsWith('/mode/'))) {
    return readBody(req, body => {
      let mode = null, why = '';
      if (req.url.startsWith('/mode/')) mode = req.url.slice(6);                 // POST /mode/coding (manual)
      else { try {
        const ev = JSON.parse(body || '{}'); mode = modeFor(ev); why = ev.hook_event_name + (ev.tool_name ? ':' + ev.tool_name : '');
        if (ev.hook_event_name === 'Stop') refreshUsage('Stop no terminal');   // terminou uma tarefa no Claude Code do terminal
      } catch (_) {} }
      applyMode(mode, why);
      json(res, 200, {});
    });
  }
  res.writeHead(404); res.end();
}).listen(PORT, HOST, () => {
  console.log(`Escritório 3D em http://localhost:${PORT}  (esperando hooks do Claude Code; chat trabalha em ${CLAUDE_CWD})`);
  refreshUsage('servidor iniciou');
});
