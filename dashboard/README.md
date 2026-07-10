# AegisFlow

Dashboard 是本项目的本地展示系统，由 Node API 和 Vue 前端组成。它不直接保存 API key，也不直接实现模型调用；模型认证、agent 运行和真实任务执行仍由根目录的 `pen-agent` 与 `opencode` 负责。

## API Key 放在哪里

API key 放在项目根目录 `.env`，不是放在 `dashboard/` 里：

```bash
cd ..
cp .env.example .env
```

编辑根目录 `.env`：

```dotenv
PEN_AGENT_API_KEY=<your-provider-api-key>
PEN_AGENT_PROVIDER=deepseek
PEN_AGENT_MODEL=deepseek/deepseek-v4-flash
PEN_AGENT_ATTACH_URL=http://localhost:4096
PEN_AGENT_AGENT=
```

Dashboard 启动时会读取根目录 `.env`，然后通过 `/api/config` 返回非敏感配置：

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "attachUrl": "http://localhost:4096",
  "provider": "deepseek",
  "hasApiKey": true
}
```

注意：接口只返回 `hasApiKey`，不会返回真实 key。前端顶部只显示 `Key 已配置` 或 `Key 未配置`。

## 数据来源

Dashboard 默认读取实时运行目录：

- `.pen-agent/state.json`
- `.pen-agent/status.json`
- `.pen-agent/stream.log`
- `artifacts/flags.json`
- `artifacts/flags.txt`
- `artifacts/notes/`

也可以读取历史快照。快照目录放在根目录 `归档/history/` 下：

```text
归档/history/demo-name/
├── archive.json
├── .pen-agent/
│   ├── state.json
│   ├── status.json
│   └── stream.log
└── artifacts/
    ├── flags.json
    ├── flags.txt
    └── notes/*.md
```

前端顶部“演示数据”下拉框会自动发现这些快照。选择快照后，总览、拓扑、Flags、笔记和协同页都会切到该数据源；启动真实任务时会自动切回实时数据。

## 启动方式

安装前端依赖：

```bash
npm --prefix dashboard/web install
```

开发模式需要两个终端。

终端 1：

```bash
node dashboard/server.js
```

终端 2：

```bash
npm --prefix dashboard/web run dev
```

访问：

```text
http://localhost:5173
```

生产构建：

```bash
npm --prefix dashboard/web run build
node dashboard/server.js
```

访问：

```text
http://127.0.0.1:3000
```

## 代码结构

```text
dashboard/
├── server.js                 # API 路由编排和数据聚合入口
├── server/
│   ├── archives.js           # 实时/归档数据源切换
│   ├── fs-utils.js           # JSON、文本、tail、walk 等文件工具
│   └── http.js               # JSON 响应、请求体解析、静态文件服务
└── web/src/
    ├── App.vue               # 应用壳
    ├── components/
    │   └── AppHeader.vue     # 顶部品牌、配置状态、归档选择和导航
    ├── config/
    │   └── navigation.ts     # 导航定义
    ├── pages/
    │   ├── StartPage.vue     # 任务启动表单
    │   ├── OverviewPage.vue  # 总览指标、日志和关键动作
    │   └── TopologyPage.vue  # 资产拓扑
    ├── services/api.ts       # 前端 HTTP helper
    ├── stores/runtime.ts     # Pinia 运行态 store
    ├── style.css             # 全局浅色马卡龙视觉样式
    └── types.ts              # 前端数据类型
```

开发约定：

- 新增页面放到 `web/src/pages/`。
- 复用控件放到 `web/src/components/`。
- 新增接口优先封装到 `web/src/services/api.ts` 或 store action。
- 页面组件只做展示和少量页面内计算；跨页面数据放在 `stores/runtime.ts`。
- Dashboard 不直接修改 agent 执行逻辑。

## API 一览

| 接口 | 作用 |
| --- | --- |
| `GET /api/health` | 后端健康检查。 |
| `GET /api/config` | 返回非敏感运行配置和 key 是否已配置。 |
| `GET /api/archives` | 列出实时数据源和历史快照。 |
| `POST /api/archives/select` | 切换当前展示数据源。 |
| `GET /api/status` | 当前 runner 状态。 |
| `GET /api/state` | 结构化白板状态。 |
| `GET /api/overview` | 总览聚合数据。 |
| `GET /api/topology` | 拓扑节点和连接。 |
| `GET /api/timeline` | 分轮时间线。 |
| `GET /api/findings` | 主机、服务、凭据、访问能力等发现。 |
| `GET /api/evidence` | 工具调用、命令和证据摘要。 |
| `GET /api/flags` | flag 列表和归因信息。 |
| `GET /api/notes` | 阶段笔记。 |
| `GET /api/decisions` | 下一轮建议、问题修正和奖励评估。 |
| `GET /api/team` | 团队协同视图数据。 |
| `POST /api/run` | 启动真实 agent 任务。 |
| `POST /api/stop` | 停止当前 agent 任务。 |

## 测试清单

后端语法检查：

```bash
npm run check
```

前端构建检查：

```bash
npm run dashboard:build
```

接口检查：

```bash
node dashboard/server.js
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/config
curl http://127.0.0.1:3000/api/archives
curl -X POST http://127.0.0.1:3000/api/archives/select \
  -H 'Content-Type: application/json' \
  --data '{"id":"history/demo-03-full-chain"}'
curl http://127.0.0.1:3000/api/flags
```

检查重点：

- `/api/config` 不返回真实 API key。
- 选择归档后，前端页面数据能同步切换。
- 启动真实任务时，数据源自动切回实时模式。
- `npm --prefix dashboard/web run build` 没有类型错误。
