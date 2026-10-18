#!/usr/bin/env python3
# model-quota: read-only report of the remaining quota of each AI coding channel on this machine.
#
#   python3 model-quota.py                         # human readable, one channel per line
#   python3 model-quota.py --json                  # JSON: {"meta": {...}, "channels": {name: {...}}}
#   python3 model-quota.py --only claude,codex     # query some channels only
#   python3 model-quota.py --timeout 15            # per-request timeout in seconds (default 15)
#   python3 model-quota.py --proxy URL             # HTTP(S) proxy, overrides everything else
#   python3 model-quota.py --config PATH           # config file (default below)
#   ssh host python3 - --json < model-quota.py     # run on another machine; credentials stay there
#
# Standard library only, Python >= 3.8. Quota follows the account credentials, so it has to run on
# the machine that holds them. Credentials are read inside this process only: never passed on a
# command line, never printed; token-shaped strings in error messages are masked.
#
# Channels (credential files are the ones each tool writes when you log in):
#   tokenline  a new-api relay. Key from ~/.pi/agent/auth.json ("tokenline".key) -> /api/usage/token.
#              Optional account balance with a user access token in ~/.config/tokenline/access_token
#              (chmod 600) and user id in ~/.config/tokenline/user_id. The relay address is NOT built
#              in: set tokenline_base in the config file, otherwise the channel is reported unconfigured.
#   kimi       api.kimi.com/coding/v1/usages, key from ~/.pi/agent/auth.json      (unofficial endpoint)
#   deepseek   api.deepseek.com/user/balance, key from ~/.pi/agent/auth.json      (official endpoint)
#   claude     api.anthropic.com/api/oauth/usage, ~/.claude/.credentials.json     (unofficial endpoint)
#   codex      chatgpt.com/backend-api/wham/usage, ~/.codex/auth.json             (unofficial endpoint);
#              falls back to the last rate_limits in local session logs (STALE when past reset)
#   cursor     cursor.com/api/usage-summary, ~/.config/cursor/auth.json           (unofficial endpoint)
#   agy        Antigravity CLI: runs `agy -p /usage` (no model call). Reports REMAINING percent
#              (left_pct); every other channel reports USED percent. Machines with the same
#              account share one quota.
# Unofficial endpoints may change shape or disappear; a channel that suddenly FAILs most likely
# means the endpoint changed, not the account.
#
# Rules: read only. Tokens are never refreshed (an OAuth refresh rotates the refresh token, a write
# that would log out the agent using it); an expired token is reported, the tool refreshes it the
# next time it starts.
#
# Config file: $XDG_CONFIG_HOME/model-quota/config (default ~/.config/model-quota/config), optional.
# One `key = value` per line, `#` starts a comment, unknown keys are ignored:
#   proxy = http://127.0.0.1:7890        # non-interactive ssh does not load your shell's proxy
#   tokenline_base = https://relay.example.com
#   timeout = 15
# Proxy precedence: --proxy > HTTPS_PROXY/https_proxy > config `proxy` > legacy ~/.amail/proxy.
# The proxy is never auto-detected: a wrong guess would disguise "no proxy" as some other error.
import base64, concurrent.futures as cf, glob, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

VERSION = "1.0"
H = os.path.expanduser
TIMEOUT = 15.0
PROXY = None
CONFIG = {}
TL_BASE = None
TL_DIR = "~/.config/tokenline"
LEGACY_PROXY = "~/.amail/proxy"
CH_STATUS = {1: "on", 2: "off", 3: "auto-off"}


