# GitHub 同步命令

目标仓库：

```text
https://github.com/vectoflarecrm/data
```

## 方式一：浏览器授权后使用 HTTPS

在项目根目录执行：

```bash
cd ~/global-watersports-intelligence
gh auth login --hostname github.com --git-protocol https --web
```

根据终端提示：

1. 打开 GitHub 显示的授权网址；
2. 输入一次性设备代码；
3. 登录 GitHub 并点击授权；
4. 等待终端显示登录成功。

检查登录状态：

```bash
gh auth status --hostname github.com
```

推送项目：

```bash
git push -u origin main
```

## 方式二：SSH

如果已经配置 GitHub SSH Key：

```bash
cd ~/global-watersports-intelligence
git remote set-url origin git@github.com:vectoflarecrm/data.git
git push -u origin main
```

检查远程地址：

```bash
git remote -v
```

## 当前本地提交

```text
ed98751 Enforce verified customer research and canonical product categories
```

## 安全说明

不要把以下内容发送到聊天或提交到 Git：

- GitHub 密码；
- GitHub Personal Access Token；
- Cloudflare API Token；
- Gemini API Key；
- `.env`、`.dev.vars` 和本地依赖目录。
