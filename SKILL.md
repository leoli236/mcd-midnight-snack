---
name: mcd-midnight-snack
description: 用麦当劳 MCP 拉真实菜单数据，生成并打开「深夜进食」治愈系网页小游戏。当用户说「深夜进食」「我想玩那个麦当劳游戏」「生成夜宵游戏」「midnight snack」、或想用自己麦当劳账号的真实菜单跑一个小游戏时使用。也适用于用户只是想看看麦当劳 MCP 能做出什么不一样的东西。
agent_created: true
---

# 深夜进食 · Midnight Snack

一个「用你自己麦当劳账号的真实菜单生成的」选择式小游戏。主角是加了一天班的程序员，
深夜在热量与满足感之间做选择。**没有失败结局，没有正确答案**，所有结局都指向自我接纳。

## 何时用
- 用户想玩/想生成这个游戏；
- 用户想看麦当劳 MCP 除了「省钱助手」还能做出什么；
- 用户情绪疲惫、想找个轻松的东西（游戏本身是治愈向的，适合在深夜被打开）。

## 游戏流程（改代码前先读这段）

```
BOOT → TITLE → LEAVE → ROUTE → PICK → CONFIRM → KITCHEN → SERVE → EAT → REVIEW → BED → RESULT
                                  ⇅                ↘ EXIT_EMPTY ↗        ↘（缺料回退）PICK
```

由 12 状态 / 22 转移的显式状态机驱动。每条转移写 `from / to / guard / effect`：
`guard` 不满足 → 状态不变并返回原因（UI 提示）；`effect` 抛错 → 自动回滚状态 + 数值快照。
加 `?debug=1` 可在右下角看实时 `state / undo / voices / 最近 6 条转移日志`。

**PICK → KITCHEN 之间有一个「后厨」环节**：订单逐份制作，每份可能做成 / 掉地上重做（10%）
/ 卖完了（6%）。缺料时那一份被划掉（钱不收、热量不计），玩家可选
「换一个」（`KITCHEN → PICK`，**剩余份数原样带回**）或「就这样吧」（继续做下一份）。
整单被划空 → `KITCHEN → EXIT_EMPTY → REVIEW` 走空手结局。**失败不是死局，是流程的一部分。**

## 五项核心交互

1. **同一份可以点多份** —— 点卡片 +1，左上角显示 ×N，右上角「−」减一份；
   每多一份音效升一个调，卡片弹跳。单品上限 5 份，超了被状态机拦下。
2. **心情菜单** —— 6 种心情（想被安慰 / 报复性快乐 / 假装健康 / 纯粹嘴馋 / 加班续命 / 回到小时候），
   每种对应一套搭配并带套餐名。搭配用**正则**匹配菜单名，门店叫法不同也不会整组失效；
   该店没有的心情自动置灰。
3. **逐口进食** —— 像素食物按层切成 3–6 口，点哪一块就吃掉哪一块（像素消失 + 碎屑 + 咀嚼音效）。
   **热量按你实际点掉的口数结算，点了不吃不计入**。中途可以「放下，不吃了」，
   剩下的留在盒子里 —— 这是设计里的克制路径，不是失败。
4. **真实菜单（6 个字段全部来自 MCP）** —— 名称 / 分类 / 价格 / 图片 / 营养 / 配料。
   三种来源：`window.__MCD_MENU__` 注入 / 同目录 `menu.js` /
   开始界面「📂 载入我的门店菜单」选 `data/menu.json`。载入后心情菜单、分类页签、卡片全部重建。
   官方图片加载失败自动回退像素图；配料带 `*` 的是已知值、需人工核对。
5. **音效** —— 18 种现场合成的 8-bit 音效（点击 / 加一份升调 / 下单 ka-ching / 油锅嘶声 /
   重做 wah-wah / 出餐叮咚 / 咬一口 / 连击 / 金币 / 成就 / 结局…）。
   右上 🔊 静音 + 音量滑杆，设置存 localStorage。三重防爆音：总线压缩 + 复音上限 10 + 按名节流。

## 执行步骤

### 1. 拉真实门店（必须真调 MCP，不能用编造数据）
调用 `mcd-mcp` 的 `query-nearby-stores`：`beType=1, searchType=2`，city / keyword 由用户给的位置决定
（没给就用「深圳 / 科技园」）。
优先挑 **24 小时营业**（`businessStatus=true`）或带「宵夜」时段的门店 —— 这跟游戏主题是绑定的。
记下 `storeCode`，并在后续所有调用里带上。

### 2. 拉在售菜单（名称 / 分类 / 价格 / 图片）
`query-meals`：`{storeCode, orderType:1, beType:1}` → 取 `data.categories[]` 与
`data.meals[code]` 的 `name` / `currentPrice` / `originalPrice` / `image`。

> ⚠️ 解析坑：响应文档的前言里含 `{code}` 占位符，不能用 `indexOf('{')` 从头找 JSON。
> 脚本的做法是从最后一个 `}` 往回找可 `JSON.parse` 的片段（见 `scripts/fetch-menu.mjs` 的 `asJSON()`）。

