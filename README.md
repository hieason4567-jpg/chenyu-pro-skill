# 辰屿 Pro Skill

短剧剧本生产平台的 AI Agent 操作员 Skill——装进 Codex / Claude Code 后，直接对 Agent 说
"帮我把这个剧本洗成日本版，30 集"，Agent 自动完成：授权检查 → 积分预估 → 提交生产 →
盯进度 → 交付整包剧本。支持 9 个目标市场洗稿、网文改编、制片级导演拍摄版。

## 一行安装（Windows，需 Node 18+）

```powershell
irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex
```

装完后对你的 Codex / Claude Code 说一句剧本需求即可；或人工使用 CLI：

```
chenyu-pro login --username <账号> --password <密码>
chenyu-pro key set <积分KEY>
chenyu-pro credits
chenyu-pro submit --mode rewrite --title 我的剧 --episodes 30 --source 源剧本.txt --market japan_ja
chenyu-pro status --project 我的剧 --watch
chenyu-pro fetch --project 我的剧 --out ./交付
```

账号与积分 KEY 请联系平台方获取。凭据只存本机 `~/.codex/chenyu-pro/config.json`。
