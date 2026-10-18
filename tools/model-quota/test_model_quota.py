"""Unit tests for model-quota.py (standard library only): python3 -m unittest discover tools/model-quota"""
import base64, importlib.util, io, json, os, pathlib, shutil, subprocess, sys, tempfile, time, unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "model-quota.py"


def load():
    spec = importlib.util.spec_from_file_location("model_quota", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def jwt(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "eyJhbGciOiJub25lIn0." + body + ".sig"


class Base(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="mq-")
        self.env = mock.patch.dict(os.environ, {"HOME": self.home, "XDG_CONFIG_HOME": ""}, clear=False)
        self.env.start()
        for v in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
            os.environ.pop(v, None)
        self.mq = load()
        self.mq.setup([], environ={})
        self.calls = []

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def write(self, rel, content, mode=None):
        p = pathlib.Path(self.home, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content if isinstance(content, str) else json.dumps(content))
        return p

    def fake_http(self, routes):
        def http(url, headers, timeout=None):
            self.calls.append((url, headers))
            for prefix, body in routes.items():
                if url.startswith(prefix):
                    if isinstance(body, Exception):
                        raise body
                    return 200, body
            raise AssertionError("unexpected url " + url)
        self.mq.http = http


class ConfigTests(Base):
    def test_config_parsing_comments_quotes_and_unknown_keys(self):
        p = self.write(".config/model-quota/config",
                       "# comment\nproxy = http://127.0.0.1:7890  # local\n"
                       "TOKENLINE_BASE='https://relay.example.com/'\nnonsense\nempty =\n")
        cfg = self.mq.read_config(str(p))
        self.assertEqual(cfg, {"proxy": "http://127.0.0.1:7890", "tokenline_base": "https://relay.example.com/"})
        self.assertEqual(self.mq.read_config(os.path.join(self.home, "missing")), {})

    def test_default_path_follows_xdg(self):
        self.assertEqual(self.mq.config_path(), os.path.join(self.home, ".config/model-quota/config"))
        with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": "/x"}):
            self.assertEqual(self.mq.config_path(), "/x/model-quota/config")

    def test_proxy_precedence(self):
        env = {}
        self.assertEqual(self.mq.resolve_proxy(None, {}, env), (None, "none"))
        self.write(".amail/proxy", "http://legacy:1\n")
        self.assertEqual(self.mq.resolve_proxy(None, {}, env), ("http://legacy:1", "legacy"))
        self.assertEqual(self.mq.resolve_proxy(None, {"proxy": "http://cfg:2"}, env), ("http://cfg:2", "config"))
        env["https_proxy"] = "http://env:3"
        self.assertEqual(self.mq.resolve_proxy(None, {"proxy": "http://cfg:2"}, env), ("http://env:3", "env"))
        self.assertEqual(self.mq.resolve_proxy("http://arg:4", {}, env), ("http://arg:4", "arg"))

    def test_setup_applies_config_and_exports_proxy(self):
        self.write(".config/model-quota/config", "proxy=http://cfg:2\ntokenline_base=https://relay.example.com/\ntimeout=7\n")
        env = {}
        opts = self.mq.setup(["--json", "--only", "claude,agy"], environ=env)
        self.assertTrue(opts["json"])
        self.assertEqual(opts["only"], {"claude", "agy"})
        self.assertEqual(self.mq.TIMEOUT, 7.0)
        self.assertEqual(self.mq.PROXY, "http://cfg:2")
        self.assertEqual(env["HTTPS_PROXY"], "http://cfg:2")
        self.assertEqual(self.mq.TL_BASE, "https://relay.example.com")
        self.mq.setup(["--tokenline-base", "not a url", "--timeout", "3", "--config", "/nonexistent", "--bogus"], environ={})
        self.assertIsNone(self.mq.TL_BASE)
        self.assertIsNone(self.mq.PROXY)
        self.assertEqual(self.mq.TIMEOUT, 3.0)


class ChannelTests(Base):
    def pi_auth(self, **extra):
        self.write(".pi/agent/auth.json", {"tokenline": {"key": "sk-tl-secretkey123"}, "kimi-coding": {"key": "sk-kimi-secret1"},
                                           "deepseek": {"key": "sk-ds-secret123"}, **extra})

    def test_missing_credentials_and_fields_become_codes(self):
        r = self.mq.collect([("claude", self.mq.ch_claude), ("deepseek", self.mq.ch_deepseek)])
        self.assertEqual(r["claude"], {"ok": False, "error": "本机无凭据: .credentials.json", "code": "no_credentials"})
        self.assertEqual(r["deepseek"]["code"], "no_credentials")
        self.write(".pi/agent/auth.json", {})
        r = self.mq.collect([("deepseek", self.mq.ch_deepseek)])
        self.assertEqual(r["deepseek"]["code"], "missing_field")

    def test_tokenline_unconfigured_is_skipped_without_requests(self):
        self.pi_auth()
        self.fake_http({})
        r = self.mq.collect([("tokenline", self.mq.ch_tokenline)])["tokenline"]
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "not_configured")
        self.assertIn("tokenline_base", r["error"])
        self.assertEqual(self.calls, [])

    def test_tokenline_with_base(self):
        self.pi_auth()
        self.mq.TL_BASE = "https://relay.example.com"
        self.fake_http({
            "https://relay.example.com/api/status": {"data": {"quota_per_unit": 500000}},
            "https://relay.example.com/api/usage/token": {"data": {"name": "coding", "total_used": 1000000, "total_available": 500000, "unlimited_quota": False, "expires_at": 0}},
        })
        r = self.mq.ch_tokenline()
        self.assertEqual(r["key_used_usd"], 2.0)
        self.assertEqual(r["key_remaining_usd"], 1.0)
        self.assertEqual(r["key_expires"], "永不")
        self.assertIn("access_token", r["note"])
        self.assertTrue(all(u.startswith("https://relay.example.com/") for u, _ in self.calls))

    def test_kimi_deepseek(self):
        self.pi_auth()
        self.fake_http({
            "https://api.kimi.com/": {"usage": {"used": 20, "limit": 100, "resetTime": "2026-10-22T03:38:00Z"},
                                      "limits": [{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"}, "detail": {"used": 1, "limit": 4, "resetTime": 0}}]},
            "https://api.deepseek.com/": {"is_available": True, "balance_infos": [{"total_balance": "10.00", "currency": "CNY", "granted_balance": "1", "topped_up_balance": "9"}]},
        })
        k = self.mq.ch_kimi()
        self.assertEqual(k["week_used_pct"], 20.0)
        self.assertEqual(k["win_300m_used_pct"], 25.0)
        self.assertIsNone(k["win_300m_reset"])
        d = self.mq.ch_deepseek()
        self.assertEqual(d["balance"], "10.00 CNY")
        self.assertTrue(d["available"])

    def test_claude_expired_and_live(self):
        self.write(".claude/.credentials.json", {"claudeAiOauth": {"accessToken": "x", "expiresAt": 1000}})
        r = self.mq.collect([("claude", self.mq.ch_claude)])["claude"]
        self.assertEqual(r["code"], "token_expired")
        self.write(".claude/.credentials.json", {"claudeAiOauth": {"accessToken": "x", "expiresAt": (time.time() + 3600) * 1000,
                                                                    "subscriptionType": "max", "rateLimitTier": "tier"}})
        self.fake_http({"https://api.anthropic.com/": {
            "five_hour": {"utilization": 18.0, "resets_at": "2026-10-18T09:20:00+00:00"},
            "seven_day": {"utilization": 45.0, "resets_at": None},
            "limits": [{"kind": "weekly_scoped", "percent": 3, "scope": {"model": {"display_name": "Opus"}}}],
            "extra_usage": {"is_enabled": True}}})
        r = self.mq.ch_claude()
        self.assertEqual((r["plan"], r["five_hour_pct"], r["seven_day_pct"], r["weekly_Opus_pct"], r["extra_usage"]),
                         ("max / tier", 18.0, 45.0, 3, "on"))

    def test_codex_live_and_session_fallback(self):
        self.write(".codex/auth.json", {"tokens": {"access_token": "a", "account_id": "acc"}})
        wham = {"plan_type": "pro", "rate_limit": {"limit_reached": False,
                "primary_window": {"limit_window_seconds": 18000, "used_percent": 40, "reset_at": 1760000000},
                "secondary_window": {"limit_window_seconds": 604800, "used_percent": 2, "reset_after_seconds": 10}},
                "credits": {"balance": "5"}}
        self.fake_http({"https://chatgpt.com/": wham})
        r = self.mq.ch_codex()
        self.assertEqual((r["5h_used_pct"], r["7d_used_pct"], r["credits"]), (40, 2, "5"))
        self.fake_http({"https://chatgpt.com/": self.mq.QuotaError("http_403", "HTTP 403: Bearer abcdefghijklmnop")})
        self.write(".codex/sessions/2026/a.jsonl", json.dumps({"timestamp": "2026-10-18T00:00:00Z", "payload": {
            "rate_limits": {"primary": {"used_percent": 9, "resets_at": 1}}}}) + "\n")
        r = self.mq.ch_codex()
        self.assertEqual(r["primary_used_pct"], 9)
        self.assertTrue(r["STALE"])
        self.assertNotIn("abcdefghijklmnop", r["live_error"])

    def test_cursor(self):
        self.write(".config/cursor/auth.json", {"accessToken": jwt({"sub": "auth0|user_1"})})
        self.fake_http({"https://cursor.com/": {"membershipType": "pro", "billingCycleEnd": "2026-11-01T00:00:00Z",
                        "individualUsage": {"plan": {"totalPercentUsed": 12.345, "used": 1, "limit": 10}, "onDemand": {"enabled": False}}}})
        r = self.mq.ch_cursor()
        self.assertEqual((r["plan"], r["total_pct"], r["included_used/limit"], r["on_demand"]), ("pro", 12.3, "1/10", "off"))
        self.assertIn("user_1", self.calls[0][1]["Cookie"])

    def test_agy_parse_and_account_mask(self):
        out = ("header\nGemini Models\tWeekly Limit Remaining\t80%\t2026-10-24T03:12:25Z\n"
               "Claude and GPT models\tFive Hour Limit Remaining\t12.5%\t2026-10-18T09:34:06Z\nbad\tline\tx%\t-\n")
        pools = self.mq.parse_agy_usage(out)
        self.assertEqual([(p["pool_id"], p["limit"], p["left_pct"]) for p in pools],
                         [("gemini", "week", 80), ("claude_gpt", "5h", 12.5)])
        self.write(".gemini/antigravity-cli/antigravity-oauth-token", {"id_token": jwt({"email": "someone@example.com"})})
        self.assertEqual(self.mq._agy_account(), "so…@example.com")

    def test_agy_not_installed(self):
        with mock.patch("shutil.which", return_value=None):
            r = self.mq.collect([("agy", self.mq.ch_agy)])["agy"]
        self.assertEqual(r["code"], "not_installed")


class OutputTests(Base):
    def test_scrub_and_network_hint(self):
        self.assertEqual(self.mq.scrub("Bearer abcdefghijkl sk-abcdefghijk eyJabcdefghij"), "Bearer *** sk-*** eyJ***")
        r = self.mq.classify(RuntimeError("<urlopen error timed out>"))
        self.assertEqual(r["code"], "timeout")
        self.assertIn("未设代理", r["error"])
        self.mq.PROXY = "http://p:1"
        r = self.mq.classify(self.mq.QuotaError("http_401", "HTTP 401: token sk-abcdefghijklmn"))
        self.assertEqual(r["code"], "http_401")
        self.assertNotIn("abcdefghijklmn", r["error"])
        self.assertNotIn("未设代理", r["error"])

    def test_json_shape_is_backward_compatible(self):
        self.mq.CHANNELS = [("deepseek", self.mq.ch_deepseek)]
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.mq.main(["--json"])
        data = json.loads(buf.getvalue())
        self.assertLessEqual({"host", "proxy", "at"}, set(data["meta"]))
        self.assertEqual(data["meta"]["tokenline_base"], "none")
        self.assertEqual(set(data["channels"]), {"deepseek"})
        self.assertEqual(data["channels"]["deepseek"]["ok"], False)
        self.assertIn("error", data["channels"]["deepseek"])

    def test_text_output(self):
        text = self.mq.render_text({"host": "h", "at": "t", "proxy": "none"}, {
            "agy": {"ok": True, "lowest_left_pct": 0, "pools": [{"pool": "Gemini Models", "limit": "5h", "left_pct": 0, "reset": "r"}]},
            "claude": {"ok": False, "error": "x", "code": "error"}})
        self.assertIn("agy        OK   lowest_left_pct=0", text)
        self.assertIn("Gemini Models", text)
        self.assertIn("claude     FAIL x", text)

    def test_runs_from_stdin_with_empty_home(self):
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin"}
        p = subprocess.run([sys.executable, "-", "--json", "--only", "claude,tokenline", "--timeout", "2"],
                           input=SCRIPT.read_bytes(), capture_output=True, env=env, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        data = json.loads(p.stdout)
        self.assertEqual(data["meta"]["proxy"], "none")
        self.assertEqual({k: v["code"] for k, v in data["channels"].items()},
                         {"claude": "no_credentials", "tokenline": "no_credentials"})


if __name__ == "__main__":
    unittest.main()
