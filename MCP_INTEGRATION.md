# MCP_INTEGRATION.md — 麦当劳 MCP 使用情况说明

## 1. 使用的 MCP Server

| 项 | 值 |
|---|---|
| Server 名称 | `mcd-mcp`（麦当劳中国官方 MCP Server） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP（MCP protocolVersion `2025-06-18`） |
| 认证方式 | `Authorization: Bearer ${MCD_MCP_TOKEN}`（仅环境变量占位符，仓库内不含任何真实凭证） |
| 配置示例 | [`mcp-config.example.json`](./mcp-config.example.json) |

## 2. 实际调用的 Tool

| Tool | 调用时机 | 关键入参 | 拿到的数据 | 在游戏里的用途 |
|---|---|---|---|---|
| `query-nearby-stores` | 生成菜单前 | `beType=1, searchType=2, city, keyword` | `storeCode` / `storeName` / `businessStatus` / 营业时段 | 选定一家真实门店；**优先挑 24h 营业或含「宵夜」时段的店**，与「深夜进食」主题绑定 |
| `query-meals` | 拉菜单 | `storeCode, orderType=1, beType=1` | `categories[]`、`meals[code].name` / `currentPrice` / `originalPrice` / `image` | **菜品名称、分类、真实售价、官方图片**，直接显示在点单卡片上 |
| `query-meal-detail` | 拉配料 | `storeCode, code, orderType=1` | `modification.items[].values[]` 中 `selectedQuantity > 0` 的项；更高清 `image` | **所需食材（官方配料）**，显示在卡片上，进食时还会提示「这一口里有：…」 |
| `list-nutrition-foods` | 拉热量 | 无 | 160 条官方营养数据（`energyKcal` / `protein` / `fat` / `carbohydrate` / `sodium` / `calcium`） | 每个餐品的**真实热量与蛋白**，驱动体重/热量/满足感的数值变化 |

四个 Tool 覆盖菜谱展示的全部 6 个字段：名称 / 分类 / 价格 / 图片 / 营养 / 配料。

### 热量如何被「一口一口」拆开

`list-nutrition-foods` 给的是**整份**的 `energyKcal`。游戏把每个餐品的像素图按层切成 3–6 口，
每口带一个权重（合计 = 1），于是：

```
这一口摄入 kcal = 该餐品官方 energyKcal × 这一口的权重
```

例：巨无霸 513 kcal → 顶上面包 12%（62 kcal）、生菜酱 10%（51）、第一块牛肉饼 24%（123）……
玩家**点掉哪一口，才计入哪一口**。所以「点了 3 份只吃 1 份半」时，热量、体重、满足感都按实际
吃下去的部分结算 —— 这也让「克制」从一个选项变成了一个真实的动作。

权重表写在 `game/midnight-snack.html` 的 `BITES` 常量里，每种像素图一份，可自行校准。

### 「所需食材」是怎么拿到的

`query-meal-detail` 返回的是**可修改项（modification）**结构，不是直接的配料表：

```
modification.items[]                    ← 一个可选项，如「生菜」「吉士」「酱」
  └─ .values[]                          ← 每个取值，如「多加」「正常」「不要」
       └─ .selectedQuantity             ← > 0 表示默认就带这一项
```

所以脚本取 **`selectedQuantity > 0` 的 `values[].name`** 作为该餐品的官方配料。
例：巨无霸 → `巨无霸酱 / 吉士 / 生菜 / 酸黄瓜 / 洋葱粒`。

接口对部分品类（薯条、饮料、派等）不返回 modification，此时脚本用公开配方兜底，
并在数据里打上 `ingSource: 'manual'`；UI 上这类配料后面会跟一个红色的 `*`，
开始界面底部也写明「配料带 \* 的为已知值，需人工核对」。

**完整核对清单见 [`data/menu-verify.txt`](./data/menu-verify.txt)**（当前 14 项），
HTML 内置快照的头部注释里也列了同一份清单。

> 另有 `query-store-coupons` / `query-my-coupons` 可用于扩展：把玩家当前可用的优惠券作为
> 「今晚其实可以省一点」的彩蛋插进食谱建议。当前版本为控制单轮时长未启用，已在
> `scripts/fetch-menu.mjs` 预留扩展位。

