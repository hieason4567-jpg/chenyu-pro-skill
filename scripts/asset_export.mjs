// 全局资产清单（纯本地、零积分）：从剧本的 场次头 / 人物： / 【形象】 / 【道具】 行汇总全剧人物、形象、场景、道具，
// 合并审核结论.json 里的外观描述，导出给下游建角色卡/场景图/道具图用。
const epTag = (n) => `第${String(n).padStart(3, '0')}集`;
const span = (set) => {
  const a = [...set].sort((x, y) => x - y);
  const parts = [];
  for (let i = 0; i < a.length; i++) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    parts.push(i === j ? `${a[i]}` : `${a[i]}–${a[j]}`);
    i = j;
  }
  return parts.join('、');
};
// 括号内的 、，, 换成／（多个归属），括号内的 ；; 保留（归属；状态 的分隔），只在括号外按 、，,；; 拆项
const splitList = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, (m) => m.replace(/[、，,]/g, '／').replace(/[；;]/g, '\u0001')).split(/[、，,；;]/).map((x) => x.replace(/\u0001/g, '；').trim()).filter(Boolean);

export function collectAssets(episodes, { looks = [], creatures = [] } = {}) {
  const people = new Map(); // 名 -> { eps:Set, lines, looks: Map(变体 -> { eps:Set, appearance }) }
  const scenes = new Map(); // 场景名 -> { eps:Set, times:Set }
  const casting = new Map(); // 集 -> Map(场次号 -> { 角色: 变体 })，客户端按场绑定 [角色-变体名]
  let sceneNo = '';
  const props = new Map(); // 道具名 -> { eps:Set, owners:Set, states:Set, counts:Set }
  const person = (name) => { if (!people.has(name)) people.set(name, { eps: new Set(), lines: 0, looks: new Map() }); return people.get(name); };
  const lookText = new Map(looks.map((x) => [`${String(x.role || '').trim()}=${String(x.variant || '').trim()}`, String(x.appearance || '')]));
  for (const { n, text } of episodes) {
    for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
      const l = raw.trim();
      const head = l.match(/^\d+\s*[-–—]\s*\d+\s+(日|夜|晨|昏|黄昏|清晨|傍晚|白天|夜晚)?\s*(内|外|室内|室外)?\s*(.+)$/);
      if (head && /^\d+-\d+\s/.test(l)) {
        sceneNo = l.match(/^(\d+-\d+)/)[1];
        const name = head[3].trim();
        if (!scenes.has(name)) scenes.set(name, { eps: new Set(), times: new Set() });
        scenes.get(name).eps.add(n);
        if (head[1] || head[2]) scenes.get(name).times.add(`${head[1] || ''}${head[2] || ''}`);
        continue;
      }
      if (/^人物[:：]/.test(l)) { for (const p of splitList(l.slice(3))) person(p).eps.add(n); continue; }
      if (l.startsWith('【形象】')) {
        for (const kv of l.slice(4).split(/[；;]/)) {
          const m = kv.match(/^\s*([^=＝]+)[=＝]\s*([^（(]+)(?:[（(]([^）)]*)[）)])?/);
          if (!m) continue;
          const who = m[1].trim(), v = m[2].trim();
          const p = person(who); p.eps.add(n);
          if (!p.looks.has(v)) p.looks.set(v, { eps: new Set(), scenes: 0, reason: '', appearance: lookText.get(`${who}=${v}`) || '' });
          const lk = p.looks.get(v);
          lk.eps.add(n); lk.scenes++;
          if (!lk.reason && m[3]) lk.reason = m[3].trim();
          if (sceneNo) {
            if (!casting.has(n)) casting.set(n, new Map());
            const byScene = casting.get(n);
            if (!byScene.has(sceneNo)) byScene.set(sceneNo, {});
            byScene.get(sceneNo)[who] = v;
          }
        }
        continue;
      }
      if (l.startsWith('【道具】')) {
        for (const item of splitList(l.slice(4))) {
          const inner = (item.match(/[（(]([^）)]+)[）)]/) || [])[1] || '';
          const [owner, ...stateParts] = inner.split(/[；;]/);
          const count = (item.match(/[×xX*](\d+)/) || [])[1] || '';
          const name = item.replace(/[（(][^）)]*[）)]/g, '').replace(/[×xX*]\d+/, '').trim();
          if (!name) continue;
          if (!props.has(name)) props.set(name, { eps: new Set(), owners: new Set(), states: new Set(), counts: new Set() });
          const pr = props.get(name); pr.eps.add(n);
          for (const o of String(owner || '').split('／')) if (o.trim()) pr.owners.add(o.trim());
          for (const s of stateParts) if (s.trim()) pr.states.add(s.trim());
          if (count) pr.counts.add(count);
        }
        continue;
      }
      const d = l.match(/^([^△（【\s][^：:（]{0,14})(?:（[^）]*）)?[：:]/);
      if (d && !/^(人物|形象|道具|场景|环境|画面)$/.test(d[1].trim()) && people.has(d[1].trim())) people.get(d[1].trim()).lines++;
    }
  }
  const creatureSet = new Set(creatures);
  return { people, scenes, props, creatureSet, casting };
}

