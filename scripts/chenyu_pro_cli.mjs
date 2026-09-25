#!/usr/bin/env node
// 辰屿 Pro CLI —— Agent 编剧模式命令行（v2.x）：写作由安装 Skill 的用户 Agent 完成，
// 不消耗平台积分；本 CLI 只做 鉴权/项目壳/正文回传/只读查询/交付。
// CLI 内不存在任何能触发平台模型生成或扣积分的调用（v2.1.0 起物理移除）。
// 零依赖，Node 18+。配置存 ~/.codex/chenyu-pro/config.json（KEY/session 掩码显示，绝不写入日志）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn, spawnSync } from 'node:child_process';

// 版本号：功能变化 minor+1，修 bug patch+1。改动同时更新下方 CHANGELOG。
// v2.6.0 2026-09-24  制片级剧本格式：场次头 N-1 日/夜 内/外 地点 + 人物行 + 环境描述行 + 台词情绪括注 + （画面：）块 + △镜头过渡；
//                    gate 放行人物行/画面块/环境描述行（不误判小说），台词情绪括注两种位置均兼容。
// v2.6.0 2026-09-22  上传前自动压缩恢复：有 ffmpeg 时先压到 720p 再传（省带宽降超时，计费按时长不变，--no-compress 关/--proxy-height 调）；
//                    v2.1.0 重构曾误删该逻辑（客户端一直传原片致大文件超时）。同版角色形象变体：剧本每场【形象】角色=变体名（变化注明原因）；gate 逐场/跨集核对（缺标、无因变化、
//                    场内无换装动作、泛称变体名、与形象变体表不一致）；新增 variants 命令自动汇总每人几个变体、出现在哪几集哪几场。
// v2.5.2 2026-09-21  视频上传：每个视频超时+重试（换新地址）、并发默认 2、已传的记本地清单，失败后加 --project 重跑只补没传的，
//                    不再一个超时整批作废。
// v2.5.1 2026-09-21  安装脚本去掉结尾 exit（irm | iex 时会关掉用户窗口，看不到安装结果）。
// v2.5.0 2026-09-19  新增 video-fetch：零积分重新取回项目最新分析稿（平台修复/补充后直接取，不用重新分析）；
//                    分段质量检查只看每段最新版本（平台修复后旧版不再误报 ⛔）；SKILL 加辰屿版权与来源声明规则。
// v2.4.1 2026-09-17  同一部剧一个项目：video-analyze 支持 --project 追加到已有项目（平台把新集和已有集合并做人物审计），
//                    集号按文件名（第34集/EP34/34.mp4）而不是提交顺序；文件名不是从第 1 集开始又没给 --project 时拦下，
//                    防止 Agent 一集一个项目（2026-09-14 一个账号 43 个单集项目，跨集人物对不上）。取回分析稿只取最新版本。
// v2.4.0 2026-09-17  写作方式默认 1:1 还原：video-analyze 建的项目带 write_mode=faithful 预设（平台「开始生成」
//                    按原片整理，不再走原创流程改写台词）；SKILL 明确没提洗稿就 1:1（名字/剧情/台词/集数不改）。
// v2.3.8 2026-09-16  video-analyze 取回平台新产物 video_reverse_全剧合集.md（剧集索引+人物/场景/道具
//                    资产表+事件表+逐集分析表），SKILL 补「合集→建映射表→逐集改写→过门回传」洗稿三步。
// v2.3.7 2026-09-16  所有请求带 User-Agent `chenyu-pro-cli/<版本> node/<版本>`，平台日志可识别
//                    客户在跑哪一版 CLI（排查改包版/旧版用）。不改任何业务行为。
// v2.3.6 2026-09-15  gate：补非△行整片时间轴/"按源视频"整片时长/"场景0XX"流水号检测(判 GATE_FAIL)。
// v2.3.5 2026-09-13  gate：△时间码判错、剥时间码再查重、占位话黑名单（"原视频动作…按画面同步保留"）；
//                    video-analyze 逐段检查分析质量，镜头表0行/有质量标记的段 ⛔ 提示停写、告知用户。
// v2.3.4 2026-09-13  needs_review 区分：无失败段=分析完整(仅人物身份门未过，单包必出)，不再提示复核、
//                    避免 Agent 误以为缺内容而重交扣分；有失败段才列出缺哪几段。
// v2.3.3 2026-09-13  video-analyze 打印实际扣除(分析前后余额差)对比报价；平台部分段失败(needs_review)
//                    时照常取回已完成的分析稿，不再当整批失败（配合平台修复重复扣分/单段拖垮整批）。
// v2.3.2 2026-09-13  gate 堵机械转换：同一句△重复出现(把分析表 visible_action 复制到每句台词前)
//                    与万能填充句(话题继续推进/接住话头…)判 GATE_FAIL；SKILL 补"分析表→剧本"写法。
// v2.2.1 2026-08-31  gate 加小说/散文源材料识别：叙述行占绝对多数且无剧本结构时，
//                    不再按行号误导打补丁，直接提示先改编成剧本格式再过门。
// v2.2.0 2026-08-31  新增 gate 格式门：确定性剧本质量校验（纯本地正则，零模型调用，
//                    跑门前仅鉴权）。核心硬门=对白连发段(连续>=3句台词无△动作行)逐段报
//                    行号与补写位置；另查 △心理活动词/台词超长/场次头/配比。Agent 任何
//                    写作链路(自写/洗稿/改编)写完过门到 GATE_PASS 即达辰屿质量标准，
//                    不必走 create/save 全流程。save 默认先过门(--skip-gate 跳过)。
// v2.1.0 2026-08-31  彻底移除平台代写路径：submit/continue/estimate 及视频反推/上传/压缩
//                    代码整体删除。CLI 中不再存在任何能触发平台模型生成或扣积分的调用；
//                    仅剩 鉴权/项目壳/正文回传/只读查询/交付 六类端点。
// v2.0.0 2026-08-31  架构反转：写作改由安装 Skill 的用户 Agent 完成（不消耗平台积分），
//                    平台只做鉴权与项目/交付管理。新增 auth(鉴权门，Agent 动笔前必须通过)、
//                    create(建项目壳，不触发平台生成、零积分)、save(回传 Agent 写的正文，
//                    按 A15 正文产物契约入库 → fetch/sync/word 交付链路直接可用)。
//                    submit(平台代写)保留为付费兼容模式，Skill 默认不再使用。
// v1.8.9 2026-07-25  submit 加 --shots：默认纯剧本(场景+动作+对白)，--shots 才加拍摄分镜层
//                    (画面/运镜/特效/转场)。引擎 shot_directions 默认关，director-cut 隐含开启。
// v1.8.8 2026-07-25  fetch 改用服务端归一化分集(/script-episodes)：标题回填、对白「说话人：
//                    “台词”」、紧凑排版、去空特效行，与平台云同步/导出同格式；不再本地读原始产物
// v1.8.7 2026-07-25  A路(原创/改编)也支持 --market：蓝图与正文按目标市场名字/货币/称谓
//                    原生落地(不给=中文)；引擎侧 market 已成一等公民，四道命名/货币门随之启用
// v1.8.6 2026-07-25  submit --mode rewrite 走B路(忠实换壳)+ --from-project 复用反推稿洗
//                    另一市场版(不重反推); help 补 A路(原创/改编,蓝图)与两路标注
// v1.8.4 2026-07-24  视频上传改有界并发(默认4路,压缩吃CPU+上传吃网络重叠,比串行快2-3倍);
//                    --concurrency N 调, =1 退回串行。断点续传/清单落盘不变。
// v1.8.3 2026-07-24  修压缩静默失败: resolveFfmpeg 探测 -encoders,优先选带 libx264 的
//                    ffmpeg(GPU-only 构建无 libx264 → "Unknown encoder" → 全部回退传原片)。
//                    都无 libx264 才退 nvenc/qsv/amf/mpeg4; 多加 BOTV 完整版为候选。
// v1.8.2 2026-07-14  修严重bug: --extra(洗稿指令)误当视频分析prompt传入,导致视频模型
//                    照洗稿指令分析(柚子被分析成西瓜),污染忠实反推。改为 extra 只进洗稿,
//                    视频分析纯忠实; 真需分析指引用 --analysis-note
// v1.8.1 2026-07-14  status 多读 /jobs 显示后台任务进度(反推/生成 running X%),修 video
//                    模式项目状态恒 draft 误判卡住; --watch 按 job 终态停
// v1.8.0 2026-07-14  上传前自动压到480p(有ffmpeg时,保留音轨,与服务端分析代理一致)
//                    ——反推只用低清代理,上传体积小一个数量级;--no-compress 关
// v1.7.0 2026-07-14  视频反推本地批量上传断点续传(传一个存一个,中断重跑同命令
//                    跳过已传只补未传), 解决大批量(几十集)上传被窗口杀后重传整季
// v1.6.0 2026-07-14  视频反推支持 --video-file 本地文件批量上传(走平台 signed-upload
//                    直传 R2, 与网页同通道), 与 --video-url 可混用
// v1.5.0 2026-07-14  新增 submit --mode video --video-url 视频反推(直调平台端点),带
//                    --market 反推完自动洗稿; 本地文件上传走网页
// v1.4.1 2026-07-14  continue 支持 --episodes N(续跑指定集数,如再跑5集)
// v1.4.0 2026-07-14  新增 continue 命令(首批暂停后续跑全量不重扣) + SKILL 硬规则
//                    绝不自己写剧本(换对话也先 projects 找项目 continue，不代写)
// v1.3.2 2026-07-14  去技术化: help 不再列模型选项, SKILL 硬规则不向用户显示模型
// v1.3.1 2026-07-14  credits 精简为一行（用户名 · 余额），去掉冻结/累计/集数估算
// v1.3.0 2026-07-13  新增 login --web 网页授权：浏览器登录真账号后授权命令行，
//                    CLI 以你的账号登录(项目归网页账号, KEY 作为账号属性自动跟过来)
// v1.2.0 2026-07-13  新增 sync 命令: 成品剧本同步到云端脚本库, 辰屿客户端可下载
//                    (CLI 与客户端用同一积分 KEY 时互通)
// v1.1.0 2026-07-13  KEY 自动免密登录(SSO)+401自动续登; fetch 选交付版正文
//                    并剥步骤元数据; help 文案更新
// v1.0.0 2026-07-12  首发: login/key/credits/estimate/submit/status/fetch/projects
// v2.3.0 2026-09-12  新增 video-analyze：视频分析是本 Skill 唯一消耗积分的功能。
//                    只分析不代写(不传 auto_start_workflow / 不设 auto_rewrite)，
//                    分析稿取回本地交给 Agent 自己写剧本(写作仍零积分)；
//                    跑前先报价(30分/240秒段)，--yes 才执行。
//                    Agent 自己能读懂视频时应自行分析，不调本命令。
// v2.3.1 2026-09-13  视频一律走平台反推：禁止 Agent 用抽音频/转写/抽帧代替(只有台词没画面,
//                    洗出剧本乱改动大)；移除"能读懂视频就自己分析"的引导口径。
const VERSION = '2.6.0';
// 每个请求都带上版本号：平台日志(nginx UA 列)据此看出客户在用哪一版、有没有人在用改包版。
const CLI_UA = `chenyu-pro-cli/${VERSION} node/${process.versions.node}`;

