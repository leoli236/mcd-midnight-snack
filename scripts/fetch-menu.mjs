#!/usr/bin/env node
/**
 * fetch-menu.mjs —— v2 菜单构建器
 *
 * 一次跑完 4 类 MCP 调用，产出带「分类 / 价格 / 官方图片 / 食材 / 营养成分」的完整菜单：
 *   query-nearby-stores   门店
 *   query-meals           在售菜单（13 个分类）+ 真实售价 + 官方图片 URL
 *   list-nutrition-foods  官方营养表（能量 / 蛋白 / 脂肪 / 碳水 / 钠 / 钙）
 *   query-meal-detail     官方特调项 → 这就是「所需食材」的真实来源
 *
 * 用法：
 *   MCP_TOKEN=<token> node scripts/fetch-menu.mjs
 *   MCP_TOKEN=<token> node scripts/fetch-menu.mjs --city 北京 --keyword 中关村
 *   MCP_TOKEN=<token> node scripts/fetch-menu.mjs --store 1421057
 *   MCP_TOKEN=<token> node scripts/fetch-menu.mjs --no-detail   # 跳过餐品详情（离线/限流时用）
 *
 * 产出：
 *   game/menu.js        游戏自动读取（存在则覆盖内置菜单）
 *   data/menu.json      同一份数据的 JSON 版（可在游戏里手动载入）
 *   data/menu-raw.json  三个接口的原始响应，用于人工核对
 *   data/menu-verify.txt 需人工核对的字段清单
 *
 * 依赖：Node >= 18（内置 fetch）。零第三方包。
 *
 * ⚠️ 数据核对约定：凡是接口没给、由本脚本推算或沿用近似值的字段，
 *    都会写进每个餐品的 needVerify 数组，并打印到 data/menu-verify.txt。
 */

const MCP_URL = process.env.MCP_URL || 'https://mcp.mcd.cn';
const TOKEN = process.env.MCP_TOKEN;

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);
const CITY = arg('city', '深圳');
const KEYWORD = arg('keyword', '科技园');
const STORE = arg('store', null);
const NO_DETAIL = flag('no-detail');

/* =========================================================
   策划表：游戏里出现的餐位
   ---------------------------------------------------------
   code      query-meals 的餐品码（主）
   altCodes  该门店售罄 / 下架时的替代码，按顺序尝试（保证菜单不空）
   art       游戏内置像素图 key —— 决定它「被一口一口吃掉」时怎么分层
   nutri     list-nutrition-foods 里的对应名（官方营养表条目名）
   joy       游戏内满足感系数（非官方数据，可调）
   note      游戏文案（非官方数据，可调）
   ========================================================= */
const CURATED = [
  // —— 汉堡 ——
  { code:'1100',  altCodes:['1120'],        art:'burger', nutri:'巨无霸',       joy:34, note:'今天的最后一层 stack' },
  { code:'1120',  altCodes:['1100'],        art:'burger', nutri:'双层吉士汉堡', joy:30, note:'两片肉，一份倔强' },
  { code:'1406',  altCodes:['1440'],        art:'burger', nutri:'板烧鸡腿堡',   joy:31, note:'滋滋作响的那一片' },
  { code:'1440',  altCodes:['1450'],        art:'burger', nutri:'麦辣鸡腿汉堡', joy:33, note:'辣到忘了需求文档' },
  { code:'1450',  altCodes:['1440'],        art:'burger', nutri:'麦香鸡',       joy:24, note:'最便宜的安慰' },
  // —— 小食 ——
  { code:'4810',  altCodes:['521901'],      art:'fries',  nutri:'中薯条',       joy:26, note:'酥脆是唯一的正义' },
  { code:'521901',altCodes:['4810'],        art:'fries',  nutri:'脆脆薯条',     joy:27, note:'扭了七下，像你的作息' },
  { code:'1700',  altCodes:['520445'],      art:'wing',   nutri:'麦辣鸡翅-2块', joy:28, note:'烫的那只永远最好吃' },
  { code:'1401',  altCodes:['521143'],      art:'nugget', nutri:'麦乐鸡5块',    joy:25, note:'蘸酱才是本体' },
  { code:'521994',altCodes:['1401'],        art:'nugget', nutri:'麦麦趣鸡球',   joy:26, note:'新品，所以你必须试试' },
  { code:'9900016566', altCodes:['9900016082'], art:'hash', nutri:'脆薯饼',     joy:22, note:'心形的，适合发给没人回的消息' },
  // —— 甜品 ——
  { code:'9900015165', altCodes:['521922'], art:'pie',    nutri:'香芋派',       joy:24, note:'烫嘴是它唯一的防御机制' },
  { code:'521922', altCodes:['9900015165'], art:'pie',    nutri:'菠萝派',       joy:25, note:'大米味的，像小时候的锅巴' },
  { code:'521717', altCodes:['515955'],     art:'cone',   nutri:'特浓奶香雪冰中杯', joy:30, note:'深夜的合法甜' },
  // —— 饮品 ——
  { code:'9900008751', altCodes:['2430'],   art:'cola',   nutri:'可乐中杯',     joy:18, note:'气泡撑起今晚的体面' },
  { code:'3755',  altCodes:['510041'],      art:'coffee', nutri:'纯牛奶（盒装）', joy:15, note:'像小时候有人管你那样' },
  { code:'520689',altCodes:['507411'],      art:'coffee', nutri:'大杯鲜萃咖啡', joy:14, note:'续命，但续的是明天的命' },
  { code:'3505',  altCodes:['6362'],        art:'coffee', nutri:'锡兰红茶',     joy:12, note:'喝这个显得你很克制' },
  { code:'3757',  altCodes:['6362'],        art:'bottle', nutri:'纯悦',         joy:6,  note:'水是水，你是你' },
  // —— 轻食 ——
  { code:'6102',  altCodes:['6362'],        art:'apple',  nutri:'苹果片',       joy:9,  note:'健康选项，但你知道的' }
];

