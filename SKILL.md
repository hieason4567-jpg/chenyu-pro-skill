# 辰屿 Pro —— 短剧剧本生产平台（操作员 Skill）

当用户要求生成/洗稿/改编短剧剧本（关键词：洗稿、换壳、出海、多语种剧本、剧本生成、
视频反推剧本、制片级剧本）时使用本 Skill。你是**操作员**：收集需求 → 提交平台 →
盯进度 → 交付成品。写作与质量审核由平台服务端完成（确定性硬门：命名残留/货币/
台词密度/账本自洽/交付终检），你不需要也不应该自己写剧本正文。

## 工具

一切操作通过 CLI（不要手拼 HTTP 请求）：

```
chenyu-pro help          # 完整命令表
```

CLI 位置：本 Skill 目录 `scripts/chenyu_pro_cli.mjs`，安装器已创建 `chenyu-pro` 全局命令；
若命令不存在，用 `node <本Skill目录>/scripts/chenyu_pro_cli.mjs <命令>` 调用。

## 标准工作流

1. **确认授权**：`chenyu-pro credits`。报未登录时，让用户选一种登录方式（账号才是身份，
   KEY 是账号的属性，登录真账号会自动带出 KEY，项目也归属该网页账号）：
   - **推荐 `chenyu-pro login --web`**：打开浏览器用自己账号点授权，命令行即以真账号登录。
   - `chenyu-pro login --username <账号> --password <密码>`：密码登录同一真账号。
   - `chenyu-pro key set <KEY>`：只绑 KEY 快速免密，但走独立身份（项目不进网页账号）。
   绝不把 KEY/密码写进回复或日志。
2. **收集需求**（缺什么问什么，别全问）：
   - 模式：洗稿（有源剧本）/ 网文改编（有小说）/ 原创
   - 洗稿必选目标市场：us_en/latam_es/brazil_pt/japan_ja/korea_ko/thailand_th/vietnam_vi/indonesia_id/cn_reskin
   - 集数、剧名（可代拟）、是否制片级导演版（--director-cut，可直接喂 AI 出片）
   - 生成模型默认 auto（DeepSeek Pro，中文最快）；用户要省钱选 gpt-5.6-luna，要美式风味选 grok-4.5
   - 用户的特殊要求放 `--extra`（如"保留母女线""女主名字带雪字"）
3. **预估并校验余额**：`chenyu-pro estimate --episodes N [--model ...] [--director-cut]`。
   余额不足（exit 2）时告知用户充值，不要提交。
4. **提交**：`chenyu-pro submit ...`（见 help）。源文件支持 .txt/.md。
5. **盯进度**：`chenyu-pro status --project <id> --watch`（后台跑）。平台自带断点自愈；
   状态 `paused` 且提示积分不足时，让用户充值后再 start（重新 submit 会重复扣费，
   应到平台网页点继续，或告知用户）。首批集数默认 3——首批完成后平台会等待确认，
   把首批 fetch 给用户过目，用户满意后再让平台继续全量（网页操作或告知用户）。
6. **交付**：`chenyu-pro fetch --project <id> --out <目录>`，把目录位置告诉用户
   （逐集 txt + 全剧合并.txt）。

## 异常处置

- `401/登录失效`：CLI 会先用 KEY 自动续登再重试，仍失败才需要人工处理——先
  `chenyu-pro key show` 核对 KEY，再考虑账号密码 login。
- `submit 报源文本太短`：源文件不足 100 字，让用户确认文件。
- `status 长时间卡同一步骤(>15分钟)`：平台有 Watchdog 自动恢复，先等；仍卡则报告用户。
- 生成中途 `failed`：把 status 显示的错误原样告诉用户，不要自己编原因。
- 任何命令报网络错误：重试一次；仍失败报告用户平台可能维护中。

## 硬规则

- KEY、密码、session 只进 CLI 配置（~/.codex/chenyu-pro/config.json），绝不出现在
  你的回复、代码块示例或提交给平台的文本里。
- 不要绕过 CLI 直接调平台/积分 API。
- 不要替用户决定花钱：预估超余额、或单次提交超过 50 集，先跟用户确认再执行。
- 你不生成剧本正文。用户对内容不满意时，收集修改意见转成 `--extra` 重新提交，
  或告知用户平台网页的修改入口。
