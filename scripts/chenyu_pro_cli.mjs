#!/usr/bin/env node
// 辰屿 Pro CLI —— 剧本生产平台的命令行入口（操作员模式：提交/盯进度/交付，
// 写作与质量硬门全在服务端，提示词不出服务器）。零依赖，Node 18+。
// 配置存 ~/.codex/chenyu-pro/config.json（KEY/session 掩码显示，绝不写入日志）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn, spawnSync } from 'node:child_process';

// 版本号：功能变化 minor+1，修 bug patch+1。改动同时更新下方 CHANGELOG。
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
const VERSION = '1.8.8';

const CONFIG_DIR = path.join(os.homedir(), '.codex', 'chenyu-pro');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_PLATFORM = 'https://chenyu.pumpumai.com';
const DEFAULT_CREDIT_BASE = 'https://drama.pumpumai.com';

// 每集消耗经验值（分）——按主力模型，含 Flash 辅助地板 ~40 分（2026-07 实测口径）
const COST_PER_EPISODE = { 'auto': 113, 'deepseek-v4-pro': 113, 'grok-4.5': 77, 'gpt-5.6-luna': 77, 'gemini-3.5-flash': 77, 'gpt-5.6-sol': 151 };
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

// 视频批量上传断点续传清单：传一个记一个，中断后同命令重跑跳过已传的。
const VIDEO_MANIFEST = path.join(CONFIG_DIR, 'video-uploads.json');
function loadVideoManifest() { try { return JSON.parse(fs.readFileSync(VIDEO_MANIFEST, 'utf8')); } catch { return {}; } }
function saveVideoManifest(m) { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(VIDEO_MANIFEST, JSON.stringify(m, null, 2), 'utf8'); }
function hashKey(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

// 上传前压缩：服务端反推只用低清分析代理(scale=-2:480)，原片纯浪费带宽。
// 有 ffmpeg 就先压到 480p（保留音轨供对白识别），上传小一个数量级；没有则传原片。
// 关键：优先选带 libx264 的 ffmpeg。GPU-only 构建(只有 h264_amf/nvenc)没有 libx264，
// 硬调 -c:v libx264 会报 "Unknown encoder 'libx264'" → 压缩失败静默传几十 MB 原片。
// 探测每个候选的 -encoders：带 libx264 的直接用；都没有才退到可用的 GPU/软编码器。
// 返回 {bin, vcodec, vargs} 或 null。
function resolveFfmpeg() {
  const cands = [process.env.CHENYU_FFMPEG, 'ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg-6.1.1\\bin\\ffmpeg.exe', 'E:\\pump2.0\\BOTV\\FFMPEG.EXE'].filter(Boolean);
  let firstBin = null, firstEnc = '';
  for (const c of cands) {
    let enc;
    try { const r = spawnSync(c, ['-hide_banner', '-encoders'], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); if (r.status !== 0) continue; enc = String(r.stdout || ''); } catch { continue; }
    if (!firstBin) { firstBin = c; firstEnc = enc; }
    if (/\blibx264\b/.test(enc)) return { bin: c, vcodec: 'libx264', vargs: ['-preset', 'veryfast', '-crf', '28'] };
  }
  if (!firstBin) return null;
  const has = (n) => new RegExp('\\b' + n + '\\b').test(firstEnc);
  if (has('h264_nvenc')) return { bin: firstBin, vcodec: 'h264_nvenc', vargs: ['-rc', 'vbr', '-cq', '30'] };
  if (has('h264_qsv')) return { bin: firstBin, vcodec: 'h264_qsv', vargs: ['-global_quality', '30'] };
  if (has('h264_amf')) return { bin: firstBin, vcodec: 'h264_amf', vargs: ['-rc', 'cqp', '-qp_i', '30', '-qp_p', '30', '-qp_b', '30'] };
  if (has('mpeg4')) return { bin: firstBin, vcodec: 'mpeg4', vargs: ['-q:v', '5'] };
  return { bin: firstBin, vcodec: 'libx264', vargs: ['-preset', 'veryfast', '-crf', '28'] };
}
function compressVideoProxy(ff, src, dst, height) {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    // 视觉降到 height，保留音轨(AAC 96k)；与服务端分析代理对齐，分析零损失。
    // 编码器由 resolveFfmpeg 探测选定(优先 libx264，GPU-only 环境退 nvenc/qsv/amf)。
    const a = ['-y', '-i', src, '-vf', `scale=-2:${height}`, '-c:v', ff.vcodec, ...ff.vargs, '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst];
    const child = spawn(ff.bin, a, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', reject);
    child.on('close', (s) => { (s === 0 && fs.existsSync(dst)) ? resolve() : reject(new Error(`ffmpeg 压缩失败(${s})`)); });
  });
}

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

async function cmdEstimate() {
  const episodes = Number(arg('episodes', '30'));
  const model = arg('model', 'auto');
  const perEp = COST_PER_EPISODE[model] ?? COST_PER_EPISODE.auto;
  const directorCut = flag('director-cut') ? 15 : 0;
  const total = Math.round(episodes * (perEp + directorCut) * 1.2); // 1.2 重试缓冲
  console.log(`预估: ${episodes} 集 × (${perEp}${directorCut ? '+' + directorCut + '制片级' : ''}) × 1.2缓冲 ≈ ${total} 分`);
  try {
    const k = (await creditApi('/api/jimeng/v1/key')).key || {};
    const ok = Number(k.pointsBalance) >= total;
    console.log(`余额: ${k.pointsBalance} 分 → ${ok ? '✓ 足够' : '✗ 不足，请先充值'}`);
    if (!ok) process.exit(2);
  } catch { console.log('（未绑定 KEY，跳过余额校验）'); }
}

function buildRewriteDirective(marketKey, extra) {
  // 市场规则块（与网页创作台一致的公开层；核心写作/审核方法论在服务端，不在此处）
  const M = {
    us_en: ['美国当代都市/海滨小镇', '美元', '人物改用地道欧美英文名，家族同姓一致；禁止汉语拼音姓氏与源名谐音；场景人物行用全名，台词行与动作行只用名字 First name。', '称谓按欧美习惯。'],
    latam_es: ['墨西哥/哥伦比亚当代都市', '美元', '人物改用西语名，家族同姓一致；禁止拼音姓氏与源名谐音；场景人物行用全名，台词行只用名字。', '称谓按拉美习惯。'],
    brazil_pt: ['巴西里约/圣保罗当代都市', '美元', '人物改用巴西葡语名，家族同姓一致；禁止拼音姓氏与源名谐音；场景人物行用全名，台词行只用名字。', '称谓按巴西习惯。'],
    japan_ja: ['日本当代都市/沿海町', '日元', '人物改用日式姓名（汉字书写，姓在前），家族同姓一致；禁止保留中文原名或谐音；对话用日式敬称，正文仍中文书写。', '称谓按日本习惯。'],
    korea_ko: ['韩国首尔/釜山当代都市', '韩元', '人物改用韩式姓名（中文谐音汉字书写，姓在前），家族同姓一致；禁止保留原名；对话体现敬语层级，正文中文书写。', '称谓按韩国习惯。'],
    thailand_th: ['泰国曼谷/海岛当代都市', '泰铢', '人物改用泰式姓名+昵称制（中文书写音译）；家族关系一致；禁止保留原名或谐音。', '称谓按泰国习惯。'],
    vietnam_vi: ['越南胡志明市/沿海当代都市', '越南盾', '人物改用越式姓名（中文书写音译，姓在前）；家族同姓一致；禁止保留原名或谐音。', '称谓按越南习惯。'],
    indonesia_id: ['印尼雅加达/巴厘岛当代都市', '印尼盾', '人物改用印尼名，可单名；家族关系一致；禁止拼音姓氏与源名谐音。', '称谓按印尼习惯。'],
    cn_reskin: ['', '', '人物更换新的中文姓名，家族姓氏与关系一致，禁止沿用原名或谐音名。', '称谓按新背景调整。']
  };
  const [setting, currency, nameRule, kinship] = M[marketKey] || M.us_en;
  return [
    '洗稿换壳改编：严格保留原剧情骨架、每集节拍、场次顺序、情绪曲线与钩子位置；每段源台词与可见节拍都要有功能等价物，禁止删减。',
    setting ? `目标市场：${MARKETS[marketKey]}。目标背景设定：${setting}。所有时代、场景、职业体系迁移为该市场的等价物。` : `目标市场：${MARKETS[marketKey]}。`,
    nameRule,
    `地名、机构名、称谓、头衔全部替换为该市场等价物；${currency ? `货币单位一律用${currency}，` : ''}全剧统一换算基准，系统面板数字等比换算且跨集自洽。${kinship}`,
    '台词与叙述全部重写，语义可保留但表达不得照抄原文。正文保持中文书写（人名、地名、机构名、货币按目标市场）。',
    extra ? `补充要求：${extra}` : ''
  ].filter(Boolean).join('\n');
}

async function cmdSubmit() {
  const mode = arg('mode', 'rewrite'); // rewrite | adaptation | original | video
  if (mode === 'video') return cmdSubmitVideo();
  const title = arg('title') || die('缺 --title 剧名');
  const episodes = Number(arg('episodes', '30'));
  const sourceFile = arg('source');
  const fromProject = arg('from-project', ''); // 从已有项目(如视频反推母项目)拉反推稿当洗稿源，复用不重反推
  const market = arg('market', 'us_en');
  const marketExplicit = args.includes('--market'); // 原创/改编：只有显式 --market 才落地国外市场，否则中文
  const model = arg('model', '');
  const extra = arg('extra', '');
  const batch = Number(arg('batch', '3'));
  const duration = Number(arg('duration', '90'));
  if (mode === 'rewrite' && !MARKETS[market]) die('未知市场: ' + market + '，可选: ' + Object.keys(MARKETS).join('/'));
  if ((mode === 'original' || mode === 'adaptation') && marketExplicit && !MARKETS[market]) die('未知市场: ' + market + '，可选: ' + Object.keys(MARKETS).join('/'));
  let sourceText = '';
  let sourceLabel = sourceFile ? path.basename(sourceFile) : '源材料.md';
  if (fromProject) {
    const sp = await findProject(fromProject);
    const arts = (await api(`/api/projects/${sp.id}/artifacts`)).artifacts || [];
    const srcArt = arts
      .filter((a) => a.type === 'source_file' || /反推稿|视频反推/.test(String(a.title || '')))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    if (!srcArt) die(`来源项目《${sp.title}》没有反推稿/源稿，不能作洗稿源`);
    sourceText = String((await api(`/api/artifacts/${srcArt.id}/content`)).content || '');
    sourceLabel = `${sp.title}·反推稿.md`;
    console.log(`✓ 已载入来源项目《${sp.title}》的反推稿 (${sourceText.length} 字) —— 复用不重反推`);
  } else if (mode !== 'original') {
    if (!sourceFile) die('rewrite/adaptation 需要 --source <源文件.txt/.md> 或 --from-project <反推母项目id片段>');
    sourceText = fs.readFileSync(path.resolve(sourceFile), 'utf8');
  }
  if ((sourceFile || fromProject) && sourceText.trim().length < 100) die('源文本太短');

  const directive = mode === 'rewrite' ? buildRewriteDirective(market, extra) : (extra || '按原剧情忠实改编');
  const body = {
    title, working_title: title,
    mode: mode === 'original' ? 'original' : 'adaptation',
    total_episodes: episodes, batch_episodes: batch,
    quality_tier: arg('quality', 'strong_review'),
    episode_duration_seconds: duration,
    config: {
      genre: arg('genre', mode === 'rewrite' ? MARKETS[market] + '洗稿' : '待确认'),
      audience: arg('audience', '待确认'),
      production_format: '真人剧', source_type: 'source_text',
      model_strategy: 'balanced', research_window_days: 30,
      episode_duration_seconds: duration,
      adaptation_directive: directive,
      config_json: {
        created_from: 'chenyu-pro-cli',
        // 剧本洗稿 = B 路（忠实换壳：集数1:1、不卡每集时长、逐集质量门）；网文改编/原创走 A 路（蓝图）
        ...(mode === 'rewrite' ? { market, wash_lane: 'reverse_faithful' } : {}),
        // 原创/改编（A 路）显式 --market 时，蓝图与正文按目标市场落地（名字/货币/称谓）
        ...((mode === 'original' || mode === 'adaptation') && marketExplicit ? { market } : {}),
        ...(model && model !== 'auto' ? { writer_model: model } : {}),
        ...(flag('director-cut') ? { director_cut: true } : {})
      }
    }
  };
  const created = await api('/api/projects', { method: 'POST', body });
  const pid = created.project.id;
  console.log('✓ 项目已创建: ' + pid);
  if (sourceText) {
    await api(`/api/projects/${pid}/files`, { method: 'POST', body: { filename: sourceLabel, title: '源材料', type: 'source_file', step_id: 'A01A', content: sourceText } });
    console.log('✓ 源文件已上传 (' + sourceText.length + ' 字)');
  }
  const started = await api(`/api/projects/${pid}/workflow/start-auto`, { method: 'POST', body: {} });
  console.log('✓ 已开跑: job=' + (started.job?.id || '?'));
  console.log(`下一步: chenyu-pro status --project ${pid.slice(-8)} [--watch]`);
}

const VIDEO_MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v', '.flv': 'video/x-flv', '.ts': 'video/mp2t' };
const guessVideoMime = (name) => VIDEO_MIME[path.extname(name).toLowerCase()] || 'video/mp4';

// 视频反推（洗稿源=视频）：直接调平台现成端点——建 video_reverse 项目 + /video-reverse/start。
// 支持批量：--video-url 多链接逗号分隔，--video-file 多本地文件逗号分隔（走 signed-upload），两者可混用。
// 给了 --market 就自动接洗稿（平台 auto_rewrite：反推完自动建洗稿项目并开跑，时长跟源视频每集）。
async function cmdSubmitVideo() {
  const urls = arg('video-url', '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  const files = arg('video-file', '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
  if (!urls.length && !files.length) die('缺 --video-url <链接> 或 --video-file <本地文件>（多个用英文逗号分隔，可混用）');
  for (const f of files) { if (!fs.existsSync(f)) die('视频文件不存在: ' + f); }
  const market = arg('market', ''); // 给了才自动洗稿；不给只反推成剧本稿
  if (market && !MARKETS[market]) die('未知市场: ' + market + '，可选: ' + Object.keys(MARKETS).join('/'));
  const extra = arg('extra', '');
  const duration = Number(arg('duration', '90'));
  const channel = arg('channel', 'keep'); // to_male | to_female | keep
  const count = urls.length + files.length;
  const title = arg('title') || (market ? `视频反推·${MARKETS[market]}洗稿` : '视频反推项目');
  const resumeProject = arg('resume-project', '');
  // 断点续传：清单按 文件集+市场+标题 定位同一任务；上传一个存一个，中断后同命令重跑
  // 自动跳过已传的、只补未传的，全齐了才 start。彻底避免大批量上传被窗口杀后重传整季。
  const jobKey = hashKey(files.slice().sort().join('|') + '#' + urls.slice().sort().join('|') + '#' + market + '#' + title);
  const manifest = loadVideoManifest();
  let entry = manifest[jobKey];
  let pid;
  if (resumeProject) {
    pid = resumeProject.startsWith('project_') ? resumeProject : ('project_' + resumeProject);
    entry = (entry && entry.projectId === pid) ? entry : { projectId: pid, uploaded: {}, started: false };
    manifest[jobKey] = entry; saveVideoManifest(manifest);
    console.log(`↻ 续传到指定项目 ${pid}`);
  } else if (entry && entry.projectId && !entry.started) {
    pid = entry.projectId;
    console.log(`↻ 续传已有反推项目 ${pid}（已上传 ${Object.keys(entry.uploaded || {}).length}/${files.length}，跳过已传只补未传）`);
  } else {
    const body = {
      title, working_title: title,
      mode: 'video_reverse',
      total_episodes: count, batch_episodes: Math.min(3, count),
      quality_tier: arg('quality', 'strong_review'),
      episode_duration_seconds: duration,
      config: {
        genre: '待反推确认', audience: arg('audience', '待确认'), production_format: '真人剧',
        source_type: 'video_reverse_series', model_strategy: 'balanced', research_window_days: 30,
        episode_duration_seconds: duration,
        config_json: {
          created_from: 'chenyu-pro-cli-video',
          // 选了市场即启用自动洗稿：服务端 onCompleted 反推完自动建洗稿项目并开跑
          ...(market ? { auto_rewrite: { market, channel, names: true, places: true, dialogue: true, extra, ...(flag('director-cut') ? { director_cut: true } : {}) } } : {})
        }
      }
    };
    const created = await api('/api/projects', { method: 'POST', body });
    pid = created.project.id;
    entry = { projectId: pid, uploaded: {}, started: false };
    manifest[jobKey] = entry; saveVideoManifest(manifest);
    console.log(`✓ 反推项目已创建: ${pid}（共 ${count} 个：${urls.length} 链接 + ${files.length} 本地文件）`);
  }
  entry.uploaded = entry.uploaded || {};
  // 上传前压缩到分析代理分辨率（与服务端反推一致），大幅缩短上传时间；--no-compress 关闭。
  const proxyH = Math.max(240, Number(arg('proxy-height', '480')) || 480);
  const ffmpeg = flag('no-compress') ? null : resolveFfmpeg();
  if (files.length && !ffmpeg && !flag('no-compress')) console.log(`  提示: 未找到 ffmpeg → 上传原始视频(慢)。装 ffmpeg 后会自动压到 ${proxyH}p 再传(小一个数量级，快很多)。`);
  else if (files.length && ffmpeg && ffmpeg.vcodec !== 'libx264') console.log(`  提示: 当前 ffmpeg 无 libx264，改用 ${ffmpeg.vcodec} 压缩(仍压到 ${proxyH}p)。想要更稳可装带 libx264 的完整版或设 CHENYU_FFMPEG 指向它。`);
  // 本地文件批量上传：有界并发（压缩吃 CPU、上传吃网络，重叠起来比一条条串行快 2-3 倍）。
  // 传一个立即落盘清单 → 可断点续传；--concurrency N 调并发(默认 4)，--concurrency 1 退回串行。
  const CONC = Math.max(1, Math.min(8, Number(arg('concurrency', '4')) || 4));
  let done = 0, nextIdx = 0;
  const total = files.length;
  const already = files.filter((fp) => entry.uploaded[fp] && entry.uploaded[fp].client_media_path).length;
  if (total) console.log(`  开始上传 ${total} 个（并发 ${CONC}${already ? `，跳过已传 ${already}` : ''}）…`);
  async function uploadOne(i) {
    const fp = files[i];
    const name = path.basename(fp);
    if (entry.uploaded[fp] && entry.uploaded[fp].client_media_path) { done++; return; }
    const origSize = fs.statSync(fp).size;
    let uploadPath = fp, uploadName = name, uploadMime = guessVideoMime(name), tmp = null, note = `${(origSize / 1048576).toFixed(1)}MB 原片`;
    if (ffmpeg) {
      tmp = path.join(os.tmpdir(), `chenyu-proxy-${process.pid}-${i}.mp4`);
      try {
        await compressVideoProxy(ffmpeg, fp, tmp, proxyH);
        uploadPath = tmp; uploadName = name.replace(/\.[^.]+$/, '') + `_${proxyH}p.mp4`; uploadMime = 'video/mp4';
        note = `${(origSize / 1048576).toFixed(1)}MB→${(fs.statSync(tmp).size / 1048576).toFixed(1)}MB`;
      } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } tmp = null; uploadPath = fp; note = `${(origSize / 1048576).toFixed(1)}MB 原片(压缩失败)`; }
    }
    const upSize = fs.statSync(uploadPath).size;
    const signed = await api(`/api/projects/${pid}/client-media/signed-upload`, { method: 'POST', body: { kind: 'video', filename: uploadName, mimeType: uploadMime, size: upSize } });
    const uploadUrl = signed.upload?.uploadUrl || signed.uploadUrl;
    const mediaPath = signed.upload?.path || signed.path;
    if (!uploadUrl || !mediaPath) { if (tmp) try { fs.rmSync(tmp, { force: true }); } catch { /* */ } die('获取视频上传地址失败'); }
    const put = await fetch(uploadUrl, { method: 'PUT', body: fs.readFileSync(uploadPath), headers: { 'Content-Type': uploadMime } });
    if (tmp) try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    if (!put.ok) die(`视频上传失败（HTTP ${put.status}）：${name}`);
    entry.uploaded[fp] = { client_media_path: mediaPath, title: name, mime_type: uploadMime, size_bytes: upSize };
    saveVideoManifest(manifest); // Node 单线程，writeFileSync 原子；并发 worker 共享同一 manifest 对象
    done++;
    console.log(`  ✓ ${done}/${total}  ${name}  ${note}`);
  }
  // 有界并发池：CONC 个 worker 抢 nextIdx，抢完即止
  await Promise.all(Array.from({ length: Math.min(CONC, total || 1) }, async () => {
    for (let i = nextIdx++; i < total; i = nextIdx++) await uploadOne(i);
  }));
  // 组 videos：URL 在前，本地文件按原顺序在后
  const videos = urls.map((u, i) => ({ video_url: u, episode_id: String(i + 1).padStart(3, '0') }));
  files.forEach((fp, i) => {
    const u = entry.uploaded[fp];
    videos.push({ client_media_path: u.client_media_path, episode_id: String(urls.length + i + 1).padStart(3, '0'), title: u.title, mime_type: u.mime_type, size_bytes: u.size_bytes });
  });
  console.log(`✓ 全部 ${videos.length} 个视频就绪，开始反推…`);
  // 注意：--extra 是洗稿指令，只能进 auto_rewrite，绝不能当视频分析 prompt——否则
  // 视频模型会照着洗稿指令"分析"(如把画面里的柚子直接分析成西瓜)，污染忠实反推。
  // 视频分析要忠实描述原视频；真需要分析指引用 --analysis-note（默认空=纯忠实反推）。
  const analysisNote = arg('analysis-note', '');
  await api(`/api/projects/${pid}/video-reverse/start`, { method: 'POST', body: { videos, auto_start_workflow: true, ...(analysisNote ? { prompt: analysisNote } : {}) } });
  entry.started = true; saveVideoManifest(manifest);
  if (market) console.log(`✓ 已开始反推，完成后自动洗成《${MARKETS[market]}》剧本（时长跟随源视频，${count} 集）`);
  else console.log('✓ 已开始反推成剧本稿（未选 --market，不自动洗稿；反推稿可在网页「剧本洗稿·选历史项目」里用）');
  console.log(`下一步: chenyu-pro status --project ${pid.slice(-8)} --watch  盯反推${market ? '+洗稿' : ''}进度`);
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

// 续跑已暂停的项目（首批完成后平台会 paused 等确认）。走平台 start-auto 从
// 已完成集之后继续，绝不重扣已生成的集，也绝不该由你手写后续集。范围三选一：
// 默认续下一批(平台默认3集) / --episodes N 再跑指定 N 集 / --full 一次跑完剩余全部。
async function cmdContinue() {
  const fragment = arg('project') || die('缺 --project <id片段或剧名>');
  const p = await findProject(fragment);
  const done = Number(p.completed_episodes || 0);
  const total = Number(p.total_episodes || 0);
  if (['running', 'processing', 'queued'].includes(String(p.status))) {
    console.log(`《${p.title}》正在跑（${p.status}，${done}/${total}），无需重复触发。用 status --watch 盯进度。`);
    return;
  }
  if (total && done >= total) { console.log(`《${p.title}》已全部完成 ${done}/${total}，无需继续。用 fetch 取稿。`); return; }
  const remaining = total ? total - done : 0;
  // 三种续跑范围：--episodes N 指定几集 > --full 剩余全部 > 默认下一批(平台默认3集)。
  const wantN = Math.max(0, Math.floor(Number(arg('episodes', '')) || 0));
  let body = {};
  let scope = '下一批';
  if (wantN > 0) {
    const n = remaining > 0 ? Math.min(wantN, remaining) : wantN;
    body = { episode_count: n };
    scope = `${n} 集`;
  } else if (flag('full') && remaining > 0) {
    body = { episode_count: remaining };
    scope = `剩余全部 ${remaining} 集`;
  }
  await api(`/api/projects/${p.id}/workflow/start-auto`, { method: 'POST', body });
  console.log(`✓ 已继续《${p.title}》：从第 ${done + 1} 集起（${scope}）。用 status --watch 盯进度，完成后 fetch 取稿。`);
  if (flag('watch')) { process.argv.push('--project', fragment, '--watch'); await cmdStatus(); }
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

function cmdVersion() {
  console.log(`chenyu-pro v${VERSION}`);
}

function cmdHelp() {
  console.log(`辰屿 Pro CLI v${VERSION} —— 剧本生产平台命令行

  chenyu-pro login --web                                   网页授权登录你的账号（推荐；项目归你账号，KEY 自动带出）
  chenyu-pro login --username <账号> --password <密码>     密码登录你的账号
  chenyu-pro key set <积分KEY> | key show                  仅绑积分 KEY（快速免密，但走独立身份）
  chenyu-pro credits                                       查用户名·余额
  chenyu-pro estimate --episodes 30 [--director-cut]       预估消耗+余额校验
  【B路·洗稿(照原剧情忠实换壳，集数1:1、不卡每集时长、逐集质量门)】
  chenyu-pro submit --mode rewrite --title <剧名> --episodes 30 --market japan_ja \\
      (--source 源剧本.txt | --from-project <反推母项目id片段>) \\
      [--director-cut] [--extra "补充要求"] [--batch 3]
      --from-project: 复用某个视频反推稿去洗"另一个市场版"(不重反推，省钱)
  chenyu-pro submit --mode video (--video-url <链接> | --video-file <本地.mp4>) [--market us_en] \\
      视频反推洗稿(B路)：先反推成剧本稿(另存母项目可复用)；带 --market 反推完自动洗稿(时长跟源视频)
      --video-url 链接 / --video-file 本地文件(自动上传R2)；多个逗号分隔，可混用
      本地文件有 ffmpeg 时自动压到 480p 再传(反推只用低清代理，快一个数量级；--no-compress 关)
      大批量本地文件支持断点续传：中断后重跑同一条命令，自动跳过已传、只补未传
  【A路·蓝图(原创 / 网文改编，剧本仅作参考再创作)】
  chenyu-pro submit --mode original --title <剧名> --episodes 30 [--market us_en]   原创剧(走蓝图)
  chenyu-pro submit --mode adaptation --title <剧名> --source 小说.txt [--market japan_ja]  网文改编(走蓝图)
      --market: 原创/改编也能面向国外市场——蓝图与正文按目标市场名字/货币/称谓原生落地(不给=中文)
      可选市场: us_en/latam_es/brazil_pt/japan_ja/korea_ko/thailand_th/vietnam_vi/indonesia_id
  chenyu-pro status --project <id片段|剧名> [--watch]      查/盯进度
  chenyu-pro continue --project <id片段|剧名> [--episodes N|--full] [--watch]  续跑(不重扣):
                        默认下一批, --episodes 5 再跑5集, --full 剩余全部
  chenyu-pro fetch --project <id片段> --out <目录>          导出交付正文到本地
  chenyu-pro sync --project <id片段|剧名>                   同步到云端脚本库（辰屿客户端可下载）
  chenyu-pro projects                                      项目列表

  市场: ${Object.entries(MARKETS).map(([k, v]) => k + '=' + v).join(' ')}
  升级: irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex`);
}

const commands = { login: cmdLogin, key: cmdKey, credits: cmdCredits, estimate: cmdEstimate, submit: cmdSubmit, status: cmdStatus, continue: cmdContinue, fetch: cmdFetch, sync: cmdSync, projects: cmdProjects, version: cmdVersion, '--version': cmdVersion, '-v': cmdVersion, help: cmdHelp };
await (commands[cmd] || cmdHelp)();
