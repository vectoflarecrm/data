#!/usr/bin/env python3
"""获取 Gmail OAuth refresh_token（无需服务账号密钥，绕开组织政策限制）。

适用场景：组织政策 iam.managed.disableServiceAccountKeyCreation 禁止创建
服务账号密钥时，改用 OAuth 用户令牌让 Worker 代发邮件。

前置条件（一次性，约 5 分钟）：
1. Google Cloud Console → API 和服务 → 库 → 启用 Gmail API；
2. API 和服务 → OAuth 同意屏幕 → User Type 选「内部」（Workspace 同域免验证）
   → 创建，添加范围 .../auth/gmail.send；
3. 凭据 → 创建凭据 → OAuth 客户端 ID → 应用类型「桌面应用」→ 创建，
   记下 client_id（…apps.googleusercontent.com 结尾）和 client_secret。

用法：
  python3 scripts/get-gmail-refresh-token.py --client-id CLIENT_ID [--client-secret SECRET]

流程：脚本打开浏览器 → 登录发件邮箱（如 helen@isupfactory.com）→ 同意授权 →
打印 refresh_token。把 refresh_token 和邮箱填入面板「📮 发信账号」即可。

Client ID/Secret 需配置到 Worker：
  npx wrangler secret put GMAIL_OAUTH_CLIENT_ID
  npx wrangler secret put GMAIL_OAUTH_CLIENT_SECRET   # 桌面应用类型可不设

注意：桌面应用 OAuth 客户端无需 Google 审核（同域内部使用）；
refresh_token 长期有效，除非用户在账号安全设置里撤销授权。
"""

import argparse
import http.server
import json
import urllib.parse
import urllib.request
import webbrowser

REDIRECT_PORT = 8765
REDIRECT_URI = f"http://127.0.0.1:{REDIRECT_PORT}"
SCOPE = "https://www.googleapis.com/auth/gmail.send"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def main() -> None:
    parser = argparse.ArgumentParser(description="Get a Gmail OAuth refresh token")
    parser.add_argument("--client-id", required=True, help="OAuth 客户端 ID（…apps.googleusercontent.com）")
    parser.add_argument("--client-secret", default="", help="OAuth 客户端密钥（桌面应用类型可留空）")
    parser.add_argument("--port", type=int, default=REDIRECT_PORT, help="本地回调端口（默认 8765）")
    args = parser.parse_args()

    redirect_uri = f"http://127.0.0.1:{args.port}"
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={urllib.parse.quote(args.client_id)}"
        "&response_type=code"
        f"&redirect_uri={urllib.parse.quote(redirect_uri)}"
        f"&scope={urllib.parse.quote(SCOPE)}"
        "&access_type=offline"
        "&prompt=consent"
    )

    result: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" in query:
                result["code"] = query["code"][0]
                self.send_response(200)
                self.end_headers()
                self.wfile.write("✅ 授权成功，可以关闭此页面回到终端。".encode())
            else:
                result["error"] = query.get("error", ["unknown"])[0]
                self.send_response(400)
                self.end_headers()
                self.wfile.write(f"授权失败：{result['error']}".encode())

        def log_message(self, *args) -> None:  # 静默访问日志
            pass

    server = http.server.HTTPServer(("127.0.0.1", args.port), Handler)
    print("浏览器即将打开 Google 授权页，请登录发件邮箱并点击「允许」…")
    print(f"（如果浏览器没有自动打开，手动访问：\n{auth_url}）\n")
    webbrowser.open(auth_url)
    server.handle_request()  # 等待回调
    server.server_close()

    if "code" not in result:
        raise SystemExit(f"❌ 未拿到授权码：{result.get('error')}")

    data = urllib.parse.urlencode({
        "code": result["code"],
        "client_id": args.client_id,
        **({"client_secret": args.client_secret} if args.client_secret else {}),
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data), timeout=30) as resp:
        token = json.loads(resp.read())

    if "refresh_token" not in token:
        raise SystemExit("❌ 响应中没有 refresh_token（请在授权 URL 加 prompt=consent 后重试，或先在 https://myaccount.google.com/permissions 移除该应用再重新授权）")

    print("\n🎉 成功！请把以下两项填入面板「📮 发信账号」：")
    print(f"  邮箱（client_email）: <你刚才登录授权的发件邮箱>")
    print(f"  refresh_token      : {token['refresh_token']}")
    print("\n并配置 Worker Secrets（只需一次）：")
    print(f"  npx wrangler secret put GMAIL_OAUTH_CLIENT_ID      # 值: {args.client_id}")
    if args.client_secret:
        print("  npx wrangler secret put GMAIL_OAUTH_CLIENT_SECRET")


if __name__ == "__main__":
    main()
