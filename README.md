# 辰屿 Pro Skill

当前版本 **v2.10.0**（以 `chenyu-pro version` 为准；重跑安装命令即升级）

短剧剧本生产平台的 AI Agent 操作员 Skill——装进 Codex / Claude Code 后，直接对 Agent 说
"帮我把这个剧本洗成日本版，30 集"，Agent 自动完成：授权检查 → 积分预估 → 提交生产 →
盯进度 → 交付整包剧本。支持 9 个目标市场洗稿、网文改编、制片级导演拍摄版。

## 一行安装（Windows，需 Node 18+）

```powershell
irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex
```

装完后对你的 Codex / Claude Code 说一句剧本需求即可；或人工使用 CLI：

```
chenyu-pro key set <积分KEY>                     # 绑定后自动免密登录
chenyu-pro credits                              # 查积分
chenyu-pro video-analyze --video-file 第01集.mp4,第02集.mp4 --title 剧名   # 视频反推（先报价，同意后加 --yes）
chenyu-pro video-analyze --project 剧名 --video-file 第03集.mp4            # 追加后面的集到同一部剧
chenyu-pro assets-prepare --dir ./chenyu-video-analysis                     # 资产整理（零积分）
chenyu-pro gate --dir ./剧本                                                 # 格式门
chenyu-pro wash-check --dir ./剧本 --source ./chenyu-video-analysis          # 洗稿检查：对照原片查照抄/旧名残留等
chenyu-pro deliver-check --dir ./剧本 --source ./chenyu-video-analysis       # 交付门：剧情完整/对话称呼/剧情逻辑，迭代到 DELIVERY_PASS
chenyu-pro help                                 # 全部命令
```

洗稿不交半成品：Agent 写完后按"查 → 审 → 修 → 复查"循环，直到 `deliver-check` 输出 DELIVERY_PASS 才交付（附审核报告）。

账号与积分 KEY 请联系平台方获取。凭据只存本机 `~/.codex/chenyu-pro/config.json`。