/* 官方营养表里查不到时的兜底热量（仍为官方营养表中「近似品类」的实测值，非编造） */
const FALLBACK_KCAL = {
  '521901':279, '521994':266, '9900016566':146, '521922':221, '521717':269,
  '520689':13,  '9900008751':147, '3755':129, '3505':2, '3757':0, '6102':32
};

/* 接口拿不到配料时的已知配料（来自公开常识，⚠️ 需人工核对） */
const MANUAL_INGREDIENTS = {
  '4810':['马铃薯','植物油','食盐'],
  '521901':['马铃薯','植物油','调味料'],
  '1700':['鸡翅','小麦粉','辣椒调味料','植物油'],
  '1401':['鸡肉','小麦粉','植物油','淀粉'],
  '521994':['鸡肉','小麦粉','植物油','香辛料'],
  '9900016566':['马铃薯','植物油','淀粉','食盐'],
  '9900015165':['小麦粉','香芋馅','白砂糖','植物油'],
  '521922':['小麦粉','大米','白砂糖','植物油'],
  '521717':['椰奶','饮用水','白砂糖','乳粉'],
  '9900008751':['碳酸水','白砂糖','焦糖色','咖啡因'],
  '3755':['生牛乳'],
  '520689':['咖啡豆','饮用水'],
  '3505':['红茶','饮用水'],
  '3757':['饮用水'],
  '6102':['苹果']
};

/* ---------------- MCP Streamable HTTP 客户端 ---------------- */
let sessionId = null, seq = 0, traceIds = {};

async function rpc(method, params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer ' + (TOKEN || '')
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(MCP_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`MCP HTTP ${res.status} —— ${t.slice(0, 300)}`);
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream') || /\ndata:/.test('\n' + text)) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try { last = JSON.parse(d); } catch (_) {}
    }
    if (last) return last;
    throw new Error('SSE 响应解析失败：' + text.slice(0, 300));
  }
  return JSON.parse(text);
}

/* MCP 返回体可能是 JSON，也可能是「说明文档 + ## Original Response + JSON」。
   注意：说明文档里会出现 `data.meals.{code}.withOrder` 这类占位符，
   所以不能简单取第一个 '{' —— 必须试解析，且优先取文档末尾那段真正的响应体。 */