export function renderAssetList({ people, scenes, props, creatureSet }, { title = '' } = {}) {
  const rows = [];
  rows.push(`# ${title ? title + ' · ' : ''}全局资产清单`, '');
  rows.push(`人物 ${people.size} 个（其中非人角色 ${[...people.keys()].filter((k) => creatureSet.has(k)).length} 个）｜形象 ${[...people.values()].reduce((s, p) => s + p.looks.size, 0)} 个｜场景 ${scenes.size} 个｜道具 ${props.size} 件`, '');
  rows.push('## 一、人物与形象', '', '| 人物 | 类型 | 出场集 | 台词句数 | 形象（变体名） | 外观 | 该形象出现集 |', '| --- | --- | --- | --- | --- | --- | --- |');
  const ordered = [...people.entries()].sort((a, b) => (b[1].lines - a[1].lines) || (Math.min(...a[1].eps) - Math.min(...b[1].eps)));
  for (const [name, p] of ordered) {
    const kind = creatureSet.has(name) ? '非人角色' : /数人|若干|\d+名|[二两三四五六七八九十]名/.test(name) ? '群体' : '人物';
    const looks = [...p.looks.entries()];
    if (!looks.length) rows.push(`| ${name} | ${kind} | ${span(p.eps)} | ${p.lines} | - | - | - |`);
    looks.forEach(([v, lk], i) => rows.push(`| ${i ? '' : name} | ${i ? '' : kind} | ${i ? '' : span(p.eps)} | ${i ? '' : p.lines} | ${v} | ${lk.appearance || '（待补外观）'} | ${span(lk.eps)} |`));
  }
  rows.push('', '## 二、场景', '', '| 场景 | 日夜/内外 | 出现集 |', '| --- | --- | --- |');
  for (const [name, s] of [...scenes.entries()].sort((a, b) => Math.min(...a[1].eps) - Math.min(...b[1].eps))) rows.push(`| ${name} | ${[...s.times].join('、') || '-'} | ${span(s.eps)} |`);
  rows.push('', '## 三、道具', '', '| 道具 | 归属 | 数量 | 出现集 | 场景中的状态/去向 |', '| --- | --- | --- | --- | --- |');
  for (const [name, pr] of [...props.entries()].sort((a, b) => b[1].eps.size - a[1].eps.size || Math.min(...a[1].eps) - Math.min(...b[1].eps))) rows.push(`| ${name} | ${[...pr.owners].join('、') || '-'} | ${[...pr.counts].join('/') || '-'} | ${span(pr.eps)} | ${[...pr.states].slice(0, 6).join('；') || '-'} |`);
  return rows.join('\n') + '\n';
}