const CONFIG_DIR = path.join(os.homedir(), '.codex', 'chenyu-pro');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_PLATFORM = 'https://chenyu.pumpumai.com';
const DEFAULT_CREDIT_BASE = 'https://drama.pumpumai.com';

const MARKETS = {
  us_en: '英语·欧美', latam_es: '西语·拉美', brazil_pt: '葡语·巴西', japan_ja: '日本',
  korea_ko: '韩国', thailand_th: '泰国', vietnam_vi: '越南', indonesia_id: '印尼', cn_reskin: '中文换背景'
};

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const arg = (name, fallback = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const flag = (name) => args.includes('--' + name);

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
const mask = (v) => (v && v.length > 10 ? v.slice(0, 6) + '****' + v.slice(-4) : v ? '****' : '(未设置)');
const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };

// KEY 免密登录：积分 KEY → H1 一次性 SSO 票据 → 平台 session。绑了 KEY 的
// 用户不需要单独 chenyu-pro login；session 过期也走这里自动续登。
async function ssoLoginWithKey() {
  const cfg = loadConfig();
  const key = (cfg.credit_key || '').trim();
  if (!key) return false;
  try {
    const tk = await fetch((cfg.credit_base || DEFAULT_CREDIT_BASE) + '/api/v1/sso/ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': CLI_UA }
    }).then((r) => r.json());
    if (!tk?.ticket) return false;
    const login = await fetch((cfg.platform_base || DEFAULT_PLATFORM) + '/api/auth/sso-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA },
      body: JSON.stringify({ ticket: tk.ticket })
    }).then((r) => r.json());
    if (!login?.token) return false;
    cfg.session_token = login.token;
    cfg.username = login.user?.display_name || cfg.username || '';
    saveConfig(cfg);
    console.log('✓ 已用积分 KEY 自动登录平台: ' + (cfg.username || '(KEY 账号)'));
    return true;
  } catch { return false; }
}