function asJSON(text) {
  if (typeof text !== 'string') return text;
  const t = text.trim();
  try { return JSON.parse(t); } catch (_) {}

  const marker = t.indexOf('Original Response');
  const seg = marker >= 0 ? t.slice(marker) : t;

  const end = seg.lastIndexOf('}');
  if (end > 0) {
    for (let i = seg.lastIndexOf('{', end); i >= 0; i = seg.lastIndexOf('{', i - 1)) {
      try {
        const o = JSON.parse(seg.slice(i, end + 1));
        if (o && typeof o === 'object') return o;
      } catch (_) {}
    }
  }
  const bend = seg.lastIndexOf(']');
  if (bend > 0) {
    for (let i = seg.lastIndexOf('[', bend); i >= 0; i = seg.lastIndexOf('[', i - 1)) {
      try {
        const o = JSON.parse(seg.slice(i, bend + 1));
        if (o) return o;
      } catch (_) {}
    }
  }
  return null;
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r && r.error) throw new Error(`MCP error ${r.error.code}: ${r.error.message}`);
  const res = r && r.result;
  const raw = (res && res.content || []).map(p => p.text).filter(Boolean).join('\n');
  const obj = asJSON(raw);
  const data = obj && obj.data !== undefined ? obj.data : obj;
  if (obj && obj.traceId) traceIds[name] = obj.traceId;
  return { data, raw };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  if (!TOKEN) {
    console.error('✗ 缺少环境变量 MCP_TOKEN。\n  获取方式：https://open.mcd.cn/mcp 登录后在「控制台」申请。\n  用法：MCP_TOKEN=xxx node scripts/fetch-menu.mjs');
    process.exit(1);
  }
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(new URL('..', import.meta.url).pathname);

  console.log('→ initialize');
  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'mcd-midnight-snack', version: '2.0.0' }
  });
  await rpc('notifications/initialized', {}).catch(() => {});

  /* 1) 门店 */
  let storeCode = STORE, storeName = '(直接指定)', storeRaw = null;
  if (!storeCode) {
    console.log(`→ query-nearby-stores  city=${CITY} keyword=${KEYWORD}`);
    const { data, raw } = await callTool('query-nearby-stores', { beType: 1, searchType: 2, city: CITY, keyword: KEYWORD });
    storeRaw = raw;
    const list = Array.isArray(data) ? data : (data && data.data);
    if (!Array.isArray(list) || !list.length) throw new Error('未找到门店，换个 --city / --keyword 试试');
    const pick = list.find(s => s.businessStatus) || list[0];
    storeCode = pick.storeCode; storeName = pick.storeName;
  }
  console.log(`  门店：${storeName} (${storeCode})`);

  /* 2) 在售菜单（含分类 / 价格 / 官方图片） */
  console.log('→ query-meals');
  const { data: mealData, raw: mealRaw } = await callTool('query-meals', { storeCode, orderType: 1, beType: 1 });
  const categories = (mealData && mealData.categories) || [];
  const meals = (mealData && mealData.meals) || {};
  console.log(`  分类 ${categories.length} 个 · 在售餐品 ${Object.keys(meals).length} 个`);

  /* 3) 官方营养表 */
  console.log('→ list-nutrition-foods');
  const { data: nutriData, raw: nutriRaw } = await callTool('list-nutrition-foods', {});
  const NUT = new Map();
  const rows = typeof nutriData === 'string'
    ? nutriData.split(/\r?\n/).slice(1)
    : (Array.isArray(nutriData) ? nutriData : []);
  for (const line of rows) {
    const c = String(line).trim().split(',');
    if (c.length < 9) continue;
    const name = c[0].trim();
    if (!name) continue;
    NUT.set(name, {
      kcal: parseInt(c[3], 10) || 0,
      protein: parseFloat(c[4]) || 0,
      fat: parseFloat(c[5]) || 0,
      carb: parseFloat(c[6]) || 0,
      sodium: parseInt(c[7], 10) || 0,
      calcium: parseInt(c[8], 10) || 0
    });
  }
  console.log(`  营养条目 ${NUT.size} 条`);

  /* 4) 逐个餐位组装（含官方配料） */
  const verify = [];   // 需人工核对的字段
  const items = [];
  const catIndex = new Map();
  categories.forEach(c => (c.meals || []).forEach(m => {
    if (!catIndex.has(m.code)) catIndex.set(m.code, String(c.name).replace(/\s+/g, ''));
  }));

  for (const spec of CURATED) {
    /* 4.1 找到该餐品（主码 → 替代码） */
    let code = spec.code, m = meals[code];
    if (!m) {
      for (const alt of spec.altCodes || []) {
        if (meals[alt]) { code = alt; m = meals[alt]; verify.push(`${spec.code} 在该店不可售，已改用替代 ${alt}（${m.name}）`); break; }
      }
    }
    if (!m) { console.warn(`  ⚠ ${spec.code} 该门店无售且无替代，跳过`); verify.push(`${spec.code} 该门店无售，已从菜单移除`); continue; }

    const price = parseFloat(m.currentPrice ?? m.originalPrice ?? '0');
    const originalPrice = parseFloat(m.originalPrice ?? m.currentPrice ?? '0');
    if (!price) verify.push(`${m.name} 未取到售价（显示 ¥0）`);

    /* 4.2 营养 */
    let nut = NUT.get(spec.nutri) || null, nutriName = spec.nutri;
    if (!nut) {
      for (const [k, v] of NUT) { if (k.includes(m.name) || m.name.includes(k)) { nut = v; nutriName = k; break; } }
    }
    const kcal = nut ? nut.kcal : (FALLBACK_KCAL[code] ?? FALLBACK_KCAL[spec.code] ?? 0);
    if (!nut) verify.push(`${m.name} 官方营养表无「${spec.nutri}」条目，热量 ${kcal} 为近似品类值，需人工核对`);

    /* 4.3 配料（query-meal-detail 的官方特调项） */
    let ingredients = [], ingSource = 'none', image = m.image || null;
    if (!NO_DETAIL) {
      try {
        const { data: d } = await callTool('query-meal-detail', { storeCode, orderType: 1, beType: 1, code });
        if (d) {
          if (d.image && /\.(png|jpe?g|gif|webp)$/i.test(d.image)) image = d.image;   // 详情图分辨率更高
          const modItems = (d.modification && d.modification.items) || [];
          for (const g of modItems) {
            for (const v of (g.values || [])) {
              /* 只取「默认已选中」的项 —— 那才是这一份真做出来的配料 */
              if (v.selectedQuantity > 0) ingredients.push(v.name);
            }
          }
          if (ingredients.length) ingSource = 'mcp-modification';
        }
      } catch (e) {
        verify.push(`${m.name} query-meal-detail 调用失败（${e.message}），配料改用已知值`);
      }
    }
    if (!ingredients.length && MANUAL_INGREDIENTS[code]) {
      ingredients = MANUAL_INGREDIENTS[code]; ingSource = 'manual';
      verify.push(`${m.name} 的配料为已知值（非接口返回），需人工核对`);
    }
    if (!ingredients.length) verify.push(`${m.name} 无配料数据`);

    items.push({
      id: code, code, name: m.name,
      category: catIndex.get(code) || '其他',
      price, originalPrice,
      image,
      art: spec.art,
      nutrition: {
        kcal,
        protein: nut ? nut.protein : null,
        fat: nut ? nut.fat : null,
        carb: nut ? nut.carb : null,
        sodium: nut ? nut.sodium : null,
        calcium: nut ? nut.calcium : null,
        _from: nut ? nutriName : 'fallback'
      },
      ingredients,
      ingSource,
      joy: spec.joy,
      note: spec.note,
      status: 'on-sale',
      needVerify: nut ? [] : ['nutrition.kcal', 'nutrition.*']
    });
  }

  if (!items.length) throw new Error('一个餐位都没组装出来，检查门店或 CURATED 表');

  /* 5) 输出 */
  const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const cats = [...new Set(items.map(i => i.category))];
  const payload = {
    schema: 2,
    store: {
      code: String(storeCode), name: storeName, city: CITY, keyword: KEYWORD,
      fetchedAt: stamp, source: MCP_URL, traceIds
    },
    categories: cats,
    items
  };

  const js =