class QuotaError(RuntimeError):
    """A failure with a machine-readable code (new `code` field next to `error`)."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def config_path():
    base = os.environ.get("XDG_CONFIG_HOME") or H("~/.config")
    return os.path.join(base, "model-quota", "config")


def read_config(path):
    """Parse `key = value` lines; a missing or unreadable file is an empty config."""
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return out
    for line in lines:
        line = line.strip()
        if line.startswith("#"):
            continue
        line = re.split(r"\s#", line, maxsplit=1)[0]  # trailing " # comment"
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().lower(), value.strip().strip("'\"")
        if key and value:
            out[key] = value
    return out


def parse_args(argv):
    """Lenient parsing: unknown arguments are ignored, as the original script did."""
    opts = {"json": False, "only": None, "timeout": None, "proxy": None, "config": None, "tokenline_base": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        nxt = argv[i + 1] if i + 1 < len(argv) else None
        if a == "--json":
            opts["json"] = True
        elif a == "--version":
            opts["version"] = True
        elif a in ("--only", "--timeout", "--proxy", "--config", "--tokenline-base") and nxt is not None:
            key = a[2:].replace("-", "_")
            opts[key] = set(x for x in nxt.split(",") if x) if key == "only" else nxt
            i += 1
        i += 1
    return opts


def resolve_proxy(cli, config, environ):
    """Return (proxy url or None, source)."""
    if cli:
        return cli, "arg"
    env = environ.get("HTTPS_PROXY") or environ.get("https_proxy")
    if env:
        return env, "env"
    if config.get("proxy"):
        return config["proxy"], "config"
    try:
        with open(H(LEGACY_PROXY)) as f:
            legacy = f.read().strip()
    except OSError:
        legacy = ""
    if legacy:
        return legacy, "legacy"
    return None, "none"


def setup(argv, environ=os.environ):
    """Apply arguments and config to the module globals. Returns the parsed options."""
    global TIMEOUT, PROXY, CONFIG, TL_BASE
    opts = parse_args(argv)
    CONFIG = read_config(opts["config"] or config_path())
    try:
        TIMEOUT = float(opts["timeout"] or CONFIG.get("timeout") or 15)
    except ValueError:
        TIMEOUT = 15.0
    PROXY, source = resolve_proxy(opts["proxy"], CONFIG, environ)
    if PROXY and source != "env":
        for v in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
            environ[v] = PROXY
    base = (opts["tokenline_base"] or CONFIG.get("tokenline_base") or "").strip().rstrip("/")
    TL_BASE = base if re.match(r"^https?://[^\s/]+", base) else None
    opts["proxy_source"] = source
    return opts


def jload(p):
    with open(H(p)) as f:
        return json.load(f)


def http(url, headers, timeout=None):
    h = {"User-Agent": "quota-probe/1", "Accept": "application/json"}
    h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout or TIMEOUT) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = " ".join(e.read()[:300].decode("utf-8", "replace").split())
        raise QuotaError("http_%d" % e.code, f"HTTP {e.code}: {body}") from None


def ts(v):
    """Any time representation -> local "MM-DD HH:MM"."""
    if v in (None, "", 0):
        return None
    if isinstance(v, (int, float)):
        d = datetime.fromtimestamp(v / 1000 if v > 1e12 else v, timezone.utc)
    else:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return d.astimezone().strftime("%m-%d %H:%M")


def _pct(used, limit):
    try:
        return round(100 * float(used) / float(limit), 1)
    except Exception:
        return None


def scrub(s):
    # Last line of defence: mask token-shaped strings echoed back in error messages.
    return re.sub(r"(sk-|eyJ|Bearer\s+)[A-Za-z0-9._\-]{8,}", r"\1***", s)


# ---------------------------------------------------------------- channels
def _tl_user_id(key):
    """The New-Api-User header wants the user id: config file first, else derive it from the key's logs."""
    try:
        with open(H(TL_DIR + "/user_id")) as f:
            return f.read().strip(), "file"
    except FileNotFoundError:
        pass
    _, lg = http(TL_BASE + "/api/log/token", {"Authorization": "Bearer " + key})
    ids = {x.get("user_id") for x in (lg.get("data") or []) if x.get("user_id")}
    if len(ids) != 1:
        raise RuntimeError(f"推不出用户 id（日志里 {len(ids)} 个），写进 {TL_DIR}/user_id")
    return str(ids.pop()), "log"


def _tl_account(key, qpu):
    try:
        with open(H(TL_DIR + "/access_token")) as f:
            tok = f.read().strip()
    except FileNotFoundError:
        return {"note": f"账户余额未配置：在 new-api 个人设置生成访问令牌，存 {TL_DIR}/access_token（chmod 600）"}
    uid, src = _tl_user_id(key)
    last = None
    for auth in (tok, "Bearer " + tok):  # new-api access tokens usually go without "Bearer"; accept both
        try:
            _, u = http(TL_BASE + "/api/user/self", {"Authorization": auth, "New-Api-User": uid})
            break
        except RuntimeError as e:
            last = e
    else:
        raise last
    d = u["data"]
    hdr = {"Authorization": auth, "New-Api-User": uid}
    out = {"balance_usd": round(d["quota"] / qpu, 2), "used_usd": round(d["used_quota"] / qpu, 2),
           "requests": d.get("request_count"), "group": d.get("group")}
    if src == "log":
        out["uid_hint"] = f"用户 id 由日志推得，写进 {TL_DIR}/user_id 可省一次请求"
    if (d.get("role") or 0) >= 10:  # admins only; read-only list, never triggers a balance refresh
        _, c = http(TL_BASE + "/api/channel/?p=1&page_size=100", hdr)
        pool = []
        for ch in (c.get("data") or {}).get("items") or []:
            ci = ch.get("channel_info") or {}
            nk = ci.get("multi_key_size") if ci.get("is_multi_key") else 1
            pool.append(f"{ch.get('name')}:{CH_STATUS.get(ch.get('status'), ch.get('status'))}"
                        f"/{nk}key/{round((ch.get('response_time') or 0) / 1000, 1)}s")
        out["upstream"] = ",".join(pool) or "（无渠道）"
    else:
        out["note"] = "上游渠道/账号池需管理员访问令牌，本令牌无权限"
    return out


