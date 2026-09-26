# Claude Code UI — 3D Office

A 3D office in the browser where a character acts out what Claude Code is doing, with a chat, command buttons and a usage-limit bar.
1. `npm start` (or `npm run dev`, which restarts on its own when you edit `server.js`; changes to `office.html` only need a page reload) and open http://localhost:4545 (`npm run open`)
2. Copy the `hooks` block from `hooks.json` into `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project). If you already have a `hooks` block, merge the events.
3. Open Claude Code and give it a task. The character starts reacting to the events.

Requires Node.js 20+.

Event → mode map (edit `modeFor()` in `server.js`):

| Claude Code event                              | Mode                      |
|------------------------------------------------|---------------------------|
| `UserPromptSubmit` in plan mode                | Planning                  |
| `UserPromptSubmit` (normal)                    | Thinking                  |
| `PreToolUse` with Edit / Write / Bash          | Coding                    |
| `PreToolUse` with Read / Grep / Glob / Web*    | Reviewing                 |
| `PreToolUse` with any tool in plan mode        | Planning                  |
| `Notification` (permission, idle, question)    | Waiting for you           |
| `Stop`                                         | Done → Idle after 8 s     |
| `SessionStart` / `SessionEnd`                  | Idle                      |

Test without Claude Code: `curl -X POST localhost:4545/mode/coding`

## Energy bar (usage limit)

Next to the mode card, the bar shows how much of the 5-hour usage limit is **left** (100% = full, it drains as you use it; green → yellow → red, blinks below 10%).

- The server fetches the same numbers as `/usage` straight from your account, using the login Claude Code stored (Keychain on macOS, `~/.claude/.credentials.json` on Linux). This happens when the server starts, when a chat message or command finishes, and when a `Stop` hook arrives from the terminal. The result shows up in the server log. This endpoint (`/api/oauth/usage`) is undocumented. If it stops working, the bar keeps getting data from the status line (below).
- Data also comes from the Claude Code status line: also copy `statusLine` from `hooks.json` into `settings.json`. Claude Code sends the session JSON (with `rate_limits.five_hour`) to `POST /usage`, and the response becomes the status line text (`⚡ 58% energy`). This replaces any status line you already have.
- `rate_limits` only appears for Claude.ai subscribers (Pro/Max) and after the session's first response; until then the bar shows "no limit data".
- Test: `curl -X POST -H 'Content-Type: application/json' -d '{"used":42}' localhost:4545/usage` or `setUsage(42)` in the browser console.

## Chat on the page

With the server running, the **Talk to Claude** panel sends your message to `POST /prompt`, and the server runs `claude -p` in the folder where you started `node server.js` (or in `CLAUDE_CWD=/other/folder node server.js`). The reply shows up on the page and the character moves according to the tools being used.

- Tools, MCP servers and approval mode come from **Settings** (see below).
- The conversation carries over between messages (`--resume`). **New chat** starts from scratch; **Stop** interrupts. Voice dictation uses your browser's language.
- Click the **Talk to Claude** title to see the 10 most recent conversations in that folder (from the page or your terminal, read from `~/.claude/projects/`). Pick one to load it into the chat; your next message continues it.
- The server only listens on `127.0.0.1` and rejects requests from other sites.

## Settings and chat permissions

The first time you open the page, a **Settings** screen opens over the game (dark background, scene paused, like a game's pause menu) at http://localhost:4545/settings. Pick what the chat's Claude may do and press **Save**; the chat stays locked until you do.

| Option | What it turns on |
|---|---|
| Read files | Always on: `Read`, `Grep`, `Glob` |
| Edit files | `Edit`, `Write` |
| Run commands | `Bash` (runs shell commands on this computer) |
| Web access | `WebFetch`, `WebSearch` |
| Use MCP servers | The servers in the MCP panel (otherwise `--strict-mcp-config`) |

Approval mode:
- **Auto, like the terminal** (`--permission-mode auto`): Claude Code's auto mode reviews each action, using the `autoMode` and permission rules in your `~/.claude/settings.json`.
- **Allow everything checked** (`acceptEdits` plus `--allowedTools`): every checked tool runs without review.

The page can't show approval prompts, so anything that would need one is denied.

Character: the top of the screen lets you pick who works in the room. Clicking one previews it behind the menu; **Save** keeps it.

| Character | Look |
|---|---|
| Gamer | Tired, long messy hair, RGB headset |
| Crypto Boy | Backwards cap, shades, gold chain with a ₿ coin; laser eyes while coding and when done |
| Mei | Black hair with bangs and two buns, red mandarin-collar jacket with gold trim |

To add one, add an entry to `CHARACTERS` in `office.html` (colors for the shared body plus a `build()` for the face, hair and accessories); it shows up in Settings automatically, with a portrait rendered from its `build()`. Changes to `server.js` need a server restart; `office.html` only needs a page reload.

Your choices (permissions and character) are saved to `chat-permissions.json` next to `server.js` (per machine, git-ignored). To change them, open **⚙ Settings** (or press **P**, or go to `/settings`), change the options and **Save**. The file is written again and the next message uses the new permissions, with no restart needed. **Back**, **Esc**, **P** or the browser's back button close the screen without saving. Delete the file to see the onboarding again.

## Commands (right panel)

The buttons match Claude Code commands, and you can also type them in the chat:

| Button | Command | What it does |
|---|---|---|
| Plan | `/plan` | Next messages run with `--permission-mode plan`: read-only, builds a plan |
| Execute | `⇧Tab` | Back to normal: uses the permissions from Settings |
| Compact | `/compact` | Compacts the conversation |
| Context | `/context` | Shows how much of the context window is used |
| Create CLAUDE.md | `/init` | Documents the project |
| New chat | `/clear` | Starts from scratch |

`Esc` in the chat interrupts. What Claude is doing appears in the character's speech bubble.

The side panels (Commands, Skills, and any added later) are collapsible and start closed: click a panel's title to open or close it. The browser remembers which ones you left open.

## Skills panel

One button per skill in the project's `.claude/skills/` folder (the folder the chat works in); clicking it runs `/skill-name` in the chat. Global skills from `~/.claude/skills` are not listed. Skills are read on each page load, so after creating one, just reload.
