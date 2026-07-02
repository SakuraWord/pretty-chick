# Fundval 项目技术方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建"盘中基金实时估值与逻辑审计系统"——基于持仓穿透 + 实时行情加权计算 + 多数据源 fallback，提供透明的基金估值、PK 对比、AI 分析、通知推送等功能。

**Architecture:** Django 6 + DRF 提供 RESTful API，Celery 处理异步定时任务，React 19 + Ant Design + ECharts 构建 SPA 前端，Nginx 反向代理 `/api/` 到后端。多数据源（东方财富/养基宝/小倍养基/蛋卷/新浪）通过抽象基类 + 注册表模式统一接入，支持多源 fallback。Docker Compose 六服务编排（db/redis/backend/celery-worker/celery-beat/frontend），跨 Web / Tauri Desktop / Capacitor Android 三端。

**Tech Stack:** Python 3.13 + Django 6 + DRF + Celery, React 19 + Vite + Ant Design 5 + ECharts, PostgreSQL 16, Redis 7, Nginx, Docker, Tauri, Capacitor

## Global Constraints

- Python 版本 >= 3.13, Node.js >= 20, npm >= 9
- JWT 认证（Access Token 1h / Refresh Token 7d），所有 API 默认需要认证
- 数据库支持 SQLite（开发）和 PostgreSQL（生产），通过环境变量 `DB_TYPE` 切换
- 前端必须通过 Nginx 反向代理 `/api/` 到后端，禁止前端直连后端
- 生产环境 Docker 部署，`config.json` 通过 volume 持久化，代码不挂载
- AGPL-3.0 协议开源

---

# 系统架构