// 道具叫法检查：同一件东西多个叫法（轮椅/空轮椅）、两件东西合成一项（托盘和药瓶）
export function propNameIssues({ props }) {
  const names = [...props.keys()];
  const issues = [];
  for (const n of names) if (/[和与及]/.test(n) && n.length > 3) issues.push(`「${n}」像是两件东西写成了一项——一件道具写一项`);
  const used = new Set();
  for (const a of [...names].sort((x, y) => x.length - y.length)) {
    if (used.has(a) || a.length < 2) continue;
    const same = names.filter((b) => b !== a && !used.has(b) && b.includes(a) && !/[和与及]/.test(b));
    if (same.length) { issues.push(`「${[a, ...same].join('」「')}」可能是同一件道具的不同叫法——全剧用一个名字，状态写进括号`); same.forEach((x) => used.add(x)); }
  }
  return issues;
}

export function assetListJson({ people, scenes, props, creatureSet }) {
  return {
    characters: [...people.entries()].map(([name, p]) => ({ name, creature: creatureSet.has(name), episodes: [...p.eps].sort((a, b) => a - b), dialogue_lines: p.lines, looks: [...p.looks.entries()].map(([variant, lk]) => ({ tag: `[${name}-${variant}]`, variant, appearance: lk.appearance, episodes: [...lk.eps].sort((a, b) => a - b) })) })),
    scenes: [...scenes.entries()].map(([name, s]) => ({ name, times: [...s.times], episodes: [...s.eps].sort((a, b) => a - b) })),
    props: [...props.entries()].map(([name, pr]) => ({ name, owners: [...pr.owners], states: [...pr.states], counts: [...pr.counts], episodes: [...pr.eps].sort((a, b) => a - b) }))
  };
}
const GROUP_RE = /数人|若干|\d+名|[二两三四五六七八九十]名|们$/;
const CREATURE_RE = /蛊|虫|蛾|蟾|蛙|螳螂|蜂|蛛|蝶|鸭|鹅|鸵鸟|鸟|兽|蛇|狐|猫|狗|犬|兔|龟|鼠|狼|熊/;
const HUMAN_LOOK_RE = /男|女|老人|老者|孩|西装|衬衫|外套|大衣|长袍|裙|裤|头发|盘发|短发|长发|辫/;

// 形象表（给客户端「上传形象表」用）：有这张表时客户端按表建角色形象卡、按场绑定 [角色-变体名]，不再让 AI 猜变体。
// main = 场次最多的那个形象；reason 取【形象】括号里第一次写的原因（伪装/回忆/受伤…）；scenes 按 集 -> 场次号 -> 角色=变体。
export function lookTableJson({ people, creatureSet, casting }, { title = '' } = {}) {
  const characters = [];
  for (const [name, p] of people) {
    const looks = [...p.looks.entries()];
    if (!looks.length) continue;
    const main = looks.reduce((a, b) => (b[1].scenes > a[1].scenes ? b : a))[0];
    characters.push({
      name,
      kind: creatureSet.has(name) || CREATURE_RE.test(name + (p.looks.get(main)?.appearance || '')) && !HUMAN_LOOK_RE.test(p.looks.get(main)?.appearance || '') ? 'creature' : GROUP_RE.test(name) ? 'group' : 'human',
      episodes: span(p.eps),
      looks: looks.map(([variant, lk]) => ({ variant, tag: `[${name}-${variant}]`, main: variant === main, reason: variant === main ? '' : lk.reason, appearance: lk.appearance, episodes: span(lk.eps) }))
    });
  }
  const scenes = {};
  for (const [n, byScene] of [...casting.entries()].sort((a, b) => a[0] - b[0])) scenes[n] = Object.fromEntries(byScene);
  return { schema: 'chenyu.look-table/v1', title, characters, scenes };
}

// 形象表体检：没写外观的形象、非主形象没写原因
export function lookTableIssues(table) {
  const issues = [];
  for (const c of table.characters) for (const l of c.looks) {
    if (!l.appearance) issues.push(`${l.tag} 没写外观（审核结论 looks 补 appearance：年龄段、发型、样貌、服装）`);
    if (!l.main && !l.reason) issues.push(`${l.tag} 不是主形象但没写因何而变（【形象】括号里写剧情原因：伪装/回忆/受伤/变身…；没有剧情原因的日常换装并入主形象）`);
  }
  return issues;
}

export { epTag };