async function api(pathName, { method = 'GET', body, auth = true, base, _retried = false } = {}) {
  let cfg = loadConfig();
  const url = (base || cfg.platform_base || DEFAULT_PLATFORM) + pathName;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': CLI_UA };
  if (auth) {
    if (!cfg.session_token) {
      const ok = await ssoLoginWithKey();
      if (!ok) die('未登录——绑定积分 KEY 后会自动免密登录（chenyu-pro key set <KEY>），或运行: chenyu-pro login --username <账号> --password <密码>');
      cfg = loadConfig();
    }
    headers.Authorization = 'Bearer ' + cfg.session_token;
  }
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) {
    // session 过期：用 KEY 自动续登一次再重试，仍不行才要求人工登录
    if (!_retried && await ssoLoginWithKey()) {
      return api(pathName, { method, body, auth, base, _retried: true });
    }
    die('登录已失效——绑定了 KEY 会自动续登（刚已尝试失败），请检查 KEY 或重新 chenyu-pro login');
  }
  if (!res.ok || data.ok === false || data.success === false) die(`${pathName} 失败(${res.status}): ${data.error || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function creditApi(pathName) {
  const cfg = loadConfig();
  const key = cfg.credit_key || '';
  if (!key) die('未绑定积分 KEY——先运行: chenyu-pro key set <你的KEY>');
  const res = await fetch((cfg.credit_base || DEFAULT_CREDIT_BASE) + pathName, { headers: { Authorization: 'Bearer ' + key, 'User-Agent': CLI_UA } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) die(`积分查询失败(${res.status}): ${data.error || ''}`);
  return data;
}

// ---------- 命令 ----------
// 登录后同步账号身份 + 账号名下的积分 KEY（KEY 是账号属性，登录真账号即带出）。
async function afterLogin(cfg, token, displayName) {
  cfg.platform_base = arg('base', cfg.platform_base || DEFAULT_PLATFORM);
  cfg.session_token = token;
  cfg.username = displayName || cfg.username || '';
  saveConfig(cfg);
  console.log(`✓ 已登录: ${cfg.username || '(账号)'} | 平台: ${cfg.platform_base}`);
  try {
    const me = await api('/api/auth/me');
    const remoteKey = me.settings?.pix_credit_key || me.settings?.credit_key || '';
    if (remoteKey) { cfg.credit_key = remoteKey; saveConfig(cfg); console.log('✓ 已带出账号名下积分 KEY: ' + mask(remoteKey)); }
  } catch { /* 可选步骤 */ }
}

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  try { exec(cmd); } catch { /* 打不开就让用户手动复制 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdLogin() {
  // 网页授权（推荐）：以你的真账号登录，项目归网页账号，KEY 自动带出。
  if (flag('web')) {
    const base = arg('base', loadConfig().platform_base || DEFAULT_PLATFORM);
    const start = await fetch(base + '/api/auth/cli/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA }, body: '{}' }).then((r) => r.json());
    if (!start?.device_code) die('发起网页授权失败，请重试或检查网络');
    console.log('请在浏览器用你的账号登录并点【确认授权】：');
    console.log('  ' + start.verify_url);
    console.log('  授权码: ' + start.user_code + '（页面已带上，无需手输）');
    openBrowser(start.verify_url);
    const deadline = Date.now() + (start.expires_in || 600) * 1000;
    process.stdout.write('等待网页授权');
    while (Date.now() < deadline) {
      await sleep((start.interval || 3) * 1000);
      process.stdout.write('.');
      const p = await fetch(base + '/api/auth/cli/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA }, body: JSON.stringify({ device_code: start.device_code }) }).then((r) => r.json()).catch(() => ({}));
      if (p.status === 'approved') { process.stdout.write('\n'); await afterLogin(loadConfig(), p.token, p.user?.display_name); return; }
      if (p.status === 'expired') { process.stdout.write('\n'); die('授权码已过期，请重新运行 chenyu-pro login --web'); }
    }
    process.stdout.write('\n'); die('等待授权超时，请重试');
    return;
  }
  const username = arg('username');
  const password = arg('password');
  if (!username || !password) die('用法: chenyu-pro login --web（浏览器授权，推荐）  或  chenyu-pro login --username <账号> --password <密码>');
  const data = await api('/api/auth/login', { method: 'POST', auth: false, body: { identifier: username, password } });
  await afterLogin(loadConfig(), data.token, data.user?.display_name || username);
}

async function cmdKey() {
  const sub = args[1];
  const cfg = loadConfig();
  if (sub === 'set') {
    const key = args[2] || '';
    if (!key.trim()) die('用法: chenyu-pro key set <积分KEY>');
    cfg.credit_key = key.trim();
    saveConfig(cfg);
    // 同步进平台账号 settings（服务端生成时用它计费）
    try { await api('/api/settings', { method: 'PATCH', body: { pix_credit_key: key.trim() } }); console.log('✓ KEY 已保存并同步到平台账号: ' + mask(key)); }
    catch { console.log('✓ KEY 已保存到本地: ' + mask(key) + '（平台同步失败，登录后重试 key set）'); }
  } else {
    console.log('积分 KEY: ' + mask(cfg.credit_key || ''));
  }
}

async function cmdCredits() {
  const data = await creditApi('/api/jimeng/v1/key');
  const k = data.key || {};
  const cfg = loadConfig();
  const who = cfg.username || k.name || '账号';
  console.log(`${who} · 余额 ${k.pointsBalance ?? '?'} 分`);
}

async function findProject(fragment) {
  const data = await api('/api/projects');
  const list = data.projects || [];
  const hit = list.find((p) => p.id.includes(fragment) || String(p.title || '').includes(fragment));
  if (!hit) die('找不到项目: ' + fragment);
  return hit;
}

async function cmdStatus() {
  const fragment = arg('project') || die('缺 --project <id片段或剧名>');
  const watch = flag('watch');
  for (;;) {
    const p = await findProject(fragment);
    // 关键：video_reverse 等模式下 project.status 一直停在 draft，真进度在后台 job 里。
    // 多调一次 /jobs 显示后台任务的 running/进度/消息（如“反推分析 EP6/53”），并据此判终止。
    let jobLine = '', jobTerminal = false;
    try {
      const jobs = (await api(`/api/projects/${p.id}/jobs`)).jobs || [];
      const active = jobs.find((j) => ['running', 'processing', 'queued', 'pending'].includes(String(j.status))) || jobs[0];
      if (active) {
        const st = String(active.status || '');
        jobTerminal = ['completed', 'failed', 'cancelled'].includes(st);
        const prog = (active.progress != null && active.progress !== '') ? ` ${active.progress}%` : '';
        const msg = String(active.message || active.error || '').replace(/\s+/g, ' ').trim().slice(0, 76);
        jobLine = ` | 后台:${st}${prog}${msg ? ' ' + msg : ''}`;
      }
    } catch { /* /jobs 可选，失败不影响主状态 */ }
    console.log(`[${new Date().toLocaleTimeString()}] ${p.title} | 状态:${p.status} | 步骤:${p.current_step || '-'} | 完成:${p.completed_episodes ?? 0}/${p.total_episodes}${jobLine}`);
    if (!watch || ['completed', 'failed'].includes(String(p.status)) || jobTerminal) {
      if (jobTerminal && String(p.mode) === 'video_reverse') console.log('  反推任务已结束。若提交时选了市场，洗稿项目已自动创建 → 用 chenyu-pro projects 查看。');
      break;
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

async function cmdFetch() {
  const fragment = arg('project') || die('缺 --project');
  const outDir = path.resolve(arg('out', './chenyu-pro-output'));
  const p = await findProject(fragment);
  // 用服务端归一化后的分集正文（标题回填 / 对白「说话人：“台词”」/ 紧凑排版 / 去空特效行），
  // 与平台云同步/导出同一格式；不再本地读原始产物、也不再本地剥元数据头。
  const eps = ((await api(`/api/projects/${p.id}/script-episodes`)).episodes || [])
    .filter((e) => String(e.content || '').trim());
  if (!eps.length) die('该项目还没有正文产物（未完成或未生成）');
  fs.mkdirSync(outDir, { recursive: true });
  const merged = [];
  for (const e of eps) {
    const content = String(e.content || '').trim();
    const pad = String(e.episode || '').padStart(3, '0');
    fs.writeFileSync(path.join(outDir, `第${pad}集正文.txt`), content, 'utf8');
    merged.push(content);
  }
  fs.writeFileSync(path.join(outDir, '全剧合并.txt'), merged.join('\n\n\n————————\n\n\n'), 'utf8');
  console.log(`✓ 已导出 ${eps.length} 集到 ${outDir}（含 全剧合并.txt，已按平台统一格式归一化）`);
}

async function cmdSync() {
  const fragment = arg('project') || die('缺 --project <id片段或剧名>');
  const p = await findProject(fragment);
  // 复用平台云同步端点：成品正文打成客户端剧本包传 H1 云端脚本库（按 KEY 隔离）。
  // CLI 与辰屿客户端用同一个积分 KEY 时，客户端"云端脚本"点刷新即可下载。
  const res = await api(`/api/projects/${p.id}/cloud-sync`, { method: 'POST', body: {} });
  console.log(`✓ 已同步到云端脚本库：《${p.title}》${res.episodes} 集`);
  console.log('  辰屿客户端"云端脚本"点刷新即可下载（需与 CLI 用同一积分 KEY）');
}

async function cmdProjects() {
  const data = await api('/api/projects');
  for (const p of (data.projects || []).slice(0, 15)) {
    console.log(`${p.id.slice(-12)}  ${String(p.status).padEnd(10)} ${p.completed_episodes ?? 0}/${p.total_episodes}集  ${p.title}`);
  }
}

// ---------- 格式门（v2.2.0）：确定性剧本质量校验，纯本地正则、零模型调用 ----------
// 解决的核心问题：对白连发段（连续多句台词之间没有动作行）转分镜后人物干站着
// 轮流念台词，成片生硬。规则全部确定性可数，Agent 写完循环过门直到 GATE_PASS。

const GATE_MENTAL_RE = /心想|心中[想道]|心里[想暗默]|暗想|暗自[想道]|内心[想os]|回忆起|想起了|感到|觉得/;
// 万能填充句（v2.3.2）：Agent 为凑 1:1 配比批量插的空洞△，不描述任何具体可拍动作。
const GATE_FILLER_RE = /话题继续推进|接住话头|抬眼回应|短暂停顿，另一方|对话继续|继续交谈|继续对话|气氛继续|场面继续|按画面同步|同步保留|原视频动作|原视频画面|参考原视频|见原视频|动作同上|同上动作|按原片|保留原动作/;
// △ 开头的时间码（[00:28-00:31] / 00:28-00:31）：剧本不写时间码；查重复前也要先剥掉，否则同一句占位话带不同时间码会逃过查重。
const GATE_TIMECODE_RE = /^\s*[\[【(（]?\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-~–—至到]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[\]】)）]?\s*/;
// 非△行的整片时间轴/源视频残留（v2.3.6）：`时长：X秒（按源视频）`、`【场景｜场景033】`流水号、行内 mm:ss-mm:ss——
// 这些是视频反推分析稿的中间态，不该出现在剧本。单SHOT时长"（时长3秒）"不含冒号时间，不误伤；场次头 1-1 也不匹配。
const GATE_TIMELEAK_RE = /\d{1,2}[:：]\d{2}\s*[-~–—至到]\s*\d{1,2}[:：]\d{2}|按源视频|场景\d{2,}/;
const isSceneHead = (l) => /^\d+-\d+\s+\S/.test(l);
const isEpTitle = (l) => /^第\d+集/.test(l);
const isActionLine = (l) => l.startsWith('△') || l.startsWith('▲');
const isMetaLine = (l) => /^【(画面|运镜|音效|字幕|转场|特效)】/.test(l);
// 场次人物行：`人物：苏燃、周母`。列出本场出场人物，不是台词。
const isCharacterListLine = (l) => /^人物\s*[:：]/.test(l);
// 画面/镜头描述块：`（画面：…）`、`（镜头：…）`、`（环境：…）`、`（转场：…）`。整行括号，给下游/读者的画面提示，不是台词。
const isPictureLine = (l) => /^[（(]\s*(画面|镜头|环境|转场|字幕|旁白)\s*[:：]/.test(l);
const matchDialogue = (l) => {
  if (isActionLine(l) || isMetaLine(l) || isSceneHead(l) || isEpTitle(l) || isCharacterListLine(l) || isPictureLine(l)) return null;
  const m = l.match(/^([^\s：:△▲【\d][^：:]{0,9})(（[^）]*）|\([^)]*\))?[：:](.+)$/);
  return m ? { speaker: m[1].trim(), note: (m[2] || '').trim(), body: m[3].trim() } : null;
};

// ---------- 形象变体（v2.6.0）----------
// 每场开头一行「【形象】角色=变体名；角色=变体名」，场内换装在换装△后再写一行；形象跟上一场不同时括号注明原因：
//   【形象】苏燃=外出便装（回房换上外套）
// 变体名必须具体（下游客户端建卡用 [角色-变体名] 标签，拒收"主形象/日常/默认"这类泛称）。
// 规则来自出片事故：瞬时状态（淋湿/衣服被扯乱）不是变体；围裙/首饰/眼镜这类叠加小件记道具不建变体；
// 同一场同一人只有一个形象，除非有可见的换装△。
const isVariantLine = (l) => /^【形象】/.test(l);
const VARIANT_PLACEHOLDER_RE = /^(?:基础形象|基本形象|默认形象|主形象|默认|主状态|基础|日常|日常装|日常服|常服|常态|常规|初始|初始形象|原样|同上|不变|default|base|basic)$/iu;
const VOICE_ONLY_NOTE_RE = /画外音|电话|OS|旁白|VO|广播|心声|内心/i;
// 场内换形象要有可见的换装/受伤类动作，且△里写到这个人
const VARIANT_CHANGE_ACTION_RE = /换|穿|脱|披|套上|系上|解开|解下|扯下|摘下|戴上|包扎|缠上|剪|剃|染|卸妆|化妆|淋湿|溅|受伤|流血|撕破|撕开|更衣|裹上/;
function parseVariantLine(l) {
  const entries = [], problems = [];
  const body = l.replace(/^【形象】\s*/, '').trim();
  if (!body) { problems.push('【形象】后面是空的'); return { entries, problems }; }
  // 多人之间用 ；分隔，也容忍 ，、——只在后面紧跟「名字=」时才当分隔符，原因括号里的逗号不受影响
  for (const raw of body.split(/[；;，,、](?=[^=＝:：（(；;，,、）)]{1,12}[=＝:：])/).map((x) => x.trim()).filter(Boolean)) {
    const m = raw.match(/^([^=＝:：（(]+?)\s*[=＝:：]\s*([^（(]+?)\s*(?:[（(]([^）)]*)[）)])?$/);
    if (!m) { problems.push(`「${raw}」写法不对，应为「角色=变体名」或「角色=变体名（变化原因）」，多人用；分隔`); continue; }
    const [, name, variant, cause] = m.map((x) => (x || '').trim());
    if (VARIANT_PLACEHOLDER_RE.test(variant)) problems.push(`「${name}=${variant}」变体名太笼统——写具体外观（如 居家睡衣/黑色厨师服/额头包扎），下游建卡拒收"主形象/日常/默认"`);
    else if (/[-－—\[\]【】]/.test(variant)) problems.push(`「${name}=${variant}」变体名里不要有 - 或括号（下游标签是 [角色-变体名]）`);
    else if (variant.length > 10) problems.push(`「${name}=${variant}」变体名超过10字——变体名要短，外观细节写进形象变体表`);
    entries.push({ name, variant, cause });
  }
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.name) && seen.get(e.name) !== e.variant) problems.push(`同一行里「${e.name}」写了两个形象（${seen.get(e.name)} / ${e.variant}）——同一时刻一人只有一个形象`);
    seen.set(e.name, e.variant);
  }
  return { entries, problems };
}
// 形象变体表（Agent 交付的资产表之一）：markdown 表格，第一列=角色。
// 变体名列按表头「变体名」定位（合集/variants 命令的表是 角色|变体数|变体名|…，变体名在第3列；
// 手写表可能是 角色|变体名|…，在第2列）。找不到表头就默认第2列，并跳过纯数字（变体数列）。
function parseVariantTable(text) {
  const table = new Map();
  let variantCol = 1;
  for (const line of String(text || '').split(/\r?\n/)) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    if (cells.length < 2) continue;
    if (/^角色/.test(cells[0])) {
      const idx = cells.findIndex((c) => /变体名|形象名/.test(c) || c === '变体' || c === '形象');
      if (idx > 0) variantCol = idx;
      continue;
    }
    if (!cells[0] || /^[-:\s]+$/.test(cells[0])) continue;
    const variant = cells[variantCol] || cells[1];
    if (!variant || /^\d+$/.test(variant)) continue; // 跳过纯数字（变体数列）
    if (!table.has(cells[0])) table.set(cells[0], new Set());
    table.get(cells[0]).add(variant);
  }
  return table;
}
// 逐场检查形象标记；ctx 跨集延续（gate --dir 按集号顺序共用一个 ctx）。只在剧本用了【形象】时启用，旧剧本不受影响。
function checkVariants(rawLines, ctx, errors, warnings) {
  const used = rawLines.some((l) => isVariantLine(l.trim()));
  if (!used && !ctx.required) return 0;
  let scene = null;
  let marks = 0;
  const closeScene = () => {
    if (!scene) return;
    if (scene.speakers.size && !scene.hasMark) warnings.push(`场景「${scene.head}」（第${scene.line}行）没有【形象】行——出场人物要标当前形象`);
    else {
      const missing = [...scene.speakers].filter((n) => !scene.declared.has(n) && !ctx.aliases?.has(n));
      if (missing.length) warnings.push(`场景「${scene.head}」（第${scene.line}行）${missing.join('、')} 说了话但【形象】里没标——补上当前形象`);
    }
  };
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i].trim();
    const ln = i + 1;
    if (!l) continue;
    if (isSceneHead(l)) {
      closeScene();
      scene = { head: l, line: ln, hasMark: false, declared: new Map(), speakers: new Set(), actionsSinceMark: [] };
      continue;
    }
    if (!scene) scene = { head: '（第一场之前）', line: ln, hasMark: false, declared: new Map(), speakers: new Set(), actionsSinceMark: [] };
    if (isActionLine(l)) { scene.actionsSinceMark.push(l); continue; }
    if (isVariantLine(l)) {
      marks++;
      const { entries, problems } = parseVariantLine(l);
      for (const pb of problems) errors.push(`第${ln}行 ${pb}`);
      const midScene = scene.hasMark;
      for (const e of entries) {
        const before = scene.declared.get(e.name) || ctx.last.get(e.name)?.variant;
        if (before && before !== e.variant) {
          if (midScene && scene.declared.has(e.name) && !scene.actionsSinceMark.some((a) => a.includes(e.name) && VARIANT_CHANGE_ACTION_RE.test(a))) {
            warnings.push(`第${ln}行 「${e.name}」同一场里从「${before}」变成「${e.variant}」，但前面没有换装的△——先写可见的换装动作`);
          }
          if (!e.cause) warnings.push(`第${ln}行 「${e.name}」形象从「${before}」变成「${e.variant}」没注明原因——写成「${e.name}=${e.variant}（换装/受伤/时间跳跃等原因）」；如果其实没变，沿用「${before}」`);
        }
        if (ctx.table && !(ctx.table.get(e.name)?.has(e.variant))) {
          warnings.push(`第${ln}行 「${e.name}=${e.variant}」不在形象变体表里——变体名要和表里一字不差（防止同一形象多个叫法），或把新变体补进表`);
        }
        scene.declared.set(e.name, e.variant);
        ctx.last.set(e.name, { variant: e.variant });
        ctx.usage.push({ episode: ctx.episode, scene: scene.head.split(/\s+/)[0], name: e.name, variant: e.variant, cause: e.cause, changed: Boolean(before && before !== e.variant) });
      }
      scene.hasMark = true;
      scene.actionsSinceMark = [];
      continue;
    }
    const d = matchDialogue(l);
    if (d && !VOICE_ONLY_NOTE_RE.test(`${d.speaker}${d.note}`)) scene.speakers.add(d.speaker.replace(/[（(][^）)]*[）)]/g, '').trim());
  }
  closeScene();
  return marks;
}

// 校验一份正文，返回 { errors: [], warnings: [], stats: {} }。行号从 1 开始。
function gateOneScript(text, ctx = newVariantContext()) {
  const rawLines = String(text).split(/\r?\n/);
  const errors = [], warnings = [];
  let dlgCount = 0, actCount = 0, silentBurstStart = -1;
  let run = [];                 // 当前连续台词行 [{ line, speaker }]
  const flushRun = () => {
    if (run.length >= 3) {
      const from = run[0].line, to = run[run.length - 1].line;
      const speakers = [...new Set(run.map(r => r.speaker))];
      // 补写位置：连发段中间（第 2 句台词之后）
      const insertAfter = run[1].line;
      errors.push(`第${from}-${to}行 对白连发段（连续${run.length}句台词无△动作行，说话人:${speakers.join('/')}）→ 在第${insertAfter}行后插入一行△（听者可见反应 或 说话人伴随动作）`);
    }
    run = [];
  };
  let narrativeCount = 0;   // 既非台词/△/元信息/场次头的叙述行（小说识别用）
  let inSceneIntro = false;  // 是否处在"场次头之后、首个△/台词之前"（环境描述行允许区）
  const actionSeen = new Map(); // △正文 → 出现行号（重复△检测）
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i].trim();
    const ln = i + 1;
    if (!l) continue;
    if (!isActionLine(l) && GATE_TIMELEAK_RE.test(l)) errors.push(`第${ln}行 残留整片时间轴/源视频标记（${(l.match(GATE_TIMELEAK_RE) || [''])[0]}）→ 删掉"按源视频"整片时长/"场景0XX"流水号/绝对时间轴；场景写真实地名，要时长只留单SHOT（时长3秒）`);
    if (isActionLine(l)) {
      flushRun();
      inSceneIntro = false;
      actCount++;
      const body = l.slice(1).trim();
      if (GATE_MENTAL_RE.test(body)) errors.push(`第${ln}行 △写了心理活动（${(body.match(GATE_MENTAL_RE) || [''])[0]}）→ △只写可见的外部动作与神态，把心理翻译成身体反应`);
      if (GATE_TIMECODE_RE.test(body)) errors.push(`第${ln}行 △里写了时间码（${(body.match(GATE_TIMECODE_RE) || [''])[0].trim()}）→ 剧本不写时间码，删掉，直接写可见动作`);
      if (GATE_FILLER_RE.test(body)) errors.push(`第${ln}行 △是万能填充句/占位话（${(body.match(GATE_FILLER_RE) || [''])[0]}）→ 写该时刻具体谁做了什么可见动作（分析表 visible_action 那一列就是素材），不要用空话占位`);
      const key = body.replace(GATE_TIMECODE_RE, '').replace(/[。．.！!？?，,；;\s]+$/u, '');
      if (!actionSeen.has(key)) actionSeen.set(key, []);
      actionSeen.get(key).push(ln);
      if (body.length < 6) warnings.push(`第${ln}行 △太短（${body.length}字）——动作要具体可拍`);
      if (body.length > 60) warnings.push(`第${ln}行 △太长（${body.length}字）——一行一件事，拆开`);
      continue;
    }
    // 人物行、画面/镜头描述块：合法结构行，放行不计叙述。
    if (isCharacterListLine(l) || isPictureLine(l)) { flushRun(); continue; }
    if (isMetaLine(l) || isVariantLine(l) || isSceneHead(l) || isEpTitle(l)) { flushRun(); if (isSceneHead(l)) inSceneIntro = true; continue; }
    const d = matchDialogue(l);
    if (d) {
      dlgCount++;
      inSceneIntro = false;
      run.push({ line: ln, speaker: d.speaker });
      if (d.body.length > 40) warnings.push(`第${ln}行 台词超长（${d.body.length}字）——超过40字的台词转分镜会被硬拆，建议按句号拆成两句`);
      continue;
    }
    flushRun(); // 其他叙述行也算隔断
    // 场次头之后、第一个△动作/台词之前的纯文字行 = 环境/画面描述，合法（不计叙述、不触发"这是小说"）。
    if (inSceneIntro) continue;
    narrativeCount++;
  }
  flushRun();
  // 小说/散文识别：绝大部分是叙述行、几乎没有剧本结构 → 这是源材料不是剧本，
  // 逐条打补丁方向就错了，应整体改编成剧本格式后再过门。
  const structured = dlgCount + actCount;
  if (narrativeCount >= 30 && structured < narrativeCount * 0.25 && !rawLines.some(l => isSceneHead(l.trim()))) {
    return {
      errors: [`这份文本是小说/散文源材料（叙述行${narrativeCount}行，剧本结构行仅${structured}行），不是剧本——不要按下面的行号打补丁，请先把它改编成剧本格式（场次头 + △动作行 + 「角色名：台词」），改编稿再过门`],
      warnings: [],
      stats: { dialogue: dlgCount, action: actCount }
    };
  }
  // 重复△：把视频分析表同一行的 visible_action 复制到每句台词前凑配比，成片动作全是同一句。
  for (const [key, lines] of actionSeen) {
    if (lines.length < 2) continue;
    const msg = `第${lines.join('/')}行 △重复同一句（${key.slice(0, 24)}${key.length > 24 ? '…' : ''}）→ 每处△要写该时刻不同的具体动作/反应；分析表里一句概括只能用一次，拆成不同动作节拍`;
    if (key.length >= 10 || lines.length >= 3) errors.push(msg);
    else warnings.push(msg);
  }
  if (dlgCount === 0) errors.push('没有解析到任何台词行——检查格式：台词行应为「角色名：台词」');
  if (dlgCount > 0 && actCount === 0) errors.push('全篇没有一行△动作行——每句台词前后应有可见动作/反应（目标配比约1:1）');
  else if (dlgCount > 0 && dlgCount / Math.max(actCount, 1) > 2) warnings.push(`对白:动作 = ${dlgCount}:${actCount}（超过2:1）——目标约1:1，多补△（听者反应/说话人动作）`);
  const hasScene = rawLines.some(l => isSceneHead(l.trim()));
  if (!hasScene) warnings.push('没有场次头（如「1-1 面馆后厨 白天 室内」）——建议每场开头标场景/时间/内外');
  const variantMarks = checkVariants(rawLines, ctx, errors, warnings);
  return { errors, warnings, stats: { dialogue: dlgCount, action: actCount, variantMarks } };
}

function newVariantContext(table = null) {
  return { last: new Map(), usage: [], table, episode: 0, required: false };
}
const episodeNoOfFile = (name) => Number((String(name).match(/第\s*0*(\d+)\s*集/) || String(name).match(/EP\s*0*(\d+)/i) || [])[1] || 0);
// 目录里的剧本按集号排序（跨集形象延续要按顺序查）；形象变体表 / 汇总文件本身不当剧本查。
function listScriptFiles(d) {
  return fs.readdirSync(d)
    .filter((name) => /\.(txt|md)$/i.test(name) && !/形象变体|资产表/.test(name))
    .map((name) => path.join(d, name))
    .sort((a, b) => (episodeNoOfFile(path.basename(a)) - episodeNoOfFile(path.basename(b))) || a.localeCompare(b));
}
function loadVariantTable(dir) {
  const explicit = arg('variants', '');
  const candidates = explicit ? [path.resolve(explicit)] : (dir ? fs.readdirSync(dir).filter((n) => /形象变体表/.test(n) && !/汇总/.test(n)).map((n) => path.join(dir, n)) : []);
  for (const file of candidates) {
    if (!fs.existsSync(file)) die('形象变体表不存在: ' + file);
    const table = parseVariantTable(fs.readFileSync(file, 'utf8'));
    if (table.size) return { table, file };
  }
  return { table: null, file: '' };
}
// 从正文【形象】标记汇总「每个角色几个变体、分别出现在哪几集哪几场、因何而变」。
function summarizeVariantUsage(usage) {
  const byRole = new Map();
  for (const u of usage) {
    if (!byRole.has(u.name)) byRole.set(u.name, new Map());
    const variants = byRole.get(u.name);
    if (!variants.has(u.variant)) variants.set(u.variant, { places: [], episodes: new Set(), causes: [] });
    const v = variants.get(u.variant);
    const place = u.episode ? `${u.episode}集${u.scene ? ' ' + u.scene : ''}` : u.scene;
    if (!v.places.includes(place)) v.places.push(place);
    if (u.episode) v.episodes.add(u.episode);
    if (u.changed && u.cause && !v.causes.includes(u.cause)) v.causes.push(u.cause);
  }
  const lines = ['# 形象变体表（按正文【形象】标记自动汇总）', '', '| 角色 | 变体数 | 变体名 | 出现集 | 出现场次 | 变化原因 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const [name, variants] of byRole) {
    for (const [variant, v] of variants) {
      const eps = [...v.episodes].sort((a, b) => a - b);
      const ranges = [];
      for (const e of eps) {
        const last = ranges[ranges.length - 1];
        if (last && e === last[1] + 1) last[1] = e; else ranges.push([e, e]);
      }
      const epText = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join('、') || '-';
      lines.push(`| ${name} | ${variants.size} | ${variant} | ${epText} | ${v.places.join('、')} | ${v.causes.join('；') || '-'} |`);
    }
  }
  return { byRole, markdown: lines.join('\n') + '\n' };
}

// gate 命令：--file 单文件 / --dir 目录批量(.txt/.md)。跑门前仅做鉴权（不扣积分）。
// 输出 GATE_PASS / GATE_FAIL(exit 1)。--no-auth 供离线自查（Agent 正式交付前仍须 auth）。
// variants 命令：从正文【形象】标记汇总形象变体表（每个角色几个变体、出现在哪几集哪几场、因何而变），零积分、纯本地。
async function cmdVariants() {
  const dir = arg('dir', '') || die('用法: chenyu-pro variants --dir <剧本目录> [--out 形象变体汇总.md]');
  const d = path.resolve(dir);
  if (!fs.existsSync(d)) die('目录不存在: ' + d);
  const files = listScriptFiles(d);
  if (!files.length) die('目录里没有 .txt/.md 剧本文件');
  const ctx = newVariantContext();
  for (const f of files) {
    ctx.episode = episodeNoOfFile(path.basename(f));
    checkVariants(String(fs.readFileSync(f, 'utf8')).split(/\r?\n/), ctx, [], []);
  }
  if (!ctx.usage.length) die('正文里没有【形象】标记——先按写作规范每场标出场人物形象');
  const { byRole, markdown } = summarizeVariantUsage(ctx.usage);
  const out = path.resolve(arg('out', path.join(d, '形象变体汇总.md')));
  fs.writeFileSync(out, markdown, 'utf8');
  for (const [name, variants] of byRole) console.log(`  ${name}：${variants.size} 个形象（${[...variants.keys()].join(' / ')}）`);
  console.log(`✓ 已汇总 ${byRole.size} 个角色的形象变体 -> ${out}`);
}

async function cmdGate() {
  if (!flag('no-auth')) await api('/api/auth/me');
  const file = arg('file', '');
  const dir = arg('dir', '');
  const targets = [];
  if (file) targets.push(path.resolve(file));
  else if (dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(d)) die('目录不存在: ' + d);
    targets.push(...listScriptFiles(d));
    if (!targets.length) die('目录里没有 .txt/.md 剧本文件');
  } else die('用法: chenyu-pro gate --file 剧本.txt  或  chenyu-pro gate --dir <目录>');
  const { table, file: tableFile } = loadVariantTable(dir ? path.resolve(dir) : '');
  if (tableFile) console.log(`（按形象变体表核对变体名：${path.basename(tableFile)}）`);
  const ctx = newVariantContext(table);
  let totalErr = 0, totalWarn = 0;
  for (const t of targets) {
    if (!fs.existsSync(t)) die('文件不存在: ' + t);
    ctx.episode = episodeNoOfFile(path.basename(t));
    const { errors, warnings, stats } = gateOneScript(fs.readFileSync(t, 'utf8'), ctx);
    const name = path.basename(t);
    console.log(`── ${name}  台词${stats.dialogue}句 / 动作${stats.action}行${stats.variantMarks ? ` / 形象标记${stats.variantMarks}行` : ''}`);
    for (const e of errors) console.log('  ✗ ' + e);
    for (const w of warnings) console.log('  ⚠ ' + w);
    if (!errors.length && !warnings.length) console.log('  ✓ 无问题');
    totalErr += errors.length; totalWarn += warnings.length;
  }
  if (totalErr > 0) { console.log(`GATE_FAIL 硬伤${totalErr}处 警告${totalWarn}处 —— 按上面逐条修改后重跑 gate`); process.exit(1); }
  console.log(`GATE_PASS${totalWarn ? ' （警告' + totalWarn + '处，建议顺手改）' : ''}`);
}

// ---------- Agent 写作模式（v2.0.0）：平台只做鉴权，写作由用户 Agent 完成，零积分 ----------

// 鉴权门：Agent 动笔写剧本之前必须先跑本命令并拿到 AUTH_OK。
// 只校验平台登录态（未登录会自动尝试 KEY 免密续登）；不查余额、不扣任何积分。
// 退出码 0 = 通过；非 0 = 未通过（Agent 必须拒绝写作并引导用户登录）。
async function cmdAuth() {
  const me = await api('/api/auth/me');
  const who = me.user?.display_name || me.user?.identifier || loadConfig().username || '(账号)';
  console.log('AUTH_OK ' + who);
}

// 建项目壳（零积分）：只创建平台项目用于归档与交付，绝不调用 start-auto，
// 平台服务端不会跑任何生成工作流、不会扣一分积分。正文由 Agent 写完后用 save 回传。
async function cmdCreate() {
  const title = arg('title') || die('缺 --title 剧名');
  const episodes = Number(arg('episodes', '30'));
  const market = arg('market', '');
  if (market && !MARKETS[market]) die('未知市场: ' + market + '，可选: ' + Object.keys(MARKETS).join('/'));
  const duration = Number(arg('duration', '90'));
  const body = {
    title, working_title: title,
    mode: 'original',
    total_episodes: episodes, batch_episodes: episodes,
    quality_tier: 'strong_review',
    episode_duration_seconds: duration,
    config: {
      genre: arg('genre', market ? MARKETS[market] : '短剧'),
      audience: arg('audience', '待确认'),
      production_format: '真人剧', source_type: 'source_text',
      model_strategy: 'balanced', research_window_days: 30,
      episode_duration_seconds: duration,
      config_json: {
        created_from: 'chenyu-pro-cli-agent',
        authoring: 'agent',            // 标记：正文由用户 Agent 写作，非平台生成
        ...(market ? { market } : {})
      }
    }
  };
  const created = await api('/api/projects', { method: 'POST', body });
  const pid = created.project.id;
  console.log('✓ 项目壳已创建（Agent 写作模式，零积分）: ' + pid);
  console.log(`下一步: 你(Agent)按 SKILL 写作规范逐集写正文 → chenyu-pro save --project ${pid.slice(-8)} --episode 1 --file 第001集.txt`);
}

// 回传 Agent 写的正文：按平台 A15 正文产物契约入库（step_id=A15 / title 含"正文" /
// episode=集号），入库后 fetch / sync / word / download-full 等交付链路直接可用。
// 单集: --episode N --file 正文.txt   批量: --dir 目录(文件名须含 第N集)
async function cmdSave() {
  const fragment = arg('project') || die('缺 --project <id片段或剧名>');
  const p = await findProject(fragment);
  const dir = arg('dir', '');
  const items = [];
  if (dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(d)) die('目录不存在: ' + d);
    for (const name of fs.readdirSync(d)) {
      const m = name.match(/第(\d+)集/);
      if (!m || !/\.(txt|md)$/i.test(name)) continue;
      items.push({ ep: Number(m[1]), file: path.join(d, name) });
    }
    if (!items.length) die('目录里没有文件名含「第N集」的 .txt/.md 正文文件');
    items.sort((a, b) => a.ep - b.ep);
  } else {
    const ep = Number(arg('episode', '')) || die('缺 --episode <集号>（或用 --dir 批量）');
    const file = arg('file') || die('缺 --file <正文.txt>');
    items.push({ ep, file: path.resolve(file) });
  }
  for (const it of items) {
    if (!fs.existsSync(it.file)) die('正文文件不存在: ' + it.file);
    const content = fs.readFileSync(it.file, 'utf8');
    if (content.trim().length < 50) die(`正文太短(${it.file})——不像一集剧本`);
    if (!flag('skip-gate')) {
      const g = gateOneScript(content);
      if (g.errors.length) {
        for (const e of g.errors) console.log('  ✗ ' + e);
        die(`${path.basename(it.file)} 未过格式门（${g.errors.length}处硬伤）——修完重跑，或 --skip-gate 强制入库`);
      }
    }
    const pad = String(it.ep).padStart(3, '0');
    const epTitle = arg('title', '');
    await api(`/api/projects/${p.id}/files`, {
      method: 'POST',
      body: {
        filename: `第${pad}集正文.md`,
        title: epTitle ? `第${pad}集正文 ${epTitle}` : `第${pad}集正文`,
        type: 'markdown',
        step_id: 'A15',
        episode: it.ep,
        content
      }
    });
    console.log(`  ✓ 第${pad}集正文已入库 (${content.length} 字)`);
  }
  console.log(`✓ 共回传 ${items.length} 集到《${p.title}》。交付: chenyu-pro fetch --project ${p.id.slice(-8)} --out <目录>  或  chenyu-pro sync --project ${p.id.slice(-8)}`);
}

// ---------- 视频分析：本 Skill 唯一消耗平台积分的功能 ----------
// 边界：平台只做「视频 → 分析稿」，绝不触发平台代写——不传 auto_start_workflow、
// 不设 auto_rewrite。分析稿取回本地后由你(Agent)自己写剧本，写作零积分。
// 视频一律走本命令做平台反推（画面+声音）；禁止 Agent 用抽音频/转写/抽帧代替，
// 只有台词没有画面动作，洗出的剧本乱、改动大（2026-09-13 用户实测反馈）。
const VIDEO_MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v', '.ts': 'video/mp2t' };
// 上传前压缩到低清分析代理：服务端视频反推只需看清人物/动作/服装，不需要原始高码率。
// 有 ffmpeg 就先压到 proxyHeight（默认720p，保留音轨供台词/声音识别），上传体积小、超时概率低；
// 没有 ffmpeg 或压缩失败就传原片。压缩不改视频时长，计费按秒数不变——这一步只省上传带宽，不省积分。
function resolveFfmpeg() {
  const cands = [process.env.CHENYU_FFMPEG, 'ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg-6.1.1\\bin\\ffmpeg.exe'].filter(Boolean);
  for (const c of cands) {
    try { const r = spawnSync(c, ['-version'], { windowsHide: true }); if (r.status === 0) return c; } catch { /* 下一个候选 */ }
  }
  return null;
}
function compressVideoProxy(ffmpeg, src, dst, height) {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    const a = ['-y', '-i', src, '-vf', `scale=-2:${height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst];
    const child = spawn(ffmpeg, a, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => { (code === 0 && fs.existsSync(dst)) ? resolve() : reject(new Error(`ffmpeg 压缩失败(${code})`)); });
  });
}
const guessVideoMime = (n) => VIDEO_MIME[path.extname(n).toLowerCase()] || 'video/mp4';
const SEGMENT_SECONDS = 240;    // 平台按 240 秒切段（不足一段按一段算）
const POINTS_PER_SEGMENT = 30;  // 每段 30 积分