## 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      客户端层                                 │
│  Web Browser  │  Tauri Desktop (macOS/Win/Linux)  │  Android  │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                 Nginx 前端容器 (:80)                          │
│  /          → React SPA 静态文件                              │
│  /api/*     → proxy_pass → backend:8000                      │
└────────────────────────┬────────────────────────────────────┘
                         │ /api/*
                         ▼
┌─────────────────────────────────────────────────────────────┐
│            Gunicorn 后端容器 (:8000)                           │
│  Django 6 + DRF                                               │
│  ├── api/views.py      ← 认证、AI 分析、Bootstrap            │
│  ├── api/viewsets.py   ← Fund/Account/Position/Watchlist CRUD │
│  ├── api/models.py     ← 数据模型层                            │
│  ├── api/serializers.py← 序列化/反序列化                       │
│  ├── api/sources/      ← 多数据源（5个）                       │
│  └── api/services/     ← 持仓计算、养基宝/小倍导入              │
└──┬──────────┬──────────────────────┬─────────────────────────┘
   │          │                      │
   ▼          ▼                      ▼
┌──────┐ ┌──────┐    ┌──────────────────────────────┐
│  PG  │ │Redis │    │      Celery Worker            │
│  16  │ │  7   │    │  api.tasks.*                  │
│      │ │      │    │  ├── update_fund_nav          │
│      │ │      │    │  ├── capture_estimate_snapshot│
│      │ │      │    │  ├── audit_accuracy           │
│      │ │      │    │  ├── check_notification_rules │
│      │ │      │    │  └── generate_investment_reports│
└──────┘ └──┬───┘    └──────────────────────────────┘
            │
            ▼
    ┌──────────────┐
    │ Celery Beat   │
    │ 定时调度器     │
    └──────────────┘
```

## 容器拓扑

| 容器 | 镜像 | 端口 | 职责 |
|------|------|------|------|
| `db` | `postgres:16-alpine` | 5432（内网） | 主数据库 |
| `redis` | `redis:7-alpine` | 6379（内网） | 缓存 / Celery Broker |
| `backend` | `jasamine/fundval-backend` | 8000（内网） | Gunicorn → Django WSGI |
| `celery-worker` | 同 backend 镜像 | — | 消费异步任务 |
| `celery-beat` | 同 backend 镜像 | — | 定时任务调度 |
| `frontend` | `jasamine/fundval-frontend` | `${FRONTEND_PORT}`（默认 21345） | Nginx + React |

## 数据流

### 实时估值查询流

```
用户请求 GET /api/funds/{id}/estimate/
  → viewsets.FundViewSet.estimate()
    → 遍历数据源列表（用户偏好源优先）
      → source.fetch_estimate(fund_code)
        → HTTP 请求外部数据源 API
        → 返回 {estimate_nav, estimate_growth, estimate_time}
      → 成功则缓存到 Fund.estimate_nav / estimate_growth
      → 失败则 fallback 下一数据源
    → 返回估值数据
```

### 定时净值同步流

```
Celery Beat 触发 (22:30 每天)
  → api.tasks.update_fund_nav()
    → call_command("update_nav")
      → 遍历所有 Fund 记录
        → 并发请求各数据源 fetch_today_nav()
        → 写入 FundNavHistory 表
        → 更新 Fund.latest_nav / latest_nav_date
```

### 估值准确率审计流

```
Celery Beat 触发 (15:05 交易日)
  → api.tasks.capture_estimate_snapshot()
    → 遍历有估值的基金
    → 创建 EstimateSnapshot 记录
    → 写入 EstimateAccuracy (estimate_nav 锁定)

Celery Beat 触发 (23:00 交易日)
  → api.tasks.audit_accuracy()
    → 读取当日 EstimateAccuracy
    → 查询各数据源实际净值
    → 计算误差率 = (估算 - 实际) / 实际
    → 更新 EstimateAccuracy.error_rate
```

---

# 后端架构

## 目录结构

```
backend/
├── fundval/               # Django 项目配置
│   ├── __init__.py
│   ├── settings.py        # Django 设置（DB/Redis/JWT/Celery/CORS）
│   ├── urls.py            # 根路由（admin + /api/* + SPA catch-all）
│   ├── wsgi.py            # WSGI 入口
│   ├── asgi.py            # ASGI 入口
│   ├── celery.py          # Celery App 配置
│   ├── config.py          # Config 单例（JSON + ENV 覆盖）
│   └── bootstrap.py       # Bootstrap Key 生成/验证
├── api/                   # 核心业务应用
│   ├── models.py          # 14 个模型（Fund → NotificationLog）
│   ├── viewsets.py        # 15 个 ViewSet（2583 行，核心业务逻辑）
│   ├── views.py           # 函数视图（认证、Bootstrap、AI 分析）
│   ├── serializers.py     # DRF Serializer 定义
│   ├── urls.py            # API 路由（Router + 手动路由）
│   ├── tasks.py           # Celery 任务定义
│   ├── admin.py           # Django Admin 注册
│   ├── sources/           # 数据源模块
│   │   ├── __init__.py    # 自动注册所有数据源到 SourceRegistry
│   │   ├── base.py        # BaseEstimateSource 抽象基类
│   │   ├── registry.py    # SourceRegistry 注册表
│   │   ├── eastmoney.py   # 东方财富（主要源，无需登录）
│   │   ├── yangjibao.py   # 养基宝（扫码登录）
│   │   ├── xiaobeiyangji.py # 小倍养基（手机验证码登录）
│   │   ├── danjuan.py     # 蛋卷/雪球（历史净值 + 评级）
│   │   └── sina.py        # 新浪财经
│   ├── services/          # 业务逻辑层
│   │   ├── __init__.py    # recalculate_position 等
│   │   ├── position_history.py  # 持仓历史市值计算
│   │   ├── import_yjb.py        # 养基宝持仓导入
│   │   ├── import_xiaobeiyangji.py # 小倍养基持仓导入
│   │   └── nav_history.py       # 净值历史查询服务
│   └── management/commands/  # Django 管理命令
│       ├── sync_funds.py      # 同步基金列表
│       ├── update_nav.py      # 更新净值
│       ├── sync_nav_history.py # 同步历史净值
│       ├── calculate_accuracy.py # 计算估值准确率
│       └── check_bootstrap.py  # 检查初始化状态
├── tests/                 # pytest 测试（60+ 文件）
├── manage.py              # Django CLI
├── entrypoint.sh          # Docker 启动脚本
├── Dockerfile
├── pyproject.toml
└── uv.lock
```

## 数据模型（14 张表）

### 核心业务模型

```
Fund
  ├── fund_code (unique)     # 基金代码，如 "000001"
  ├── fund_name              # 基金名称
  ├── fund_type              # 基金类型
  ├── latest_nav             # 最新净值（由定时任务更新）
  ├── latest_nav_date        # 最新净值日期
  ├── estimate_nav           # 实时估值（缓存）
  ├── estimate_growth        # 估值涨跌幅 %
  └── estimate_time          # 估值更新时间

Account
  ├── user → FK(User)        # 所属用户
  ├── name                   # 账户名称
  ├── parent → FK(self)      # 父账户（NULL=父, NOT NULL=子），最多两层
  └── is_default             # 是否默认账户（只有父账户可设）
  Constraints:
    - (user, name) unique_together
    - default_account_must_be_parent（is_default=True → parent IS NULL）

Position
  ├── account → FK(Account)  # 所属子账户
  ├── fund → FK(Fund)        # 基金
  ├── holding_share          # 持有份额
  ├── holding_cost           # 持仓成本
  └── holding_nav            # 持仓净值
  Constraints:
    - (account, fund) unique_together
    - 只能创建在子账户上（parent IS NOT NULL）

PositionOperation
  ├── account → FK(Account)  # 操作子账户
  ├── fund → FK(Fund)        # 基金
  ├── operation_type         # BUY / SELL
  ├── operation_date         # 操作日期
  ├── before_15              # 是否 15:00 前操作
  ├── amount                 # 金额
  ├── share                  # 份额
  └── nav                    # 操作净值
  save() 后自动调用 recalculate_position() 重算持仓
  post_delete signal 也触发重算
```

### 自选/偏好模型

```
Watchlist
  ├── user → FK(User)
  └── name
  (user, name) unique_together

WatchlistItem
  ├── watchlist → FK(Watchlist)
  ├── fund → FK(Fund)
  └── order                   # 拖拽排序
  (watchlist, fund) unique_together

UserPreference (OneToOne → User)
  ├── preferred_source        # eastmoney / yangjibao
  ├── theme_mode             # light / dark
  ├── report_enabled         # 是否开启投资报告
  └── report_frequency       # weekly,monthly,yearly（逗号分隔）
```

### AI 模型

```
AIConfig (OneToOne → User)
  ├── api_endpoint           # OpenAI 协议接口地址
  ├── api_key                # API Key
  └── model_name             # 模型名称（默认 gpt-4o-mini）

AIPromptTemplate
  ├── user → FK(User)
  ├── name                   # 模板名称
  ├── context_type           # fund / position
  ├── system_prompt          # 系统提示词
  ├── user_prompt            # 用户提示词（含 {{placeholder}}）
  └── is_default             # 是否为该类型默认模板
```

### 数据源/凭证模型

```
UserSourceCredential
  ├── user → FK(User)
  ├── source_name            # yangjibao / xiaobeiyangji
  ├── token                  # 加密存储
  └── is_active
  (user, source_name) unique_together

EstimateAccuracy
  ├── source_name            # 数据源名称
  ├── fund → FK(Fund)
  ├── estimate_date
  ├── estimate_nav           # 收盘估值快照
  ├── actual_nav             # 晚间实际净值
  └── error_rate             # (估值-实际)/实际
  (source_name, fund, estimate_date) unique_together

FundNavHistory
  ├── fund → FK(Fund)
  ├── nav_date
  ├── unit_nav               # 单位净值
  ├── accumulated_nav        # 累计净值
  └── daily_growth           # 日增长率 %
  (fund, nav_date) unique_together

EstimateSnapshot
  ├── fund → FK(Fund)
  ├── source                 # 数据源
  ├── timestamp              # 快照时间
  ├── estimate_nav
  └── estimate_growth
  Index: (fund, timestamp), (timestamp)
```

### 通知模型

```
NotificationChannel
  ├── user → FK(User)
  ├── channel_type           # webhook / email
  ├── config                 # JSON: {webhook_url} 或 {email}
  └── is_active

NotificationRule
  ├── user → FK(User)
  ├── fund → FK(Fund)
  ├── rule_type              # growth_up / growth_down
  ├── threshold              # 阈值（百分比）
  ├── channels → M2M(NotificationChannel)
  ├── is_active
  └── cooldown_minutes       # 冷却时间

NotificationLog
  ├── rule → FK(NotificationRule)
  ├── channel → FK(NotificationChannel)
  ├── trigger_time
  ├── fund_code / fund_name
  ├── growth                 # 触发时涨跌幅
  └── status                 # success / failed
```

## 数据源系统

### 架构模式：模板方法 + 注册表

```python
# 抽象基类定义接口
class BaseEstimateSource(ABC):
    @abstractmethod
    def get_source_name(self) -> str: ...
    @abstractmethod
    def fetch_estimate(self, fund_code: str) -> Dict: ...
    @abstractmethod
    def fetch_realtime_nav(self, fund_code: str) -> Dict: ...
    @abstractmethod
    def fetch_today_nav(self, fund_code: str) -> Dict: ...
    @abstractmethod
    def fetch_fund_list(self) -> list: ...
    @abstractmethod
    def fetch_nav_history(self, fund_code, start_date, end_date) -> list: ...

    # 可选实现
    def get_login_type(self) -> str: return "none"  # none / qrcode / phone
    def get_qrcode(self) -> Dict: return None
    def check_qrcode_state(self, qr_id) -> Dict: return None
    def logout(self): pass
    def send_sms(self, phone): raise NotImplementedError
    def verify_phone(self, phone, code) -> dict: raise NotImplementedError
    def fetch_market_quote(self, fund_code) -> Dict: return None
    def fetch_index_holdings(self, fund_code) -> list: return []

# 注册表：存类不存实例，每次 get_source() 返回新实例
class SourceRegistry:
    _classes: dict = {}

    @classmethod
    def register(cls, source): ...   # 存入 type(source)
    @classmethod
    def get_source(cls, name): ...  # 返回 klass() 新实例
    @classmethod
    def list_sources(cls): ...
```

### 数据源能力矩阵

| 数据源 | 标识 | 登录方式 | fetch_estimate | fetch_realtime_nav | fetch_today_nav | fetch_fund_list | fetch_nav_history | fetch_index_holdings |
|--------|------|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| 东方财富 | `eastmoney` | 无需 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 养基宝 | `yangjibao` | 扫码 | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| 小倍养基 | `xiaobeiyangji` | 手机验证码 | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| 蛋卷/雪球 | `danjuan` | 无需 | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| 新浪财经 | `sina` | 无需 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 多源 Fallback 策略

```
查询估值时按优先级遍历数据源：
  1. 用户偏好数据源 (UserPreference.preferred_source)
  2. 东方财富（默认源，覆盖最广）
  3. 养基宝
  4. 小倍养基

同步净值时并发查询所有数据源：
  - ThreadPoolExecutor 并发请求
  - 数据源返回 None 则跳过
  - 多源结果按配置优先级覆盖写入 FundNavHistory
  - 同时更新 Fund.latest_nav
```

## API 设计

### RESTful 路由（DefaultRouter 注册）

| 路由 | ViewSet | 说明 |
|------|---------|------|
| `GET/POST /api/funds/` | `FundViewSet` | 基金列表 / 搜索 |
| `GET /api/funds/{id}/` | `FundViewSet` | 基金详情 |
| `GET /api/funds/{id}/estimate/` | `FundViewSet.estimate` | 实时估值（多源 fallback） |
| `GET /api/funds/{id}/realtime_nav/` | `FundViewSet.realtime_nav` | 最新净值 |
| `GET /api/funds/{id}/nav_history/` | `FundViewSet.nav_history` | 历史净值 |
| `POST /api/funds/{id}/sync_nav/` | `FundViewSet.sync_nav` | 手动同步净值 |
| `GET /api/funds/{id}/holdings/` | `FundViewSet.holdings` | 持仓穿透（成分股） |
| `GET /api/funds/{id}/accuracy/` | `FundViewSet.accuracy` | 估值准确率 |
| `GET/POST /api/accounts/` | `AccountViewSet` | 账户 CRUD |
| `GET/POST /api/positions/` | `PositionViewSet` | 持仓查询 |
| `GET/POST /api/positions/operations/` | `PositionOperationViewSet` | 持仓操作流水 |
| `GET/POST /api/watchlists/` | `WatchlistViewSet` | 自选列表 |
| `GET/POST /api/sources/` | `SourceViewSet` | 数据源管理、登录 |
| `GET/POST /api/nav-history/` | `FundNavHistoryViewSet` | 净值历史查询 |
| `GET/PUT /api/preferences/` | `UserPreferenceViewSet` | 用户偏好 |
| `GET/PUT /api/ai/config/` | `AIConfigViewSet` | AI 配置 |
| `GET/POST /api/ai/templates/` | `AIPromptTemplateViewSet` | 提示词模板 |
| `POST /api/ai/analyze/` | 函数视图 | AI 分析 |
| `POST /api/ai/report-preview/` | 函数视图 | AI 投资报告预览 |
| `GET/POST /api/notification-channels/` | `NotificationChannelViewSet` | 通知渠道 |
| `GET/POST /api/notification-rules/` | `NotificationRuleViewSet` | 通知规则 |
| `GET /api/notification-logs/` | `NotificationLogViewSet` | 通知记录 |
| `GET /api/admin/users/` | `AdminViewSet` | 管理员：用户管理 |
| `GET /api/admin/stats/` | `AdminViewSet` | 管理员：系统统计 |
| `POST /api/admin/tasks/{name}/` | `AdminViewSet` | 管理员：触发 Celery 任务 |

### 认证接口（AllowAny）

| 路由 | 说明 |
|------|------|
| `POST /api/auth/login` | 用户名+密码 → JWT |
| `POST /api/auth/refresh` | Refresh Token → 新 Access Token |
| `GET /api/auth/me` | 当前用户信息 |
| `PUT /api/auth/password` | 修改密码 |
| `POST /api/admin/bootstrap/verify` | 验证 Bootstrap Key |
| `POST /api/admin/bootstrap/initialize` | 系统初始化（创建管理员） |

### 权限策略

- **默认**: `IsAuthenticated`（JWT）
- **AllowAny**: `/api/auth/*`, `/api/admin/bootstrap/*`, `/api/health/`
- **IsAdminUser**: `/api/admin/users/*`, `/api/admin/stats/`, `/api/admin/tasks/*`

## Celery 定时任务

| 任务 | 调度 | 说明 |
|------|------|------|
| `capture_estimate_snapshot` | 每个交易日 15:05 | 收盘估值快照锁定 |
| `audit_accuracy` | 每个交易日 23:00 | 估值 vs 实际净值误差计算 |
| `update_fund_nav` | 每天 22:30 | 同步昨日净值 |
| `update_fund_today_nav` | 每天 21:30, 23:00 | 确权当日净值 |
| `capture_intraday_snapshots` | 交易时段 9-14 点每 5 分钟 | 盘中估值快照 |
| `capture_intraday_close` | 15:05 | 收盘前最后一抓 |
| `check_notification_rules` | 每 5 分钟 | 涨跌幅阈值通知 |
| `generate-weekly-report` | 每周一 9:00 | AI 周报 |
| `generate-monthly-report` | 每月 1 日 9:00 | AI 月报 |

### 任务时间线（交易日）

```
09:00-14:55  每5分钟 capture_intraday_snapshots（盘中估值快照）
15:05        capture_estimate_snapshot（收盘锁定估值）
15:05        capture_intraday_close（最后一抓）
21:30        update_fund_today_nav（第一次确权）
22:30        update_fund_nav（同步昨日净值）
23:00        audit_accuracy（计算估值误差）
23:00        update_fund_today_nav（第二次确权）
```

---

# 前端架构

## 目录结构

```
frontend/
├── index.html              # Vite 入口 HTML
├── vite.config.js          # Vite 配置
├── vitest.config.js        # 测试配置
├── nginx.conf              # 生产 Nginx 配置
├── capacitor.config.json   # Capacitor Android 配置
├── Dockerfile
├── src-tauri/              # Tauri 桌面端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         # Tauri 入口
│       └── lib.rs          # Tauri 命令
├── public/                 # 静态资源
└── src/
    ├── main.jsx            # React 入口
    ├── App.jsx             # 路由定义 + 主题
    ├── App.css
    ├── index.css
    ├── api/                # API 请求层（axios 封装）
    ├── assets/             # 图片/图标
    ├── components/         # 通用组件
    ├── contexts/           # React Context
    │   ├── AuthContext.jsx     # JWT 状态管理
    │   ├── AccountContext.jsx  # 当前选中账户
    │   └── PreferenceContext.jsx # 主题/数据源偏好
    ├── layouts/
    │   └── MainLayout.jsx  # 侧栏导航 + 顶栏
    ├── pages/              # 页面组件（16 个）
    │   ├── LoginPage.jsx        # 登录
    │   ├── RegisterPage.jsx     # 注册
    │   ├── InitializePage.jsx   # Bootstrap 初始化
    │   ├── DashboardPage.jsx    # 仪表盘（重定向到自选）
    │   ├── FundsPage.jsx        # 基金搜索/列表
    │   ├── FundDetailPage.jsx   # 基金详情（估值/净值/持仓穿透）
    │   ├── AccountsPage.jsx     # 账户管理
    │   ├── PositionsPage.jsx    # 持仓管理 + 操作流水
    │   ├── WatchlistsPage.jsx   # 自选列表（拖拽排序）
    │   ├── SettingsPage.jsx     # 设置（AI/通知/偏好/数据源）
    │   ├── ComparePage.jsx      # 基金 PK 对比（雷达图）
    │   ├── RankingsPage.jsx     # 排行榜（涨幅/人气/准度）
    │   ├── MarketPage.jsx       # 大盘指数
    │   ├── AdminPage.jsx        # 管理员面板
    │   ├── ProfilePage.jsx      # 个人资料
    │   └── ServerConfigPage.jsx # 服务器配置（原生 App）
    ├── test/               # 前端测试
    └── utils/
        └── auth.js         # JWT token 管理工具
```

## 路由设计

```
/login                          # 登录页（公开）
/register                       # 注册页（公开）
/initialize                     # 系统初始化（公开）
/dashboard/watchlists           # 自选列表（首页）
/dashboard/funds                # 基金搜索
/dashboard/funds/:code          # 基金详情
/dashboard/accounts             # 账户管理
/dashboard/positions            # 持仓管理
/dashboard/compare              # 基金 PK 对比
/dashboard/rankings             # 基金排行榜
/dashboard/market               # 大盘指数
/dashboard/settings             # 系统设置
/dashboard/profile              # 个人资料
/dashboard/admin                # 管理员面板
```

## 状态管理

三层 Context 嵌套：

```
AuthProvider          ← JWT token、用户信息、登录/登出
  AccountProvider     ← 当前选中的账户
    PreferenceProvider ← 主题模式、数据源偏好
```

- **AuthProvider**: 管理 JWT access/refresh token，登录/登出/注册操作，token 自动刷新
- **AccountProvider**: 管理当前选中的账户 ID，子账户列表，账户切换
- **PreferenceProvider**: 主题模式（light/dark），数据源偏好，调用 `/api/preferences/` 持久化

## 平台检测

`App.jsx` 中的 `isNativeApp()` 函数检测运行环境：

```javascript
export const isNativeApp = () => {
  if (window.__TAURI__ !== undefined) return true;        // Tauri
  if (window.Capacitor !== undefined) return true;        // Capacitor
  if (window.__TAURI_INTERNALS__ !== undefined) return true;
  if (navigator.userAgent.includes('Tauri')) return true;
  return false;
};
```

原生 App 模式下会在 Settings 页显示 ServerConfigPage，用于配置后端地址。

---

# 部署架构

## Docker Compose 服务依赖

```
frontend  → depends_on → backend (healthcheck: /api/health/)
backend   → depends_on → db (healthcheck: pg_isready)
          → depends_on → redis (healthcheck: ping)
celery-worker → depends_on → db, redis
celery-beat  → depends_on → db, redis
```

## 启动流程（entrypoint.sh）

```
1. 等待数据库就绪（TCP 探测 + pg_isready）
2. python manage.py migrate --noinput     # 数据库迁移
3. python manage.py collectstatic --noinput # 静态文件收集
4. python manage.py check_bootstrap        # 检查/生成 Bootstrap Key
5. python manage.py sync_funds --if-empty  # 首次同步基金数据（仅空库）
6. exec "$@"                               # 执行 CMD（Gunicorn）
```

## 配置层次

```
优先级（从高到低）:
  1. 环境变量（.env 或 docker-compose.yml environment）
  2. config.json（通过 volume 挂载，Docker 持久化）
  3. 代码默认值
```

关键环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DB_TYPE` | sqlite | postgresql / sqlite |
| `POSTGRES_DB` | fundval | 数据库名 |
| `POSTGRES_USER` | fundval | 数据库用户 |
| `POSTGRES_PASSWORD` | fundval | 数据库密码 |
| `POSTGRES_HOST` | localhost | 数据库主机 |
| `POSTGRES_PORT` | 5432 | 数据库端口 |
| `REDIS_URL` | redis://localhost:6379/0 | Redis 连接 |
| `SECRET_KEY` | django-insecure-dev-only | Django SECRET_KEY |
| `DEBUG` | false | 调试模式 |
| `ALLOWED_HOSTS` | * | 允许的 Host |
| `ALLOW_REGISTER` | false | 允许注册 |
| `GUNICORN_WORKERS` | 4 | Worker 进程数 |
| `FRONTEND_PORT` | 21345 | 前端访问端口 |

## 持久化 Volume

| Volume | 挂载路径 | 内容 |
|--------|---------|------|
| `postgres_data` | `/var/lib/postgresql/data` | 数据库文件 |
| `config_data` | `/app/config` | config.json（Bootstrap Key、系统配置） |

---

# 开发工作流

## 本地开发

```bash
# 后端
cd backend
uv sync                          # 安装依赖
uv run python manage.py migrate  # 初始化数据库（SQLite）
uv run python manage.py runserver 0.0.0.0:8000

# 前端（另一个终端）
cd frontend
npm install
npm run dev                      # Vite 开发服务器

# 前端访问 http://localhost:5173
# Vite proxy 配置将 /api/* 转发到 localhost:8000
```

## 关键命令

```bash
# 同步基金数据
uv run python manage.py sync_funds

# 同步净值
uv run python manage.py update_nav                    # 最新可用净值
uv run python manage.py update_nav --today            # 当日确权净值

# 同步历史净值
uv run python manage.py sync_nav_history              # 全部基金
uv run python manage.py sync_nav_history 000001       # 指定基金

# 手动计算准确率
uv run python manage.py calculate_accuracy            # 今天
uv run python manage.py calculate_accuracy 2024-01-15 # 指定日期

# 重算所有持仓
uv run python manage.py recalculate_positions

# 运行测试
uv run pytest tests/ -v
```

## 发布流程

1. GitHub Actions `docker-publish.yml` 自动构建并推送 `backend` / `frontend` 镜像到 Docker Hub
2. GitHub Actions `release.yml` 构建 Tauri 桌面端（macOS ARM64/x86_64, Windows, Linux）
3. GitHub Actions `android-build.yml` 构建 Android APK
4. 用户通过 `docker compose pull && docker compose up -d` 更新

---

# 关键技术决策

## 为什么 Django 6 + DRF？
- Django ORM 成熟稳定，适合复杂数据模型（14 张表，多对多，层级账户）
- DRF 的 ViewSet + Router 模式减少样板代码
- Celery 集成成熟，定时任务调度可靠
- 中文社区活跃，适合以中文用户为主的基金工具

## 为什么数据源用注册表模式？
- 5 个数据源各有不同的登录方式和 API 协议
- 注册表存类不存实例，避免多请求共享 token
- 新增数据源只需实现抽象基类 + 一行注册，符合开闭原则

## 为什么 viewsets.py 有 2583 行？
- 这是需要重构的信号。当前所有 ViewSet（15 个类）集中在一个文件
- 应按领域拆分为 `viewsets/funds.py`, `viewsets/accounts.py` 等
- 但代码本身质量不错，暂不影响功能

## 为什么前端直接用 Context 而非 Redux/Zustand？
- 状态结构简单（认证 + 账户 + 偏好），全局共享状态少
- Context + useReducer 足够，减少依赖
- 如需复杂状态（如实时行情 WebSocket），可后续引入 Zustand

---

# 安全考量

- JWT Token 有效期 1 小时，需要 refresh token 续期
- 生产环境必须修改 `SECRET_KEY` 和 `POSTGRES_PASSWORD`
- Bootstrap Key 用于首次系统初始化，key 通过日志输出，需物理访问
- `ALLOWED_HOSTS` 在生产环境应限制为实际域名
- CORS 当前设置 `CORS_ALLOW_ALL_ORIGINS = True`，生产应限制
- 数据源 token 存储在 `UserSourceCredential` 表中，应实现加密（当前标记为"加密存储"但使用 TextField）

---

# 已知技术债务

1. **viewsets.py 过于庞大**（2583 行）：15 个 ViewSet 集中在一个文件
2. **viewset 与 view 混合**：AI 分析和认证在 `views.py`（函数视图），CRUD 在 `viewsets.py`（类视图），需要统一
3. **Token 加密**：`UserSourceCredential.token` 存储为明文 TextField，需实现加密
4. **CORS 配置**：生产环境需限制 `CORS_ALLOWED_ORIGINS`
5. **前端测试覆盖**：目前只有少量页面组件测试，缺少单元测试
6. **错误处理**：数据源 fetch 缺少统一的错误分类和重试机制
7. **API 限流**：当前无速率限制，可能被恶意调用
8. **WebSocket**：实时估值目前靠轮询（30s 自动刷新），可改为 WebSocket 推送