def ch_tokenline():
    # pi's key precedence: auth.json (stored credential) > models.json apiKey
    key = jload("~/.pi/agent/auth.json")["tokenline"]["key"]
    if not TL_BASE:
        raise QuotaError("not_configured", f"未配置 tokenline_base（在 {config_path()} 写 tokenline_base = <new-api 地址>）")
    _, st = http(TL_BASE + "/api/status", {})
    qpu = st["data"].get("quota_per_unit") or 500000
    _, t = http(TL_BASE + "/api/usage/token", {"Authorization": "Bearer " + key})
    d = t["data"]
    out = {"plan": "按量(new-api)"}
    try:
        out.update(_tl_account(key, qpu))
    except Exception as e:
        out["account_error"] = scrub(str(e))[:160]
    out.update({"key_name": d.get("name"), "key_used_usd": round(d["total_used"] / qpu, 2),
                "key_expires": ts(d.get("expires_at")) or "永不"})
    if not d.get("unlimited_quota"):
        out["key_remaining_usd"] = round(d["total_available"] / qpu, 2)
    return out


def ch_kimi():
    key = jload("~/.pi/agent/auth.json")["kimi-coding"]["key"]
    _, d = http("https://api.kimi.com/coding/v1/usages", {"Authorization": "Bearer " + key})
    u = d.get("usage", {})
    out = {"plan": "Kimi Code 订阅", "week_used_pct": _pct(u.get("used"), u.get("limit")),
           "week_reset": ts(u.get("resetTime"))}
    for l in d.get("limits", []):
        w = l.get("window", {})
        det = l.get("detail", {})
        tag = f"{w.get('duration')}{'m' if 'MINUTE' in w.get('timeUnit', '') else w.get('timeUnit', '')}"
        out[f"win_{tag}_used_pct"] = _pct(det.get("used"), det.get("limit"))
        out[f"win_{tag}_reset"] = ts(det.get("resetTime"))
    bw = d.get("booster_wallet") or {}
    if bw.get("monthlyUsed"):
        out["booster_month_used_cny"] = int(bw["monthlyUsed"].get("priceInCents", 0)) / 100
    return out


def ch_deepseek():
    key = jload("~/.pi/agent/auth.json")["deepseek"]["key"]
    _, d = http("https://api.deepseek.com/user/balance", {"Authorization": "Bearer " + key})
    b = (d.get("balance_infos") or [{}])[0]
    return {"plan": "按量预付", "available": d.get("is_available"),
            "balance": f"{b.get('total_balance')} {b.get('currency')}",
            "granted": b.get("granted_balance"), "topped_up": b.get("topped_up_balance")}


def ch_claude():
    c = jload("~/.claude/.credentials.json")["claudeAiOauth"]
    if c.get("expiresAt", 0) / 1000 < time.time():
        # never refresh on its behalf: refreshing rotates the refresh token, a write
        raise QuotaError("token_expired", "access token 已过期，跑一次 claude 让它自己刷新")
    _, d = http("https://api.anthropic.com/api/oauth/usage",
                {"Authorization": "Bearer " + c["accessToken"], "anthropic-beta": "oauth-2025-04-20"})
    out = {"plan": f"{c.get('subscriptionType')} / {c.get('rateLimitTier')}"}
    for k in ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"):
        w = d.get(k)
        if w:
            out[f"{k}_pct"] = w.get("utilization")
            out[f"{k}_reset"] = ts(w.get("resets_at"))
    for l in d.get("limits") or []:
        if l.get("kind") == "weekly_scoped":
            name = ((l.get("scope") or {}).get("model") or {}).get("display_name") or "scoped"
            out[f"weekly_{name}_pct"] = l.get("percent")
    ex = d.get("extra_usage") or {}
    out["extra_usage"] = "on" if ex.get("is_enabled") else "off"
    return out


