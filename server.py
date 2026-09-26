import json
import getpass
import hmac
import os
import secrets
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
POSTPEER_API = "https://api.postpeer.dev/v1"
HOST = os.environ.get("HOST", "127.0.0.1")
PUBLIC_MODE = HOST not in ("127.0.0.1", "localhost", "::1")
ACCESS_PASSWORD = os.environ.get("MARIO_ACCESS_PASSWORD", "")
SESSION_MAX_AGE = 12 * 60 * 60
SESSIONS = {}
SESSION_LOCK = threading.Lock()
LOGIN_ATTEMPTS = {}
LOGIN_LOCK = threading.Lock()
LOGIN_LIMIT = 5
LOGIN_COOLDOWN = 15 * 60
ALLOWED_PRIVACY = {
    "PUBLIC_TO_EVERYONE",
    "MUTUAL_FOLLOW_FRIENDS",
    "SELF_ONLY",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def get_api_key():
    return os.environ.get("POSTPEER_API_KEY", "").strip()


def postpeer_request(path, method="GET", payload=None):
    api_key = get_api_key()
    if not api_key:
        raise ApiError(503, "Set POSTPEER_API_KEY before using the publisher.")

    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        POSTPEER_API + path,
        data=data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-access-key": api_key,
        },
        method=method,
    )
    try:
        with urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            detail = {}
        message = detail.get("message") or detail.get("error") or "PostPeer rejected the request."
        raise ApiError(error.code, str(message)) from error
    except (URLError, TimeoutError) as error:
        raise ApiError(502, "Could not reach PostPeer. Check the connection and try again.") from error
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ApiError(502, "PostPeer returned an unreadable response.") from error


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, body, headers=()):
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def request_is_same_origin(self):
        origin = urlsplit(self.headers.get("Origin", ""))
        expected_host = self.headers.get("X-Forwarded-Host", self.headers.get("Host", ""))
        expected_host = expected_host.split(",", 1)[0].strip().lower()
        return bool(origin.netloc and origin.netloc.lower() == expected_host)

    def session_token(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get("MARIO_SESSION")
        return morsel.value if morsel else ""

    def is_authenticated(self):
        if not PUBLIC_MODE:
            return True
        token = self.session_token()
        if not token:
            return False
        now = time.time()
        with SESSION_LOCK:
            expiry = SESSIONS.get(token, 0)
            if expiry <= now:
                SESSIONS.pop(token, None)
                return False
            return True

    def session_cookie(self, token, max_age):
        value = f"MARIO_SESSION={token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={max_age}"
        if self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip() == "https":
            value += "; Secure"
        return value

    def login_is_limited(self):
        now = time.time()
        with LOGIN_LOCK:
            failures, blocked_until = LOGIN_ATTEMPTS.get(self.client_address[0], (0, 0))
            return now < blocked_until

    def record_login_failure(self):
        now = time.time()
        with LOGIN_LOCK:
            failures, blocked_until = LOGIN_ATTEMPTS.get(self.client_address[0], (0, 0))
            failures += 1
            if failures >= LOGIN_LIMIT:
                blocked_until = now + LOGIN_COOLDOWN
                failures = 0
            LOGIN_ATTEMPTS[self.client_address[0]] = (failures, blocked_until)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(400, "Invalid request length.") from error
        if length < 1 or length > 1_000_000:
            raise ApiError(400, "Request body is empty or too large.")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ApiError(400, "Request body must be valid JSON.") from error

    def do_GET(self):
        parsed = urlsplit(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()
        if parsed.path == "/api/health":
            return self.send_json(200, {"ok": True})
        if parsed.path == "/api/session":
            authenticated = self.is_authenticated()
            return self.send_json(200, {
                "authenticated": authenticated,
                "requiresLogin": PUBLIC_MODE,
            })
        if not self.is_authenticated():
            return self.send_json(401, {"error": "Sign in to access publishing controls."})
        try:
            if parsed.path == "/api/status":
                if not get_api_key():
                    return self.send_json(200, {"configured": False, "valid": False})
                try:
                    postpeer_request("/health/auth")
                except ApiError as error:
                    if error.status in (401, 403):
                        return self.send_json(200, {
                            "configured": True,
                            "valid": False,
                            "message": "PostPeer rejected this API key.",
                        })
                    raise
                return self.send_json(200, {"configured": True, "valid": True})
            if parsed.path == "/api/connect":
                _, result = postpeer_request("/connect/tiktok")
                return self.send_json(200, result)
            if parsed.path == "/api/accounts":
                _, result = postpeer_request("/connect/integrations")
                integrations = result.get("integrations", [])
                accounts = []
                for integration in integrations:
                    if str(integration.get("platform", "")).lower() != "tiktok":
                        continue
                    account_id = integration.get("id") or integration.get("accountId")
                    if account_id:
                        accounts.append({
                            "id": str(account_id),
                            "username": integration.get("username") or integration.get("platformUsername"),
                        })
                return self.send_json(200, {"accounts": accounts})
            if parsed.path == "/api/creator-info":
                account_id = parse_qs(parsed.query).get("accountId", [""])[0]
                if not account_id:
                    raise ApiError(400, "Choose a TikTok account first.")
                _, result = postpeer_request(f"/tiktok/creator-info?accountId={quote(account_id, safe='')}")
                return self.send_json(200, result)
            raise ApiError(404, "API route not found.")
        except ApiError as error:
            self.send_json(error.status, {"error": str(error)})

    def do_POST(self):
        parsed = urlsplit(self.path)
        if not self.request_is_same_origin():
            return self.send_json(403, {"error": "Request origin was not allowed."})
        if parsed.path == "/api/login":
            if not PUBLIC_MODE:
                return self.send_json(200, {"authenticated": True})
            if not ACCESS_PASSWORD:
                return self.send_json(503, {"error": "Private posting access is not configured."})
            if self.login_is_limited():
                return self.send_json(429, {"error": "Too many sign-in attempts. Try again in 15 minutes."})
            try:
                body = self.read_json()
            except ApiError as error:
                return self.send_json(error.status, {"error": str(error)})
            if not isinstance(body, dict):
                return self.send_json(400, {"error": "Request body must be a JSON object."})
            candidate = str(body.get("password", ""))[:4096]
            if not hmac.compare_digest(candidate, ACCESS_PASSWORD):
                self.record_login_failure()
                return self.send_json(401, {"error": "That posting password was not accepted."})

            token = secrets.token_urlsafe(32)
            now = time.time()
            with SESSION_LOCK:
                for old_token, expiry in list(SESSIONS.items()):
                    if expiry <= now:
                        SESSIONS.pop(old_token, None)
                SESSIONS[token] = now + SESSION_MAX_AGE
            with LOGIN_LOCK:
                LOGIN_ATTEMPTS.pop(self.client_address[0], None)
            return self.send_json(200, {"authenticated": True}, [
                ("Set-Cookie", self.session_cookie(token, SESSION_MAX_AGE)),
            ])
        if parsed.path == "/api/logout":
            token = self.session_token()
            with SESSION_LOCK:
                SESSIONS.pop(token, None)
            return self.send_json(200, {"authenticated": False}, [
                ("Set-Cookie", self.session_cookie("", 0)),
            ])
        if not parsed.path.startswith("/api/"):
            return self.send_json(404, {"error": "API route not found."})
        if not self.is_authenticated():
            return self.send_json(401, {"error": "Sign in to access publishing controls."})
        try:
            body = self.read_json()
            if not isinstance(body, dict):
                raise ApiError(400, "Request body must be a JSON object.")
            if parsed.path == "/api/media/upload":
                filename = Path(str(body.get("filename", ""))).name
                mime_type = str(body.get("mimeType", ""))
                if not filename or not mime_type.startswith("video/"):
                    raise ApiError(400, "Choose a supported video file.")
                _, result = postpeer_request("/media/upload", "POST", {
                    "filename": filename,
                    "mimeType": mime_type,
                })
                return self.send_json(200, result)
            if parsed.path == "/api/posts":
                account_id = str(body.get("accountId", "")).strip()
                media_url = str(body.get("mediaUrl", "")).strip()
                privacy = str(body.get("privacyLevel", ""))
                delivery = body.get("delivery")
                if not account_id or not media_url.startswith("https://"):
                    raise ApiError(400, "Select an account and upload a video first.")
                if privacy not in ALLOWED_PRIVACY:
                    raise ApiError(400, "Choose a supported TikTok audience.")
                if delivery not in ("now", "schedule"):
                    raise ApiError(400, "Choose Auto-post now or Schedule.")

                platform_options = {
                    "privacyLevel": privacy,
                    "disableComment": bool(body.get("disableComment", False)),
                    "disableDuet": bool(body.get("disableDuet", False)),
                    "disableStitch": bool(body.get("disableStitch", False)),
                    "draft": False,
                }
                post = {
                    "content": str(body.get("content", "")),
                    "platforms": [{
                        "platform": "tiktok",
                        "accountId": account_id,
                        "platformSpecificData": platform_options,
                    }],
                    "mediaItems": [{"type": "video", "url": media_url}],
                    "idempotencyKey": str(body.get("idempotencyKey", "")),
                }
                if delivery == "now":
                    post["publishNow"] = True
                else:
                    scheduled_for = str(body.get("scheduledFor", ""))
                    timezone = str(body.get("timezone", ""))
                    if not scheduled_for or not timezone:
                        raise ApiError(400, "A schedule time and timezone are required.")
                    post["scheduledFor"] = scheduled_for
                    post["timezone"] = timezone

                status, result = postpeer_request("/posts", "POST", post)
                return self.send_json(status, result)
            raise ApiError(404, "API route not found.")
        except ApiError as error:
            self.send_json(error.status, {"error": str(error)})

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))


if __name__ == "__main__":
    if PUBLIC_MODE and len(ACCESS_PASSWORD) < 16:
        raise SystemExit("Set MARIO_ACCESS_PASSWORD to at least 16 characters before public binding.")
    if not get_api_key() and sys.stdin.isatty():
        try:
            entered_key = getpass.getpass("PostPeer API key (hidden input, not saved): ").strip()
        except (EOFError, KeyboardInterrupt):
            entered_key = ""
        if entered_key:
            os.environ["POSTPEER_API_KEY"] = entered_key
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer((HOST, port), Handler)
    print(f"MARIO_Method running at {HOST}:{port}")
    print("PostPeer API key configured:", bool(get_api_key()))
    print("Private posting login required:", PUBLIC_MODE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping MARIO_Method.")
    finally:
        server.server_close()
