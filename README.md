# Escritório 3D ↔ Claude Code

1. `npm start` (ou `npm run dev`, que reinicia sozinho quando você edita `server.js`; mudanças no `office.html` aparecem só recarregando a página) e abra http://localhost:4545 (`npm run open`)
2. Copie o bloco `hooks` de `hooks.json` para `~/.claude/settings.json` (todos os projetos) ou `.claude/settings.json` (um projeto). Se já tiver um bloco `hooks`, mescle os eventos.
3. Abra o Claude Code e mande uma tarefa. O personagem passa a reagir aos eventos.

Mapa de eventos → modos (edite `modeFor()` em `server.js`):

| Evento do Claude Code                          | Modo        |
|------------------------------------------------|-------------|
| `UserPromptSubmit` em plan mode                | Planejando  |
| `UserPromptSubmit` (normal)                    | Pensando    |
| `PreToolUse` com Edit / Write / Bash           | Construindo |
| `PreToolUse` com Read / Grep / Glob / Web*     | Revisando   |
| `PreToolUse` com qualquer tool em plan mode    | Planejando  |
| `Notification` (permissão, idle, pergunta)     | Esperando   |
| `Stop`                                         | Concluído → Ocioso (8 s) |
| `SessionStart` / `SessionEnd`                  | Ocioso      |

Teste sem o Claude Code: `curl -X POST localhost:4545/mode/coding`

## Barra de energia (limite de uso)

Ao lado do card do modo, a barra mostra quanto **sobra** do limite de uso de 5 h (100% = cheia, esvazia conforme você usa; verde → amarelo → vermelho, pisca abaixo de 10%).

- O servidor busca os mesmos números do `/usage` direto na sua conta, usando o login que o Claude Code guardou (Keychain no macOS, `~/.claude/.credentials.json` no Linux). Isso acontece quando o servidor inicia, quando uma mensagem ou comando do chat termina e quando chega um hook `Stop` do terminal. O resultado aparece no log do servidor. Esse endpoint (`/api/oauth/usage`) não é documentado. Se parar de funcionar, a barra continua vindo da status line (abaixo).
- Os dados também vêm da status line do Claude Code: copie também o `statusLine` de `hooks.json` para o `settings.json`. O Claude Code manda o JSON da sessão (com `rate_limits.five_hour`) para `POST /usage`, e a resposta vira o texto da status line (`⚡ 58% de energia`). Isso substitui uma status line que você já tenha.
- O `rate_limits` só aparece para assinantes Claude.ai (Pro/Max) e depois da primeira resposta da sessão; antes disso a barra fica em "sem dados".
- Teste: `curl -X POST -H 'Content-Type: application/json' -d '{"used":42}' localhost:4545/usage` ou `setUsage(42)` no console.

## Chat na página

Com o servidor rodando, o painel **Falar com o Claude** manda a mensagem para `POST /prompt`, e o servidor roda `claude -p` na pasta onde você iniciou o `node server.js` (ou em `CLAUDE_CWD=/outra/pasta node server.js`). A resposta aparece na página e o personagem se mexe conforme as ferramentas usadas.

- Ferramentas liberadas: só `Read`, `Grep`, `Glob`, `Edit` e `Write` (sem Bash, web ou MCP). Edite `CHAT_TOOLS` em `server.js`.
- A conversa continua entre mensagens (`--resume`). **Nova conversa** começa do zero; **Parar** interrompe.
- O servidor só escuta em `127.0.0.1` e recusa pedidos de outros sites.

## Comandos (painel da direita)

Os botões equivalem aos comandos do Claude Code, e também dá pra digitar no chat:

| Botão | Comando | O que faz |
|---|---|---|
| Planejar | `/plan` | Próximas mensagens rodam em `--permission-mode plan`: só lê e monta um plano |
| Executar | `⇧Tab` | Volta ao normal (`acceptEdits`): lê e edita arquivos |
| Resumir | `/compact` | Compacta a conversa |
| Contexto | `/context` | Mostra quanto da memória já foi usado |
| Criar CLAUDE.md | `/init` | Documenta o projeto |
| Nova conversa | `/clear` | Começa do zero |

`Esc` no chat interrompe. O que o Claude está fazendo aparece no balão do personagem.
