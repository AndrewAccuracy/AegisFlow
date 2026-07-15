# pen-agent Dashboard

Vue 前端展示系统，用于实时展示 agent 运行产物。

## 数据来源与写入

Dashboard 服务读取以下运行文件，用于展示实时状态：

- `.pen-agent/state.json`
- `.pen-agent/status.json`
- `.pen-agent/stream.log`
- `artifacts/flags.json`
- `artifacts/flags.txt`
- `artifacts/`

Dashboard 也提供本地任务控制能力。启动、停止或恢复任务时，会调用 `node src/index.js`，并写入 `.pen-agent/status.json`、`history/` 运行快照以及规范化后的 flag 文件。

## 开发运行

先安装前端依赖：

```bash
npm --prefix dashboard/web install
```

启动 dashboard API：

```bash
node dashboard/server.js
```

另一个终端启动 Vue 开发服务：

```bash
npm --prefix dashboard/web run dev
```

访问：

```text
http://localhost:5173
```

## 生产构建

```bash
npm --prefix dashboard/web run build
node dashboard/server.js
```

访问：

```text
http://127.0.0.1:3000
```

## 展示能力

- 当前运行状态。
- agent 探测到的资产和服务。
- 攻击轮次和阶段摘要。
- 工具调用和证据。
- flag 列表。
- flag 获取方法和相关命令的 best-effort 归因。
- 原始日志 tail。
- 项目需求完成度。
