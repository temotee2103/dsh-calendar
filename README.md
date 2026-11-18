# 万年历 · 行程 · 今日运程（DSH 插件）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的日历面板：左边今日万年历，右边当月月历；下面每日行程与八字运程。Google 日历与飞书（Lark）日历可以同步进来。

```
┌──────────────┬────────────────────────┐
│ 今日万年历     │ 当月月历（含跨天连续条）   │
├──────────────┼────────────────────────┤
│ 每日行程       │ 今日运程（事业/财运/人缘…）│
└──────────────┴────────────────────────┘
```

## 功能

- **农历**：由 ICU 中国历法换算（含闰月），不是手写查表。
- **干支**：日柱按 60 甲子推算，并以 JDN 公式交叉校验（自检里有 400 天逐日比对）。
- **马来西亚公共假期**：联邦级，2026–2027 共 30 条，穆斯林节日标注「暂定」。
- **月历**：每周一行 + 绝对定位条形层，跨天行程一根连到底，跨周在周末处断开；同日多条自动分车道。
- **日历同步**（两个源，可各自独立断开）：
  - Google 日历：粘贴日历的「私密 iCal 地址」。
  - 飞书 / Lark：走 CalDAV（客户端 → 设置 → 日历 → CalDAV 同步 生成的服务器 + 用户名 + 密码）。
- **每日行程**：本机 localStorage，按日期分开。
- **今日运程**：依四柱八字推算当日十神与地支刑冲合害，五项打分。命局由使用者自己填，插件不内置任何人的出生数据。

## 环境要求

- DSH `>=0.2.1-rc.2 <0.3.0-0`（`engines.dsh` 已写入，版本不符会被拒装并说明原因）。
- 桌面版与 DSH Go（Android 本地引擎）都可以跑。

## 安装

### 桌面 / 任意 DSH 主机

```sh
git clone https://github.com/<you>/dsh-calendar.git
dsh plugin --profile web add "$(pwd)/dsh-calendar"
```

（在 Harness 里也可以用插件管理器按目录安装。）

### DSH Go（Android 本机引擎）

在 App 的**终端（本机环境）**里：

```sh
mkdir -p /root/.dsh/dsh-go/plugins
git clone https://github.com/<you>/dsh-calendar.git /root/.dsh/dsh-go/plugins/dsh-calendar
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-calendar
```

装完在「全部功能 › 插件 › 万年历」进入；看不到就重启一次引擎。

### 更新

```sh
cd /root/.dsh/dsh-go/plugins/dsh-calendar   # 或桌面上 clone 的位置
git pull
```

改 `lib/` 或 `client.js` 之后要重启引擎（桌面重启 `dsh web`，手机在「引擎」页重启）；只改 `package.json` 的清单字段会被热重读。

### 卸载

```sh
dsh plugin --profile web remove @local/dsh-calendar
```

## 配置（都在本机，不会上传）

| 文件 | 内容 |
|---|---|
| `~/.dsh/secrets/calendar-ics.env` | Google 日历的私密 iCal 地址（等同密码） |
| `~/.dsh/secrets/calendar-caldav.env` | 飞书 CalDAV 的服务器、用户名、密码 |
| `~/.dsh/secrets/calendar-profile.json` | 四柱命局，例如 `{"pillars":"癸酉 癸亥 丙辰 丁酉"}` |

面板顶部两条横幅可以直接填前两项；命局在「今日运程」卡里首次进入时填写。

## 自检

```sh
node check.mjs        # 万年历、干支、假期、运程、跨天、条形层布局、同步服务
node check-lark.mjs   # 飞书 CalDAV：发现、multiget、数字实体解码、两源合并
```

两套都只读，且用临时目录里的假 secrets 文件，不会碰你真实的日历配置。

## 已知边界

- 只读同步：日历上的事件会进入面板，但面板里改不了它们（写回需要 Google OAuth / 飞书开放平台授权）。
- 飞书 CalDAV **不返回**内联的 `calendar-data`，必须用 `calendar-multiget` 逐条取；`GET` 单个资源返回 403。实现里都处理了。
- 多天事件只显示在它的第一天所属的**行程卡**里（月历上则是整段连续条）。
- 公共假期只覆盖 2026–2027，州假与临时调整以官方公告为准。

## 许可证

MIT，见 [LICENSE](LICENSE)。
