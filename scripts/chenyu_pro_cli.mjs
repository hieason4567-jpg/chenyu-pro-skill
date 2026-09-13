#!/usr/bin/env node
// 辰屿 Pro CLI —— Agent 编剧模式命令行（v2.x）：写作由安装 Skill 的用户 Agent 完成，
// 不消耗平台积分；本 CLI 只做 鉴权/项目壳/正文回传/只读查询/交付。
// CLI 内不存在任何能触发平台模型生成或扣积分的调用（v2.1.0 起物理移除）。
// 零依赖，Node 18+。配置存 ~/.codex/chenyu-pro/config.json（KEY/session 掩码显示，绝不写入日志）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawnSync } from 'node:child_process';

// 版本号：功能变化 minor+1，修 bug patch+1。改动同时更新下方 CHANGELOG。
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
const VERSION = '2.3.2';

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
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
    }).then((r) => r.json());
    if (!tk?.ticket) return false;
    const login = await fetch((cfg.platform_base || DEFAULT_PLATFORM) + '/api/auth/sso-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  const headers = { 'Content-Type': 'application/json' };
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
  const res = await fetch((cfg.credit_base || DEFAULT_CREDIT_BASE) + pathName, { headers: { Authorization: 'Bearer ' + key } });
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
    const start = await fetch(base + '/api/auth/cli/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
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
      const p = await fetch(base + '/api/auth/cli/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }) }).then((r) => r.json()).catch(() => ({}));
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
const GATE_FILLER_RE = /话题继续推进|接住话头|抬眼回应|短暂停顿，另一方|对话继续|继续交谈|继续对话|气氛继续|场面继续/;
const isSceneHead = (l) => /^\d+-\d+\s+\S/.test(l);
const isEpTitle = (l) => /^第\d+集/.test(l);
const isActionLine = (l) => l.startsWith('△') || l.startsWith('▲');
const isMetaLine = (l) => /^【(画面|运镜|音效|字幕|转场|特效)】/.test(l);
const matchDialogue = (l) => {
  if (isActionLine(l) || isMetaLine(l) || isSceneHead(l) || isEpTitle(l)) return null;
  const m = l.match(/^([^\s：:△▲【\d][^：:]{0,9})(（[^）]*）|\([^)]*\))?[：:](.+)$/);
  return m ? { speaker: m[1].trim(), body: m[3].trim() } : null;
};

// 校验一份正文，返回 { errors: [], warnings: [], stats: {} }。行号从 1 开始。
function gateOneScript(text) {
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
  const actionSeen = new Map(); // △正文 → 出现行号（重复△检测）
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i].trim();
    const ln = i + 1;
    if (!l) continue;
    if (isActionLine(l)) {
      flushRun();
      actCount++;
      const body = l.slice(1).trim();
      if (GATE_MENTAL_RE.test(body)) errors.push(`第${ln}行 △写了心理活动（${(body.match(GATE_MENTAL_RE) || [''])[0]}）→ △只写可见的外部动作与神态，把心理翻译成身体反应`);
      if (GATE_FILLER_RE.test(body)) errors.push(`第${ln}行 △是万能填充句（${(body.match(GATE_FILLER_RE) || [''])[0]}）→ 写该时刻具体谁做了什么可见动作，不要用空话凑配比`);
      const key = body.replace(/[。．.！!？?，,；;\s]+$/u, '');
      if (!actionSeen.has(key)) actionSeen.set(key, []);
      actionSeen.get(key).push(ln);
      if (body.length < 6) warnings.push(`第${ln}行 △太短（${body.length}字）——动作要具体可拍`);
      if (body.length > 60) warnings.push(`第${ln}行 △太长（${body.length}字）——一行一件事，拆开`);
      continue;
    }
    if (isMetaLine(l) || isSceneHead(l) || isEpTitle(l)) { flushRun(); continue; }
    const d = matchDialogue(l);
    if (d) {
      dlgCount++;
      run.push({ line: ln, speaker: d.speaker });
      if (d.body.length > 40) warnings.push(`第${ln}行 台词超长（${d.body.length}字）——超过40字的台词转分镜会被硬拆，建议按句号拆成两句`);
      continue;
    }
    flushRun(); // 其他叙述行也算隔断
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
  return { errors, warnings, stats: { dialogue: dlgCount, action: actCount } };
}

// gate 命令：--file 单文件 / --dir 目录批量(.txt/.md)。跑门前仅做鉴权（不扣积分）。
// 输出 GATE_PASS / GATE_FAIL(exit 1)。--no-auth 供离线自查（Agent 正式交付前仍须 auth）。
async function cmdGate() {
  if (!flag('no-auth')) await api('/api/auth/me');
  const file = arg('file', '');
  const dir = arg('dir', '');
  const targets = [];
  if (file) targets.push(path.resolve(file));
  else if (dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(d)) die('目录不存在: ' + d);
    for (const name of fs.readdirSync(d)) if (/\.(txt|md)$/i.test(name)) targets.push(path.join(d, name));
    if (!targets.length) die('目录里没有 .txt/.md 剧本文件');
  } else die('用法: chenyu-pro gate --file 剧本.txt  或  chenyu-pro gate --dir <目录>');
  let totalErr = 0, totalWarn = 0;
  for (const t of targets) {
    if (!fs.existsSync(t)) die('文件不存在: ' + t);
    const { errors, warnings, stats } = gateOneScript(fs.readFileSync(t, 'utf8'));
    const name = path.basename(t);
    console.log(`── ${name}  台词${stats.dialogue}句 / 动作${stats.action}行`);
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

async function cmdVideoAnalyze() {
  const files = arg('video-file', '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
  const urls = arg('video-url', '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (!files.length && !urls.length) die('缺 --video-file <本地.mp4> 或 --video-url <链接>（多个用英文逗号分隔，可混用）');
  for (const f of files) if (!fs.existsSync(f)) die('视频文件不存在: ' + f);

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

  // ② 建 video_reverse 项目：不设 auto_rewrite，平台分析完不会接着洗稿
  const count = files.length + urls.length;
  const title = arg('title') || ('视频分析·' + new Date().toISOString().slice(0, 10));
  const created = await api('/api/projects', { method: 'POST', body: {
    title, working_title: title, mode: 'video_reverse',
    total_episodes: count, batch_episodes: Math.min(3, count), quality_tier: 'strong_review',
    config: {
      genre: '短剧', audience: '待确认', production_format: '真人剧',
      source_type: 'video_reverse_series', model_strategy: 'balanced',
      config_json: { created_from: 'chenyu-pro-cli-agent', authoring: 'agent' }
    }
  } });
  const pid = created.project?.id || created.id;
  if (!pid) die('建项目失败');
  console.log(`✓ 项目已建: ${pid.slice(-8)}  《${title}》`);

  // ③ 上传本地视频（有界并发 4）
  const uploaded = [];
  let next = 0;
  const uploadOne = async (i) => {
    const fp = files[i];
    const name = path.basename(fp);
    const mime = guessVideoMime(name);
    const size = fs.statSync(fp).size;
    const signed = await api(`/api/projects/${pid}/client-media/signed-upload`, { method: 'POST', body: { kind: 'video', filename: name, mimeType: mime, size } });
    const uploadUrl = signed.upload?.uploadUrl || signed.uploadUrl;
    const mediaPath = signed.upload?.path || signed.path;
    if (!uploadUrl || !mediaPath) die('获取视频上传地址失败: ' + name);
    const put = await fetch(uploadUrl, { method: 'PUT', body: fs.readFileSync(fp), headers: { 'Content-Type': mime } });
    if (!put.ok) die(`视频上传失败（HTTP ${put.status}）: ${name}`);
    uploaded[i] = { client_media_path: mediaPath, title: name, mime_type: mime, size_bytes: size };
    console.log(`  ✓ 已上传 ${name} (${(size / 1048576).toFixed(1)}MB)`);
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length || 1) }, async () => {
    for (let i = next++; i < files.length; i = next++) await uploadOne(i);
  }));

  // ④ 只分析：不传 auto_start_workflow，平台不会接着代写
  const videos = urls.map((u, i) => ({ video_url: u, episode_id: String(i + 1).padStart(3, '0') }));
  uploaded.forEach((u, i) => { if (u) videos.push({ ...u, episode_id: String(urls.length + i + 1).padStart(3, '0') }); });
  const note = arg('analysis-note', '');
  await api(`/api/projects/${pid}/video-reverse/start`, { method: 'POST', body: { videos, ...(note ? { prompt: note } : {}) } });
  console.log(`✓ 已提交分析 ${videos.length} 个视频（仅分析，不代写）`);

  // ⑤ 轮询到分析结束
  const deadline = Date.now() + Number(arg('timeout-min', '90')) * 60000;
  let lastMsg = '';
  while (Date.now() < deadline) {
    await sleep(15000);
    const jobs = (await api(`/api/projects/${pid}/jobs`)).jobs || [];
    const job = jobs.find((j) => String(j.type || '').includes('video_reverse')) || jobs[0];
    if (!job) continue;
    const st = String(job.status || '');
    const msg = `${st} ${job.progress != null ? job.progress + '%' : ''} ${job.message || ''}`.trim();
    if (msg !== lastMsg) { console.log('  … ' + msg); lastMsg = msg; }
    if (['succeeded', 'completed', 'done'].includes(st)) break;
    if (['failed', 'cancelled', 'error'].includes(st)) die('分析失败: ' + (job.message || st));
  }

  // ⑥ 取回分析稿交给 Agent
  const outDir = path.resolve(arg('out', './chenyu-video-analysis'));
  fs.mkdirSync(outDir, { recursive: true });
  const arts = (await api(`/api/projects/${pid}/artifacts`)).artifacts || [];
  const want = ['video_reverse_source.md', 'video_reverse_replay_script.md', 'episode_index.json', 'identity_registry.json'];
  let got = 0;
  for (const a of arts) {
    const fn = String(a.filename || a.title || '');
    if (!want.includes(fn)) continue;
    let content = String(a.content || '');
    if (!content) {
      try { content = String((await api(`/api/artifacts/${a.id}/content`)).content || ''); } catch { /* 跳过取不到的 */ }
    }
    if (!content.trim()) continue;
    fs.writeFileSync(path.join(outDir, fn), content, 'utf8');
    got += 1;
  }
  if (!got) {
    console.log(`⚠ 分析已结束但未取到分析稿，用 chenyu-pro status --project ${pid.slice(-8)} 复查`);
    return;
  }
  console.log(`✓ 分析稿已取回 ${got} 个文件 -> ${outDir}`);
  console.log('  下一步（零积分）：你(Agent)读 video_reverse_source.md，按 SKILL 写作规范自己写剧本，');
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
  chenyu-pro gate --file 剧本.txt | --dir <目录>           格式门：确定性质量校验(对白连发/心理活动/超长台词)，改到 GATE_PASS
  chenyu-pro status --project <id片段|剧名> [--watch]      查/盯进度
  chenyu-pro fetch --project <id片段> --out <目录>          导出交付正文到本地
  chenyu-pro sync --project <id片段|剧名>                   同步到云端脚本库（辰屿客户端可下载）
  chenyu-pro projects                                      项目列表
  【视频分析——本 Skill 唯一消耗积分的功能】
  chenyu-pro video-analyze --video-file a.mp4,b.mp4 [--yes]  视频→分析稿(只分析不代写)
  chenyu-pro video-analyze --video-url <链接> [--out <目录>]  计费: ${POINTS_PER_SEGMENT} 分 / ${SEGMENT_SECONDS} 秒段(不足一段按一段)
    不加 --yes 只报价不执行；分析稿取回后由你(Agent)自己写剧本，写作零积分。
    视频一律用本命令做反推；不要用抽音频/转写/抽帧代替(只有台词没画面,剧本会乱)。

  市场: ${Object.entries(MARKETS).map(([k, v]) => k + '=' + v).join(' ')}
  升级: irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex`);
}

const commands = { login: cmdLogin, key: cmdKey, credits: cmdCredits, status: cmdStatus, fetch: cmdFetch, sync: cmdSync, projects: cmdProjects, auth: cmdAuth, create: cmdCreate, save: cmdSave, gate: cmdGate, 'video-analyze': cmdVideoAnalyze, version: cmdVersion, '--version': cmdVersion, '-v': cmdVersion, help: cmdHelp };
await (commands[cmd] || cmdHelp)();