function probeDurationSeconds(file) {
  const cands = [process.env.CHENYU_FFPROBE, 'ffprobe', 'C:\\ffmpeg\\bin\\ffprobe.exe', 'E:\\pump2.0\\BOTV\\FFPROBE.EXE'].filter(Boolean);
  for (const bin of cands) {
    try {
      const r = spawnSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { windowsHide: true, encoding: 'utf8' });
      if (r.status === 0) { const d = Number(String(r.stdout || '').trim()); if (d > 0) return d; }
    } catch { /* 试下一个候选 */ }
  }
  return 0;
}

// 查余额但不中断流程（用于对比实际扣除），取不到返回 null。
async function pointsBalanceSafe() {
  try {
    const cfg = loadConfig();
    if (!cfg.credit_key) return null;
    const res = await fetch((cfg.credit_base || DEFAULT_CREDIT_BASE) + '/api/jimeng/v1/key', { headers: { Authorization: 'Bearer ' + cfg.credit_key, 'User-Agent': CLI_UA } });
    const n = Number((await res.json().catch(() => ({})))?.key?.pointsBalance);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// 从文件名取集号：第34集.mp4 / EP34 / E034 / 34.mp4 / 某剧-34.mp4；取不到返回 0。
function episodeNumberFromName(name) {
  const base = path.basename(String(name || ''), path.extname(String(name || '')));
  const match = base.match(/第\s*0*(\d{1,4})\s*[集话話]/)
    || base.match(/(?:^|[^a-z])(?:ep|e)[\s_-]*0*(\d{1,4})(?!\d)/i)
    || base.match(/^0*(\d{1,4})(?!\d)/)
    || base.match(/[\s_\-·.]0*(\d{1,3})$/);
  const n = match ? Number(match[1]) : 0;
  return n > 0 && n < 2000 ? n : 0;
}
const episodeIdOf = (n) => 'EP' + String(n).padStart(3, '0');

async function fetchArtifactText(a) {
  let content = String(a.content || '');
  if (!content) {
    try { content = String((await api(`/api/artifacts/${a.id}/content`)).content || ''); } catch { /* 取不到按空处理 */ }
  }
  return content;
}

// 取回项目最新分析稿到本地 + 逐段检查分析质量（每段只看最新版本）。零积分。
async function downloadVideoAnalysis(pid, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const arts = (await api(`/api/projects/${pid}/artifacts`)).artifacts || [];
  // 全剧合集是洗稿主用文件（剧集索引+人物/场景/道具资产表+事件表+逐集分析表），其余为备查。
  const want = ['video_reverse_全剧合集.md', 'video_reverse_source.md', 'video_reverse_replay_script.md', 'episode_index.json', 'identity_registry.json', 'character_variants.json'];
  let got = 0;
  const written = new Set();
  // 产物列表按更新时间倒序：同名文件只取第一个（最新版），平台修复或追加分析后旧版本不会覆盖新版本。
  for (const a of arts) {
    const fn = String(a.filename || a.title || '');
    if (!want.includes(fn) || written.has(fn)) continue;
    const content = await fetchArtifactText(a);
    if (!content.trim()) continue;
    fs.writeFileSync(path.join(outDir, fn), content, 'utf8');
    written.add(fn);
    got += 1;
  }
  // 逐段查分析质量（每段只看最新版本）：残缺稿必须拦在 Agent 写作之前。
  const badSegments = [];
  const checked = new Set();
  for (const a of arts) {
    const fn = String(a.filename || a.title || '');
    if (!/^video_reverse_segment_.+\.json$/.test(fn) || checked.has(fn)) continue;
    checked.add(fn);
    try {
      const seg = JSON.parse(await fetchArtifactText(a));
      const rows = Array.isArray(seg.shot_rows) ? seg.shot_rows.length : 0;
      const flags = Array.isArray(seg.quality_flags) ? seg.quality_flags : [];
      if (!rows || flags.length) badSegments.push(`${seg.segment?.segment_id || fn}（镜头表${rows}行${flags.length ? '，' + String(flags[0]).slice(0, 40) : ''}）`);
    } catch { /* 取不到单段文件不影响主流程 */ }
  }
  return { got, badSegments };
}

// 零积分：重新取回某个项目最新的分析稿（平台修复、追加分析后用这个取，不要重新提交视频）。
async function cmdVideoFetch() {
  const fragment = arg('project') || die('缺 --project <id片段或剧名>');
  const target = await findProject(fragment);
  if (target.mode && target.mode !== 'video_reverse') die(`项目《${target.title}》不是视频分析项目`);
  const jobs = (await api(`/api/projects/${target.id}/jobs`)).jobs || [];
  const running = jobs.find((j) => /video_reverse/.test(String(j.job_type || j.type || '')) && ['queued', 'running'].includes(String(j.status || '')));
  if (running) die(`项目《${target.title}》的分析稿正在处理（${running.message || running.status}），完成后再取`);
  const outDir = path.resolve(arg('out', './chenyu-video-analysis'));
  const { got, badSegments } = await downloadVideoAnalysis(target.id, outDir);
  if (!got) die(`项目《${target.title}》还没有分析稿`);
  console.log(`✓ 已取回《${target.title}》最新分析稿 ${got} 个文件 -> ${outDir}（零积分）`);
  if (badSegments.length) {
    console.log(`⛔ 以下段分析稿仍不完整：\n  ${badSegments.join('\n  ')}\n  这几集先不要写，原样告诉用户，由平台核实处理；不要重新提交整批视频（会重复扣分）。`);
  } else {
    console.log('✓ 各段分析稿完整，可以开始写作（先读 video_reverse_全剧合集.md）。');
  }
}

async function cmdVideoAnalyze() {
  const files = arg('video-file', '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
  const urls = arg('video-url', '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (!files.length && !urls.length) die('缺 --video-file <本地.mp4> 或 --video-url <链接>（多个用英文逗号分隔，可混用）');
  for (const f of files) if (!fs.existsSync(f)) die('视频文件不存在: ' + f);

  // ⓪ 同一部剧只用一个项目：--project 追加到已有项目；集号按文件名。
  const projectFragment = arg('project', '');
  let target = null;
  let existingEpisodes = [];
  if (projectFragment) {
    target = await findProject(projectFragment);
    if (target.mode && target.mode !== 'video_reverse') die(`项目《${target.title}》不是视频分析项目，不能追加视频`);
    const jobs = (await api(`/api/projects/${target.id}/jobs`)).jobs || [];
    if (jobs.some((j) => String(j.job_type || j.type || '') === 'video_reverse_analysis' && ['queued', 'running'].includes(String(j.status || '')))) {
      die(`项目《${target.title}》正在分析上一批，等它结束再追加（同一部剧不要并发提交）`);
    }
    const arts = (await api(`/api/projects/${target.id}/artifacts`)).artifacts || [];
    const indexArt = arts.find((a) => String(a.filename || a.title || '') === 'episode_index.json');
    if (indexArt) {
      try { existingEpisodes = (JSON.parse(await fetchArtifactText(indexArt)).episodes || []).map((e) => String(e.episode_id || '')).filter(Boolean); } catch { /* 读不到按空 */ }
    }
  }
  const parsedNumbers = files.map((f) => episodeNumberFromName(f));
  const useFileNumbers = files.length > 0 && parsedNumbers.every((n) => n > 0) && new Set(parsedNumbers).size === parsedNumbers.length;
  const existingMax = existingEpisodes.reduce((max, id) => Math.max(max, Number(String(id).replace(/\D/g, '')) || 0), 0);
  if (useFileNumbers && !target && Math.min(...parsedNumbers) > 1 && !flag('new-series')) {
    die(`文件名看起来是第 ${Math.min(...parsedNumbers)} 集起，不是从第 1 集开始。\n` +
      '同一部剧必须放在同一个项目里（否则每集各认各的人，角色重复、对不上）：\n' +
      '  - 已经分析过前面的集：加 --project <那个项目的id片段或剧名> 追加\n' +
      '  - 还没分析过：把前面的集一起提交，或确认只分析这几集时加 --new-series');
  }
  if (useFileNumbers && existingEpisodes.length && !flag('reanalyze')) {
    const dup = parsedNumbers.map(episodeIdOf).filter((id) => existingEpisodes.includes(id));
    if (dup.length) die(`这些集项目里已经分析过：${dup.join(', ')}（重复分析会再扣分）。确需重做加 --reanalyze`);
  }

  // ① 先报价：必须把预估积分告诉用户、得到同意后再加 --yes 重跑
  let measured = 0, segments = 0, unknown = urls.length;
  for (const f of files) {
    const d = probeDurationSeconds(f);
    if (d > 0) { measured += d; segments += Math.ceil(d / SEGMENT_SECONDS); } else unknown += 1;
  }
  console.log('— 视频分析计费（仅分析走平台积分；写作由你 Agent 完成，零积分）—');
  if (segments) console.log(`  可测时长 ${Math.round(measured)} 秒 → ${segments} 段 x ${POINTS_PER_SEGMENT} 分 = 约 ${segments * POINTS_PER_SEGMENT} 分`);
  if (unknown) console.log(`  另有 ${unknown} 个来源本地测不到时长，按 ${POINTS_PER_SEGMENT} 分 / ${SEGMENT_SECONDS} 秒计（不足一段按一段）`);
  if (!flag('yes')) die('请先把上面的预估积分告诉用户，得到同意后加 --yes 重跑');
  const quoted = (segments + unknown) * POINTS_PER_SEGMENT;
  const balanceBefore = await pointsBalanceSafe();
  const reportCharge = async () => {
    const after = await pointsBalanceSafe();
    if (balanceBefore == null || after == null) return;
    const spent = balanceBefore - after;
    console.log(`  实际扣除 ${spent} 分（报价约 ${quoted} 分）${spent > quoted ? ' ⚠ 超出报价，请把这条原样告诉用户并反馈平台' : ''}`);
  };

  // ② 建 video_reverse 项目（或追加到 --project 指定的项目）：不设 auto_rewrite，平台分析完不会接着洗稿
  const count = files.length + urls.length;
  let pid = target?.id || '';
  const title = target?.title || arg('title') || ('视频分析·' + new Date().toISOString().slice(0, 10));
  if (!pid) {
    const totalEpisodes = useFileNumbers ? Math.max(count, ...parsedNumbers) : count;
    const created = await api('/api/projects', { method: 'POST', body: {
      title, working_title: title, mode: 'video_reverse',
      total_episodes: totalEpisodes, batch_episodes: Math.min(3, totalEpisodes), quality_tier: 'strong_review',
      config: {
        genre: '短剧', audience: '待确认', production_format: '真人剧',
        source_type: 'video_reverse_series', model_strategy: 'balanced',
        // write_mode=faithful：原片项目默认 1:1 还原；网页「开始生成」也按这个预设走，不会改写台词/改剧情。
        config_json: { created_from: 'chenyu-pro-cli-agent', authoring: 'agent', write_mode: 'faithful' }
      }
    } });
    pid = created.project?.id || created.id;
    if (!pid) die('建项目失败');
    console.log(`✓ 项目已建: ${pid.slice(-8)}  《${title}》`);
  } else {
    console.log(`✓ 追加到已有项目: ${pid.slice(-8)}  《${title}》（已分析 ${existingEpisodes.length} 集，本次和已有集一起做人物审计）`);
  }

  // ③ 上传本地视频：每个视频单独超时+重试（每次换新上传地址），传成功的记到本地清单，
  // 断网/超时后用同一条命令加 --project 重跑会跳过已传的，只补没传的。
  // 2026-09-21：38 集里一个超时就整批退出、重跑又从头全传，移动线路到存储不稳时永远传不完。
  const cacheDir = path.join(CONFIG_DIR, 'uploads');
  const cachePath = path.join(cacheDir, `${pid}.json`);
  let uploadCache = {};
  try { uploadCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {}; } catch {}
  const saveCache = () => {
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(uploadCache, null, 1)); } catch {}
  };
  const proxyHeight = Math.max(240, Number(arg('proxy-height', '720')) || 720);
  const ffmpeg = flag('no-compress') ? null : resolveFfmpeg();
  const proxyDir = path.join(CONFIG_DIR, 'proxy');
  if (ffmpeg) console.log(`  上传前压缩到 ${proxyHeight}p（省带宽、降超时；计费按时长不变；--no-compress 关）`);
  else if (files.length && !flag('no-compress')) console.log('  提示: 未找到 ffmpeg → 传原始视频。装 ffmpeg（或设 CHENYU_FFMPEG）后会自动压缩再传，弱网更稳。');
  const concurrency = Math.max(1, Math.min(4, Number(arg('upload-concurrency', '2')) || 2));
  const maxAttempts = Math.max(1, Number(arg('upload-retries', '4')) || 4);
  const uploaded = [];
  const failed = [];
  let next = 0;
  const uploadOne = async (i) => {
    const fp = files[i];
    const name = path.basename(fp);
    const mime = guessVideoMime(name);
    const stat = fs.statSync(fp);
    const size = stat.size;
    const cacheKey = `${path.resolve(fp)}|${size}|${Math.round(stat.mtimeMs)}`;
    if (uploadCache[cacheKey]?.client_media_path) {
      uploaded[i] = uploadCache[cacheKey];
      console.log(`  ✓ 已传过，跳过 ${name}`);
      return;
    }
    // 上传前压缩：有 ffmpeg 就压到代理分辨率；压完更大或失败都回退原片。压缩后的文件才是实际上传体。
    let sendPath = fp;
    let sendSize = size;
    let proxyTmp = '';
    if (ffmpeg) {
      try {
        fs.mkdirSync(proxyDir, { recursive: true });
        const tmp = path.join(proxyDir, `p${i}_${proxyHeight}_${name.replace(/[^\w.\-]+/g, '_')}.mp4`);
        await compressVideoProxy(ffmpeg, fp, tmp, proxyHeight);
        const tsize = fs.statSync(tmp).size;
        if (tsize > 0 && tsize < size) { sendPath = tmp; sendSize = tsize; proxyTmp = tmp; }
        else { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
      } catch (error) {
        console.log(`  … ${name} 压缩失败(${String(error?.message || error).slice(0, 40)})，改传原片`);
      }
    }
    const body = fs.readFileSync(sendPath);
    // 超时按体积放宽：至少 3 分钟，按 50KB/s 最慢速度估算
    const timeoutMs = Math.max(180000, Math.ceil(sendSize / 50000) * 1000);
    const cleanupProxy = () => { if (proxyTmp) { try { fs.rmSync(proxyTmp, { force: true }); } catch { /* ignore */ } } };
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const signed = await api(`/api/projects/${pid}/client-media/signed-upload`, { method: 'POST', body: { kind: 'video', filename: name, mimeType: mime, size: sendSize } });
        const uploadUrl = signed.upload?.uploadUrl || signed.uploadUrl;
        const mediaPath = signed.upload?.path || signed.path;
        if (!uploadUrl || !mediaPath) throw new Error('获取视频上传地址失败');
        const put = await fetch(uploadUrl, { method: 'PUT', body, headers: { 'Content-Type': mime }, signal: AbortSignal.timeout(timeoutMs) });
        if (!put.ok) throw new Error(`HTTP ${put.status}`);
        uploaded[i] = { client_media_path: mediaPath, title: name, mime_type: mime, size_bytes: sendSize };
        uploadCache[cacheKey] = uploaded[i];
        saveCache();
        cleanupProxy();
        const label = proxyTmp ? `${(sendSize / 1048576).toFixed(1)}MB，压自 ${(size / 1048576).toFixed(1)}MB` : `${(sendSize / 1048576).toFixed(1)}MB`;
        console.log(`  ✓ 已上传 ${name} (${label})${attempt > 1 ? `，第 ${attempt} 次成功` : ''}`);
        return;
      } catch (error) {
        const cause = error?.cause?.code || error?.cause?.message || '';
        lastError = `${error?.name === 'TimeoutError' ? '超时' : error?.message || error}${cause ? ` (${cause})` : ''}`;
        if (attempt < maxAttempts) {
          console.log(`  … ${name} 第 ${attempt} 次上传失败：${lastError}，${attempt * 10} 秒后重试`);
          await sleep(attempt * 10000);
        }
      }
    }
    cleanupProxy();
    failed.push({ name, error: lastError });
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, async () => {
    for (let i = next++; i < files.length; i = next++) await uploadOne(i);
  }));
  if (failed.length) {
    for (const item of failed) console.log(`  ✗ ${item.name}：${item.error}`);
    die(`${failed.length} 个视频没传上去（网络到存储不稳定），本次没有提交分析、没有扣分。\n` +
      `  已传成功的 ${uploaded.filter(Boolean).length} 个已记录，重跑时会跳过。请用同一条命令加 --project ${pid.slice(-8)} 重跑，\n` +
      `  只会补传没传上的；网络持续超时可换网络（如手机热点）或加 --upload-concurrency 1。`);
  }

  // ④ 只分析：不传 auto_start_workflow，平台不会接着代写
  // 集号：文件名能取到就用文件名；否则接在项目已有集之后按顺序编。
  let nextEpisode = Math.max(existingMax, useFileNumbers ? Math.max(...parsedNumbers) : 0) + 1;
  const videos = urls.map((u) => ({ video_url: u, episode_id: episodeIdOf(nextEpisode++) }));
  uploaded.forEach((u, i) => { if (u) videos.push({ ...u, episode_id: useFileNumbers ? episodeIdOf(parsedNumbers[i]) : episodeIdOf(nextEpisode++) }); });
  console.log(`  集号: ${videos.map((v) => v.episode_id).join(', ')}`);
  const note = arg('analysis-note', '');
  await api(`/api/projects/${pid}/video-reverse/start`, { method: 'POST', body: { videos, ...(note ? { prompt: note } : {}) } });
  console.log(`✓ 已提交分析 ${videos.length} 个视频（仅分析，不代写）`);

  // ⑤ 轮询到分析结束
  const deadline = Date.now() + Number(arg('timeout-min', '90')) * 60000;
  let lastMsg = '';
  let partial = '';
  let identityOnly = false;
  while (Date.now() < deadline) {
    await sleep(15000);
    const jobs = (await api(`/api/projects/${pid}/jobs`)).jobs || [];
    const job = jobs.find((j) => String(j.type || j.job_type || '').includes('video_reverse')) || jobs[0];
    if (!job) continue;
    const st = String(job.status || '');
    const msg = `${st} ${job.progress != null ? job.progress + '%' : ''} ${job.message || ''}`.trim();
    if (msg !== lastMsg) { console.log('  … ' + msg); lastMsg = msg; }
    if (['succeeded', 'completed', 'done'].includes(st)) break;
    // needs_review = 部分段未完成或需复核：已完成的段照常取回，不整批重交（重交会对已成功段重复扣分）。
    if (st === 'needs_review') {
      let rj = job.result_json || {};
      if (typeof rj === 'string') { try { rj = JSON.parse(rj); } catch { rj = {}; } }
      const failed = Array.isArray(rj.failed_segments) ? rj.failed_segments : [];
      // 没有失败段 = 分析完整，只是平台自动改编用的人物身份门没过（单包项目几乎必出），不是缺内容。
      if (failed.length) partial = `未完成的段: ${failed.map((f) => f.segment_id).join(', ')}`;
      else identityOnly = true;
      break;
    }
    if (['failed', 'cancelled', 'error'].includes(st)) { await reportCharge(); die('分析失败: ' + (job.message || st)); }
  }

  // ⑥ 取回分析稿交给 Agent
  const outDir = path.resolve(arg('out', './chenyu-video-analysis'));
  const { got, badSegments } = await downloadVideoAnalysis(pid, outDir);
  await reportCharge();
  if (badSegments.length) {
    console.log(`⛔ 以下段分析稿不完整（缺画面动作/镜头表）：\n  ${badSegments.join('\n  ')}\n  不要据此写作、不要用占位话凑 △——先原样告诉用户，由平台核实后重跑或退分。`);
  }
  if (!got) {
    console.log(`⚠ 分析已结束但未取到分析稿，用 chenyu-pro status --project ${pid.slice(-8)} 复查`);
    return;
  }
  console.log(`✓ 分析稿已取回 ${got} 个文件 -> ${outDir}`);
  console.log(`ℹ 这部剧后面的集请追加到同一个项目：chenyu-pro video-analyze --project ${pid.slice(-8)} --video-file 第N集.mp4 [--yes]`);
  if (partial) console.log(`⚠ 部分段未完成：${partial}\n  已完成的段已取回；不要整批重新提交（会对已成功的段重复扣分），把缺的集告诉用户。`);
  if (identityOnly) console.log('ℹ 分析完整。平台标记"人物身份待核"（单包分析常见，不是缺内容）——写作时按分析稿人物表统一称呼即可，无需重交。');
  console.log('  下一步（零积分）：你(Agent)读 video_reverse_全剧合集.md —— 里面有剧集索引、人物/场景/道具资产表、');
  console.log('  事件表和逐集分析表。先按资产表做新旧映射，再照逐集分析表逐集改写；');
  console.log(`  过 gate 后 chenyu-pro save --project ${pid.slice(-8)} --episode N --file 第00N集.txt`);
}