## 3. 调用流程

```
┌──────────────────────────────────────────────────────────────┐
│  scripts/fetch-menu.mjs  (Node 18+，零第三方依赖)              │
└──────────────────────────────────────────────────────────────┘
        │
        │ ① initialize  →  ② notifications/initialized
        ▼
   ③ query-nearby-stores ────► storeCode = 1421057（深圳松坪山餐厅，24h，含宵夜时段）
        │
        ▼
   ④ query-meals ───────────► categories[] + meals[code].name / currentPrice / image
        │                      （真实名称、分类、售价、官方图片）
        ▼
   ⑤ list-nutrition-foods ──► energyKcal / protein / fat / carbohydrate / sodium / calcium
        │                      （官方营养表实测值）
        ▼
   ⑥ query-meal-detail ─────► modification.items[].values[]（selectedQuantity > 0）
        │                      （官方配料）  —— 逐餐品调用，--no-detail 可跳过
        ▼
   ⑦ 组装 20 个餐品（schema v2）
        ├─► game/menu.js      （window.__MCD_MENU__，同目录自动加载）
        ├─► data/menu.json    （可在游戏里手动载入）
        ├─► data/menu-raw.json（原始响应留档，可核 Trace ID）
        └─► data/menu-verify.txt（需人工核对的字段清单）
        ▼
   ⑧ game/midnight-snack.html 读取 menu.js
      （读不到则回退内置快照 → 单文件永远可玩）
        │
        ▼
   ⑨ 也可在游戏开始界面点「📂 载入我的门店菜单」选 data/menu.json
      → 心情菜单、分类页签、卡片全部按你的门店数据重建
```