def _wham(access, account):
    _, d = http("https://chatgpt.com/backend-api/wham/usage",
                {"Authorization": "Bearer " + access, "ChatGPT-Account-Id": account,
                 "User-Agent": "codex_cli_rs/0.157.1"})
    rl = d.get("rate_limit") or {}
    out = {"plan": d.get("plan_type"), "limit_reached": rl.get("limit_reached")}
    for name in ("primary_window", "secondary_window"):
        w = rl.get(name)
        if w:
            span = w.get("limit_window_seconds") or 0
            tag = f"{span // 3600}h" if span < 86400 else f"{span // 86400}d"
            out[f"{tag}_used_pct"] = w.get("used_percent")
            out[f"{tag}_reset"] = ts(w.get("reset_at") or (time.time() + (w.get("reset_after_seconds") or 0)))
    for x in d.get("additional_rate_limits") or []:
        pw = x.get("primary_window") or {}
        out[f"extra[{x.get('limit_name') or x.get('metered_feature')}]_pct"] = pw.get("used_percent")
    cr = d.get("credits") or {}
    out["credits"] = cr.get("balance")
    return out


def _codex_session_fallback():
    files = sorted(glob.glob(H("~/.codex/sessions/**/*.jsonl"), recursive=True), key=os.path.getmtime)
    for f in reversed(files[-20:]):
        last = None
        with open(f, errors="replace") as fh:
            for line in fh:
                if '"rate_limits"' in line:
                    last = line
        if last:
            e = json.loads(last)
            rl = e["payload"]["rate_limits"]
            p = rl.get("primary") or {}
            stale = (p.get("resets_at") or 0) < time.time()
            return {"source": "本地会话日志", "STALE": stale or None, "as_of": ts(e.get("timestamp")),
                    "primary_used_pct": p.get("used_percent"), "primary_reset": ts(p.get("resets_at"))}
    raise RuntimeError("无会话日志")


def ch_codex():
    a = jload("~/.codex/auth.json")["tokens"]
    try:
        return _wham(a["access_token"], a["account_id"])
    except Exception as e:
        fb = _codex_session_fallback()
        fb["live_error"] = scrub(str(e))[:120]
        return fb


AGY_POOL_ID = {"Gemini Models": "gemini", "Claude and GPT models": "claude_gpt"}
AGY_LIMIT_ID = {"Five Hour Limit Remaining": "5h", "Weekly Limit Remaining": "week"}


def mask_email(e):
    return (e[:2] + "…" + e[e.index("@"):]) if e and "@" in e else None


def _agy_account():
    """agy login account (middle masked), taken from the email claim of agy's id_token only."""
    try:
        t = jload("~/.gemini/antigravity-cli/antigravity-oauth-token")["id_token"]
        pl = t.split(".")[1]
        pl += "=" * (-len(pl) % 4)
        return mask_email(json.loads(base64.urlsafe_b64decode(pl)).get("email") or "")
    except Exception:
        return None


def parse_agy_usage(out):
    """Tab separated rows: pool / limit / remaining% / reset (UTC)."""
    pools = []
    for line in out.splitlines():
        f = [x.strip() for x in line.split("\t")]
        if len(f) == 4 and f[2].endswith("%"):
            try:
                left = float(f[2][:-1])
            except ValueError:
                continue
            pools.append({"pool": f[0], "pool_id": AGY_POOL_ID.get(f[0], f[0]),
                          "limit": AGY_LIMIT_ID.get(f[1], f[1]), "left_pct": int(left) if left.is_integer() else left,
                          "reset": ts(f[3]), "reset_utc": f[3]})
    return pools


