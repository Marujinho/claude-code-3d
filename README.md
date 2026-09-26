# Claude Code UI — 3D Office

A 3D office in the browser where a character acts out what Claude Code is doing, with a chat, command buttons and a usage-limit bar. The interface is in Portuguese; labels below are quoted as they appear on screen.

1. `npm start` (or `npm run dev`, which restarts on its own when you edit `server.js`; changes to `office.html` only need a page reload) and open http://localhost:4545 (`npm run open`)
2. Copy the `hooks` block from `hooks.json` into `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project). If you already have a `hooks` block, merge the events.
3. Open Claude Code and give it a task. The character starts reacting to the events.

Requires Node.js 20+.

Event → mode map (edit `modeFor()` in `server.js`):

| Claude Code event                              | Mode                      |
|------------------------------------------------|---------------------------|
| `UserPromptSubmit` in plan mode                | Planejando (planning)     |
| `UserPromptSubmit` (normal)                    | Pensando (thinking)       |
| `PreToolUse` with Edit / Write / Bash          | Construindo (building)    |
| `PreToolUse` with Read / Grep / Glob / Web*    | Revisando (reviewing)     |
| `PreToolUse` with any tool in plan mode        | Planejando (planning)     |
| `Notification` (permission, idle, question)    | Esperando (waiting)       |
| `Stop`                                         | Concluído (done) → Ocioso (idle) after 8 s |
| `SessionStart` / `SessionEnd`                  | Ocioso (idle)             |

Test without Claude Code: `curl -X POST localhost:4545/mode/coding`

## Energy bar (usage limit)

Next to the mode card, the bar shows how much of the 5-hour usage limit is **left** (100% = full, it drains as you use it; green → yellow → red, blinks below 10%).

- The server fetches the same numbers as `/usage` straight from your account, using the login Claude Code stored (Keychain on macOS, `~/.claude/.credentials.json` on Linux). This happens when the server starts, when a chat message or command finishes, and when a `Stop` hook arrives from the terminal. The result shows up in the server log. This endpoint (`/api/oauth/usage`) is undocumented. If it stops working, the bar keeps getting data from the status line (below).
- Data also comes from the Claude Code status line: also copy `statusLine` from `hooks.json` into `settings.json`. Claude Code sends the session JSON (with `rate_limits.five_hour`) to `POST /usage`, and the response becomes the status line text (`⚡ 58% de energia`). This replaces any status line you already have.
- `rate_limits` only appears for Claude.ai subscribers (Pro/Max) and after the session's first response; until then the bar shows "sem dados" (no data).
- Test: `curl -X POST -H 'Content-Type: application/json' -d '{"used":42}' localhost:4545/usage` or `setUsage(42)` in the browser console.

## Chat on the page

With the server running, the **Falar com o Claude** (talk to Claude) panel sends your message to `POST /prompt`, and the server runs `claude -p` in the folder where you started `node server.js` (or in `CLAUDE_CWD=/other/folder node server.js`). The reply shows up on the page and the character moves according to the tools being used.

- Allowed tools: only `Read`, `Grep`, `Glob`, `Edit` and `Write` (no Bash, web or MCP). Edit `CHAT_TOOLS` in `server.js`.
- The conversation carries over between messages (`--resume`). **Nova conversa** (new conversation) starts from scratch; **Parar** (stop) interrupts.
- The server only listens on `127.0.0.1` and rejects requests from other sites.

## Commands (right panel)

The buttons match Claude Code commands, and you can also type them in the chat:

| Button | Command | What it does |
|---|---|---|
| Planejar (plan) | `/plan` | Next messages run with `--permission-mode plan`: read-only, builds a plan |
| Executar (execute) | `⇧Tab` | Back to normal (`acceptEdits`): reads and edits files |
| Resumir (summarize) | `/compact` | Compacts the conversation |
| Contexto (context) | `/context` | Shows how much of the context window is used |
| Criar CLAUDE.md (create CLAUDE.md) | `/init` | Documents the project |
| Nova conversa (new conversation) | `/clear` | Starts from scratch |

`Esc` in the chat interrupts. What Claude is doing appears in the character's speech bubble.

## Skills panel

One button per skill in the project's `.claude/skills/` folder (the folder the chat works in); clicking it runs `/skill-name` in the chat. Global skills from `~/.claude/skills` are not listed. Skills are read on each page load, so after creating one, just reload.