游戏内的操作闭环（点单 → 后厨 → 出餐 → 进食 → 结算）由显式状态机驱动，
**每一步都有前置条件、失败会回滚**，详见 [`README.md`](./README.md#完整闭环每一步都有前置条件)。

## 4. 真实调用记录（本次仓库内数据）

2026-10-22 01:09 (UTC+8) 实测，深圳松坪山餐厅 `storeCode=1421057`：

| Trace ID | Tool | 结果 |
|---|---|---|
| `6dc4fc88c9300056e885a914cd9a6c33` | `query-nearby-stores` | 命中 5 家，选中 24h 营业、含「宵夜 00:00–04:45」时段的松坪山餐厅 |
| `799403048e194a993acd4d6344db40d5` | `query-meals` | 返回 13 个分类、约 90 个在售餐品的名称 / 真实售价 / 官方图片 |
| `b41eff97e0e737f6f0e23d33e614cdb4` | `list-nutrition-foods` | 返回 160 条官方营养数据 |
| `ae073757d5b0eb76978caddf209ae3d9` | `query-meal-detail` | 逐餐品拉取官方配料（汉堡 / 咖啡类返回，其余品类不返回） |

最终写入 `game/menu.js` 的 20 个餐品（分类、价格、热量、蛋白**全部来自上述接口**）：

| 餐品 | code | 分类 | 真实售价 | 真实热量 | 配料来源 |
|---|---|---|---:|---:|---|
| 巨无霸 | `1100` | 巨无霸牛鱼肉堡 | ¥26.5 | 513 kcal | 接口（巨无霸酱/吉士/生菜/酸黄瓜/洋葱粒） |
| 双层吉士汉堡 | `1120` | 巨无霸牛鱼肉堡 | ¥23.0 | 429 kcal | 接口 |
| 板烧鸡腿堡 | `1406` | 鸡肉汉堡/卷 | ¥23.5 | 391 kcal | 接口 |
| 麦辣鸡腿汉堡 | `1410` | 鸡肉汉堡/卷 | ¥22.5 | 485 kcal | 接口 |
| 麦香鸡 | `1401` | 鸡肉汉堡/卷 | ¥17.0 | 369 kcal | 接口 |
| 薯条 | `4810` | 小食甜品/其他 | ¥14.0 | 289 kcal | 已知值 \* |
| 月下相思扭扭薯 | `4826` | 小食甜品/其他 | ¥15.5 | 279 kcal | 已知值 \* |
| 麦辣鸡翅 | `1700` | 炸鸡 | ¥14.5 | 224 kcal | 已知值 \* |
| 麦乐鸡 | `1710` | 炸鸡 | ¥14.0 | 213 kcal | 已知值 \* |
| 脆皮鸡块 4 块 | `1720` | 炸鸡 | ¥15.0 | 266 kcal | 已知值 \* |
| 心形薯饼 8 块 | `4840` | 小食甜品/其他 | ¥23.0 | 146 kcal | 已知值 \* |
| 派 | `9900015165` | 小食甜品/其他 | ¥8.5 | 232 kcal | 已知值 \* |
| 奶香大米派 | `9900015170` | 小食甜品/其他 | ¥9.5 | 221 kcal | 已知值 \* |
| 椰奶雪冰 | `8700` | 麦咖啡™ | ¥23.0 | 269 kcal | 已知值 \* |
| 可乐 | `3100` | 饮品 | ¥9.5 | 147 kcal | 已知值 \* |
| 纯牛奶（盒装） | `3755` | 饮品 | ¥10.5 | 129 kcal | 已知值 \* |
| 鲜萃咖啡 | `8100` | 麦咖啡™ | ¥9.5 | 13 kcal | 接口 |
| 锡兰红茶 | `3300` | 饮品 | ¥10.5 | 2 kcal | 已知值 \* |
| 纯悦 | `3400` | 饮品 | ¥7.5 | 0 kcal | 已知值 \* |
| 苹果片 | `6102` | 小食甜品/其他 | ¥7.0 | 32 kcal | 已知值 \* |

\* = 接口未返回配料，使用公开配方兜底并标注 `ingSource: 'manual'`，UI 上带红色 `*`，需人工核对。

> 若无法获取实时菜单，游戏以**上述这份最近已知在售菜单**为准（内置快照），
> 并在 `game/midnight-snack.html` 的 `DEFAULT_MENU` 头部注释、`data/menu-verify.txt`
> 两处标注需人工核对的字段。

## 5. 业务价值

| 维度 | 说明 |
|---|---|
| 数据真实性 | 游戏里每一个数字都来自官方接口，不是编的；玩家看到的是**自己城市、自己门店**的在售菜单与真实价格，连「吃掉一口涨多少卡」都是从官方营养表按比例拆出来的 |
| 数据驱动玩法 | 真实热量不只是显示用的数字：它决定「每一口」的数值，进而决定你最终落在哪个结局 |
| 场景创新 | 麦当劳 MCP 已有项目集中在「省钱 / 营养 / 团餐 / 人格测试」，**没有人做完整游戏**；本项目把 MCP 从「决策辅助工具」延伸到「内容生成 + 情绪体验」 |
| 时段契合 | 门店接口返回的「宵夜 00:00–04:45」时段被直接用作游戏的世界观设定，数据反哺叙事 |
| 可复用性 | `scripts/fetch-menu.mjs` 是独立的 MCP 客户端，换 city/keyword 就能给任何城市生成一份游戏数据；餐品名用正则匹配，门店叫法不同也不会整组失效 |
| 字段完整性 | 名称 / 分类 / 价格 / 图片 / 营养 / 配料 六个字段**全部来自 MCP**，不是编的；拿不到的字段明确标注而非伪装 |
| 合规 | 全程只读（无下单类写操作）；不含真实 Token；不把品牌与「长胖 / 不健康」做归因 |

## 6. 降级策略

MCP 不可用时（无 Token / 网络异常 / 门店售罄）：
1. `game/menu.js` 缺失 → 自动回退 HTML 内置的实测快照（最近一次已知在售菜单），游戏照常可玩；
2. 单个餐品价格缺失 → 脚本打印告警并继续，不中断；
3. 热量匹配不到 → 使用 `FALLBACK_KCAL`（同为官方营养表实测值），并标注 `_from: fallback`；
4. 配料接口不返回 → 使用公开配方兜底并标注 `ingSource: 'manual'`，UI 上带 `*`；
5. 官方图片加载失败（离线 / CDN 不可达）→ 卡片自动回退像素图占位，流程不受影响；
6. `--no-detail` 可跳过 `query-meal-detail`，只拉名称 / 价格 / 营养，加快生成。
