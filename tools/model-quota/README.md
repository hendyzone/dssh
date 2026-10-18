# model-quota

A single-file, standard-library-only Python script that reports how much quota is left on each
AI coding channel **on the machine it runs on**. dssh embeds it for the Model quota panel
(「模型额度」) and streams it to the server over SSH stdin, so the server only needs `python3`
(3.8 or later).

```bash
python3 model-quota.py                       # human readable, one channel per line
python3 model-quota.py --json                # JSON: {"meta": {...}, "channels": {name: {...}}}
python3 model-quota.py --only claude,codex   # query some channels only
python3 model-quota.py --timeout 15          # per-request timeout in seconds (default 15)
python3 model-quota.py --proxy URL           # HTTP(S) proxy, overrides everything else
python3 model-quota.py --config PATH         # use another config file
ssh host python3 - --json < model-quota.py   # run on another machine; credentials stay there
```

## Channels and the local files they read

Quota follows the account, so the script reads the credentials each tool already stored when you
logged in. It only reads them inside its own process; nothing is passed on a command line or printed.

| Channel | Endpoint | Credentials read | Official? |
|---|---|---|---|
| `tokenline` | your [new-api](https://github.com/QuantumNous/new-api) relay: `/api/usage/token`, optional `/api/user/self` | key `tokenline.key` in `~/.pi/agent/auth.json`; optional `~/.config/tokenline/access_token` + `user_id` | new-api API |
| `kimi` | `api.kimi.com/coding/v1/usages` | `kimi-coding.key` in `~/.pi/agent/auth.json` | unofficial |
| `deepseek` | `api.deepseek.com/user/balance` | `deepseek.key` in `~/.pi/agent/auth.json` | official |
| `claude` | `api.anthropic.com/api/oauth/usage` | `~/.claude/.credentials.json` (Claude Code login) | unofficial |
| `codex` | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` (Codex CLI login); falls back to `~/.codex/sessions` logs | unofficial |
| `pi-codex` | same as `codex` | `openai-codex` in `~/.pi/agent/auth.json` | unofficial |
| `cursor` | `cursor.com/api/usage-summary` | `~/.config/cursor/auth.json` (cursor-agent login) | unofficial |
| `agy` | runs `agy -p /usage` (Antigravity CLI, no model call) | agy's own login | CLI output |

Unofficial endpoints were taken from the vendors' own clients and can change or disappear at any
time: when one channel suddenly fails, suspect the endpoint before the account.

`agy` reports **remaining** percent (`left_pct`); every other channel reports **used** percent.
Machines logged in to the same account share one quota.

## Rules

- **Read only.** Tokens are never refreshed: an OAuth refresh rotates the refresh token, which would
  log out the tool that is using it. An expired token is reported as such; start that tool once and
  it refreshes itself.
- **Credentials are never echoed.** Token-shaped strings that an endpoint echoes back in an error
  message are masked; the agy account is shown with its middle masked.
- **No guessing.** The proxy is never auto-detected and no relay address is built in.

## Configuration

Optional file `~/.config/model-quota/config` (or `$XDG_CONFIG_HOME/model-quota/config`), one
`key = value` per line, `#` starts a comment, unknown keys are ignored:

```ini
# Non-interactive ssh does not load the proxy from your shell profile; put it here.
proxy = http://127.0.0.1:7890
# The tokenline channel is skipped (reported "not_configured") until this is set.
tokenline_base = https://relay.example.com
timeout = 15
```

Proxy precedence: `--proxy` > `HTTPS_PROXY`/`https_proxy` > config `proxy` > legacy `~/.amail/proxy`.

## Output

`--json` prints `{"meta": {host, proxy, at, tool, version, tokenline_base}, "channels": {...}}`.
Every channel has `ok`. Failed channels carry a human `error` and a machine-readable `code`:

| `code` | Meaning |
|---|---|
| `no_credentials` | the tool is not logged in on this machine |
| `missing_field` | the credential file lacks the expected entry |
| `not_configured` | `tokenline_base` is not set |
| `token_expired` | access token expired; start the tool once to refresh it |
| `not_installed` | `agy` is not installed |
| `timeout` / `network` | endpoint not reachable (often: no proxy) |
| `http_<status>` | the endpoint answered with an HTTP error |
| `error` | anything else |

## Tests

```bash
python3 -m unittest discover -s tools/model-quota
```