def ch_agy():
    import shutil, signal, subprocess, tempfile
    exe = shutil.which("agy") or H("~/.local/bin/agy")
    if not os.path.exists(exe):
        raise QuotaError("not_installed", "本机未装 agy")
    env = dict(os.environ)
    env.setdefault("NO_PROXY", "localhost,127.0.0.1")
    # own process group: on timeout SIGKILL agy and its children (it ignores SIGTERM)
    p = subprocess.Popen([exe, "-p", "/usage"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, cwd=tempfile.gettempdir(), env=env,
                         start_new_session=True)
    try:
        raw, _ = p.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.communicate()
        raise QuotaError("timeout", f"timed out: agy -p /usage {TIMEOUT:g}s 未返回，已强杀") from None
    out = raw.decode("utf-8", "replace")
    pools = parse_agy_usage(out)
    if not pools:
        raise RuntimeError(f"agy /usage rc={p.returncode} 无额度行: " + " ".join(out.split())[:160])
    return {"account": _agy_account(), "lowest_left_pct": min(x["left_pct"] for x in pools),
            "note": "额度跟账号走，account 相同的机器共用一份，别重复计",
            "pools": pools}


def ch_cursor():
    t = jload("~/.config/cursor/auth.json")["accessToken"]
    pl = t.split(".")[1]
    pl += "=" * (-len(pl) % 4)
    uid = json.loads(base64.urlsafe_b64decode(pl))["sub"].split("|")[-1]
    cookie = "WorkosCursorSessionToken=" + urllib.parse.quote(uid + "::" + t, safe="")
    _, d = http("https://cursor.com/api/usage-summary", {"Cookie": cookie})
    plan = (d.get("individualUsage") or {}).get("plan") or {}
    od = (d.get("individualUsage") or {}).get("onDemand") or {}
    return {"plan": d.get("membershipType"), "cycle_end": ts(d.get("billingCycleEnd")),
            "total_pct": round(plan.get("totalPercentUsed") or 0, 1),
            "auto_pct": round(plan.get("autoPercentUsed") or 0, 1),
            "api_pct": round(plan.get("apiPercentUsed") or 0, 1),
            "included_used/limit": f"{plan.get('used')}/{plan.get('limit')}",
            "on_demand": "on" if od.get("enabled") else "off"}


CHANNELS = [("tokenline", ch_tokenline), ("kimi", ch_kimi), ("deepseek", ch_deepseek),
            ("claude", ch_claude), ("codex", ch_codex), ("cursor", ch_cursor), ("agy", ch_agy)]

NET_HINT = re.compile(r"403|unreachable|timed out|urlopen error|Connection (refused|reset)|Name or service", re.I)


def classify(e):
    """Exception -> failure object {ok: False, error, code}."""
    if isinstance(e, FileNotFoundError):
        return {"ok": False, "error": f"本机无凭据: {os.path.basename(e.filename or '')}", "code": "no_credentials"}
    if isinstance(e, KeyError):
        return {"ok": False, "error": f"凭据缺字段/未配置: {e}", "code": "missing_field"}
    if isinstance(e, cf.TimeoutError):
        return {"ok": False, "error": "超时", "code": "timeout"}
    msg = scrub(str(e))[:200]
    code = getattr(e, "code", None) if isinstance(e, QuotaError) else None
    if code is None:
        code = "timeout" if "timed out" in msg else "network" if NET_HINT.search(msg) else "error"
    if not PROXY and NET_HINT.search(msg):
        msg += "  (未设代理，境外接口试 --proxy)"
    return {"ok": False, "error": msg, "code": code}


def collect(channels):
    results = {}
    ex = cf.ThreadPoolExecutor(max_workers=len(channels) or 1)
    futs = {name: ex.submit(fn) for name, fn in channels}
    deadline = time.time() + TIMEOUT + 5
    for name, fu in futs.items():
        try:
            results[name] = {"ok": True, **fu.result(timeout=max(0.1, deadline - time.time()))}
        except BaseException as e:  # noqa: BLE001 - every failure becomes a FAIL row
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            results[name] = classify(e)
    try:
        ex.shutdown(wait=False, cancel_futures=True)
    except TypeError:  # Python < 3.9
        ex.shutdown(wait=False)
    return results


def render_text(meta, results):
    lines = [f"# quota @ {meta['host']}  {meta['at']}  proxy={meta['proxy']}"]
    for name, r in results.items():
        if r.get("ok"):
            kv = "  ".join(f"{k}={v}" for k, v in r.items()
                           if k != "ok" and v is not None and not isinstance(v, list))
            lines.append(f"{name:<10} OK   {kv}")
            for v in r.values():  # per-row details (agy: two pools x two limits)
                if isinstance(v, list):
                    for x in v:
                        lines.append(f"{'':<15}{x['pool']:<24}{x['limit']:<6}left={x['left_pct']}%  reset={x['reset']}")
        else:
            lines.append(f"{name:<10} FAIL {r['error']}")
    return "\n".join(lines)


def main(argv=None):
    opts = setup(sys.argv[1:] if argv is None else argv)
    if opts.get("version"):
        print("model-quota " + VERSION)
        return 0
    only = opts["only"]
    channels = [c for c in CHANNELS if only is None or c[0] in only]
    results = collect(channels)
    meta = {"host": os.uname().nodename, "proxy": "set" if PROXY else "none",
            "at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z"),
            "tool": "model-quota", "version": VERSION,
            "tokenline_base": "set" if TL_BASE else "none"}
    if opts["json"]:
        print(json.dumps({"meta": meta, "channels": results}, ensure_ascii=False, indent=1))
    else:
        print(render_text(meta, results))
    return 0


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    os._exit(0)  # do not wait for worker threads stuck in a slow endpoint