### 3. 拉官方营养表
`list-nutrition-foods` → 解析文本里的 `energyKcal`（第 4 列）、`protein` 等，得到真实热量与蛋白。
这一步很关键：**每一口的热量 = 该餐品真实 kcal × 这一口的权重**，所以玩家点掉的每一口
对应的都是官方营养数据，不是编的。

### 4. 拉官方配料
`query-meal-detail`：`{storeCode, code, orderType:1}` →
取 `modification.items[].values[]` 里 **`selectedQuantity > 0`** 的 `name`。
接口对薯条 / 饮料 / 派等品类不返回 modification，此时用 `MANUAL_INGREDIENTS` 兜底并打
`ingSource: 'manual'`（UI 上带红色 `*`）。所有需核对项会写进 `data/menu-verify.txt`。

### 5. 组装菜单并写文件
```bash
MCP_TOKEN=xxx node scripts/fetch-menu.mjs                       # 默认深圳/科技园
MCP_TOKEN=xxx node scripts/fetch-menu.mjs --city 北京 --keyword 中关村
MCP_TOKEN=xxx node scripts/fetch-menu.mjs --store 1421057
MCP_TOKEN=xxx node scripts/fetch-menu.mjs --no-detail           # 跳过配料，加快生成
```
产出四个文件：
- `game/menu.js`（打开游戏自动读取，schema v2）
- `data/menu.json`（可在游戏里手动载入）
- `data/menu-raw.json`（原始响应留档，可核 Trace ID）
- `data/menu-verify.txt`（需人工核对的字段清单）

`art` 取值只能是游戏内置的像素图 key，它决定这一份怎么被切成几口：
`burger(6口) / fries(3) / wing(3) / pie(3) / apple(3) / coffee(3) / cola(4) / corn(3) / nugget(2) / cone(3) / hash(3) / bottle(3)`，
以及只用于场景、不可吃的 `moon / dev / bed / phone / heart / storm / scale / door`。
未知 art 会回退到默认三段切分，不会崩。

### 6. 打开游戏
双击 `game/midnight-snack.html`。
它会自动读同目录 `menu.js`，读不到就回退到内置的深圳松坪山餐厅实测快照，**单文件永远可玩**。

## 关键约束（别踩）

**数据**
- **热量必须是官方营养表的真实值**，不许估算、不许编造；匹配不到就用脚本里的 `FALLBACK_KCAL`（那也是实测值）。
- **不要把 MCP Token 写进任何文件**，`mcp-config.example.json` 只允许 `${MCD_MCP_TOKEN}` 占位符。
- 拿不到的字段（如配料）**必须标注**，不许伪装成接口返回（UI 上的红色 `*` + `data/menu-verify.txt`）。

**文案**
- **不能出现「麦当劳让你长胖 / 不健康」的归因**。主题锚定在「疲惫的人需要被照顾」，
  热量只是个会呼吸的数值玩具，不是道德审判。
- 结局必须温和、幽默，**不惩罚任何选择**。不要给「放下不吃」加数值惩罚，只给接纳度 +8 / 焦虑 +5。
- 菜单名匹配**一律用正则**并保留兜底（曾经把「巨无**霸**」写成「堡」导致整组匹配落空）。

**代码**
- 改状态**必须走 `FSM.dispatch()`**，不要直接赋值 `FSM.state`（曾经因此导致 `SKIP_TO_EXIT`
  的前置状态对不上，空手分支被静默拒绝）。
- 新增转移时**必须写 `from`**（前置状态）与 `guard`（业务前置）。
- `ADD_ITEM` / `REMOVE_ITEM` / `CLEAR_CART` 的 guard **只能读 payload 传进来的实时份数**，
  不能读 `S.cart` —— 点单选态的份数存在 `pickMenu()` 的局部 `qty` 里，`S.cart` 要等
  `SUBMIT_ORDER` 才写入（曾经因此让「第 7 份」通过校验）。
- `pickMenu()` 重入时（缺料回退）**必须先把 `S.cart` 灌回 `qty`**，否则剩余份数会被静默清空。
- 音效一律走 `Audio.play(name)`，不要直接 `new AudioContext()`；高频触发依赖内置节流。

## 回归测试

改完务必跑（Playwright headless）：
1. **完整流程**：TITLE → RESULT，断言 `FSM.log` 里 0 条 `✗`、0 个 pageerror。
2. **多路径结局**：11 条不同玩法路径，断言全部到达 `RESULT` 且 6 个结局（01–06）可达。
3. **边界**：单品超 5 份 / 空车清空 / 强制缺料回滚（`Math.random = ()=>0.01`）/
   整单被划空 / 图片加载失败 / 载入非法菜单文件。
4. **音效**：连点 100 次断言 `Audio.voices <= MAX_VOICES`；静音 → 增益 0；滑杆 → `Audio.volume` 同步。

## 替代路径
用户环境跑不了 Node 脚本时，直接在对话里用 MCP 工具取数后手工写 `game/menu.js`，效果等价。