function cmdVersion() {
  console.log(`chenyu-pro v${VERSION}`);
}

function cmdHelp() {
  console.log(`辰屿 Pro CLI v${VERSION} —— 剧本平台命令行（Agent 写作模式：平台只鉴权，写作零积分）

  chenyu-pro login --web                                   网页授权登录你的账号（推荐；项目归你账号，KEY 自动带出）
  chenyu-pro login --username <账号> --password <密码>     密码登录你的账号
  chenyu-pro key set <积分KEY> | key show                  仅绑积分 KEY（快速免密，但走独立身份）
  chenyu-pro credits                                       查用户名·余额
  【Agent 写作模式（默认）：写作由你的 Agent 完成，不消耗平台积分，平台只做鉴权与交付】
  chenyu-pro auth                                          鉴权门——Agent 动笔前必须通过(输出 AUTH_OK)
  chenyu-pro create --title <剧名> --episodes 30 [--market us_en]   建项目壳(零积分，不触发平台生成)
  chenyu-pro save --project <id片段> --episode 1 --file 第001集.txt  回传 Agent 写好的一集正文
  chenyu-pro save --project <id片段> --dir <目录>          批量回传(文件名含 第N集 的 .txt/.md)
  chenyu-pro gate --file 剧本.txt | --dir <目录>           格式门：确定性质量校验(对白连发/心理活动/超长台词/形象标记)，改到 GATE_PASS
  chenyu-pro variants --dir <目录> [--out 文件]           从正文【形象】标记汇总形象变体表（每人几个变体、出现在哪几集哪几场）
  chenyu-pro status --project <id片段|剧名> [--watch]      查/盯进度
  chenyu-pro fetch --project <id片段> --out <目录>          导出交付正文到本地
  chenyu-pro sync --project <id片段|剧名>                   同步到云端脚本库（辰屿客户端可下载）
  chenyu-pro projects                                      项目列表
  【视频分析——本 Skill 唯一消耗积分的功能】
  chenyu-pro video-analyze --video-file a.mp4,b.mp4 [--yes]  视频→分析稿(只分析不代写)
  chenyu-pro video-analyze --video-url <链接> [--out <目录>]  计费: ${POINTS_PER_SEGMENT} 分 / ${SEGMENT_SECONDS} 秒段(不足一段按一段)
  chenyu-pro video-analyze --project <id片段|剧名> --video-file 第4集.mp4  同一部剧追加到已有项目(人物跨集合并)
  chenyu-pro video-fetch --project <id片段|剧名> [--out <目录>]  零积分重新取回最新分析稿(平台修复后用这个取)
    同一部剧只用一个项目：一次提交全部集，或后续用 --project 追加；不要一集一个项目、不要并发提交。
    集号按文件名(第N集/EPN/N.mp4)；文件名不是从第1集开始又没给 --project 会被拦下(新剧中途开始加 --new-series)。
    不加 --yes 只报价不执行；分析稿取回后由你(Agent)自己写剧本，写作零积分。
    视频一律用本命令做反推；不要用抽音频/转写/抽帧代替(只有台词没画面,剧本会乱)。

  市场: ${Object.entries(MARKETS).map(([k, v]) => k + '=' + v).join(' ')}
  升级: irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex`);
}

const commands = { login: cmdLogin, key: cmdKey, credits: cmdCredits, status: cmdStatus, fetch: cmdFetch, sync: cmdSync, projects: cmdProjects, auth: cmdAuth, create: cmdCreate, save: cmdSave, gate: cmdGate, variants: cmdVariants, 'video-analyze': cmdVideoAnalyze, 'video-fetch': cmdVideoFetch, version: cmdVersion, '--version': cmdVersion, '-v': cmdVersion, help: cmdHelp };
await (commands[cmd] || cmdHelp)();