`/* game/menu.js —— 由 scripts/fetch-menu.mjs 自动生成（schema v2），请勿手改
 * 数据源：麦当劳 MCP Server (${MCP_URL})
 * 门店：${storeName} · storeCode ${storeCode}
 * 生成时间：${stamp} (UTC+8)
 *   分类 / 售价 / 图片 = query-meals
 *   热量 / 蛋白 / 脂肪 / 碳水 / 钠 / 钙 = list-nutrition-foods
 *   配料 ingredients = query-meal-detail 的官方特调项（selectedQuantity > 0）
 * traceId: ${Object.entries(traceIds).map(([k, v]) => k + '=' + v).join(' · ') || '-'}
 *
 * ⚠️ 需人工核对的字段：见 data/menu-verify.txt
 */
window.__MCD_MENU__ = ${JSON.stringify(payload, null, 2)};
`;
  await fs.writeFile(path.join(root, 'game', 'menu.js'), js, 'utf8');
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'menu.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(root, 'data', 'menu-raw.json'),
    JSON.stringify({ stores: storeRaw, meals: mealRaw, nutrition: nutriRaw }, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(root, 'data', 'menu-verify.txt'),
    verify.length ? verify.map(v => '· ' + v).join('\n') + '\n' : '（无）\n', 'utf8');

  console.log('\n✓ 已生成 game/menu.js · data/menu.json · data/menu-raw.json · data/menu-verify.txt\n');
  console.log('  餐位              分类        售价    热量     蛋白/脂/碳   配料来源');
  items.forEach(i => {
    const n = i.nutrition;
    console.log('  ' + i.name.padEnd(10, '　').slice(0, 11) +
      ' ' + i.category.padEnd(7, '　') +
      ' ¥' + String(i.price).padStart(5) +
      ' ' + String(n.kcal).padStart(5) + 'kcal' +
      '  ' + `${n.protein ?? '-'}/${n.fat ?? '-'}/${n.carb ?? '-'}`.padStart(10) +
      '   ' + i.ingSource + '(' + i.ingredients.length + ')');
  });
  console.log('\n  ⚠️ 需人工核对 ' + verify.length + ' 项：');
  verify.slice(0, 20).forEach(v => console.log('    · ' + v));
  if (verify.length > 20) console.log('    … 其余见 data/menu-verify.txt');
  console.log('\n玩法：\n  1) 双击 game/midnight-snack.html（自动读 menu.js）');
  console.log('  2) 或开始界面点「📂 载入我的门店菜单」选 data/menu.json');
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
