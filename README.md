# dsh-agent-context

感知当前会话的**上下文占用**与**已花费 token**。只读聚合官方能力，不引入新计量：

- `ctx.tokenMeter.measure(session)`（replay-aware 请求压力与 surface 测量）
- `ctx.sessionProjections.snapshot(session)`（tokenUsage 累计 / contextPressure 占用 / contextBreakdown 组成）

## 功能

### 1. `/context` 命令

在任意会话输入 `/context`，返回中文报告：占用（当前/预计/容量占比）、最近请求 prompt、surface 大小、累计已花费（四桶）、启发式组成。

### 2. `ctx.contextMeter` 服务

```ts
const report = ctx.contextMeter.report(session)
// { sessionId, asOfSeq, logRevision, pressureTokens?, projectedTokens?,
//   totalTokens, surfaceTokens, surfaceMessages, contextWindow?,
//   usage: TokenUsageProjection, usageTotal, breakdown }
```

供其他插件（压缩决策、记忆信号等）结构化消费。

## 组合

```yaml
- insert:
    - id: agent-context
      name: dsh-agent-context
```

注入 `commands` / `tokenMeter` / `sessionProjections`（官方 web-app bundle 已提供）。零配置。

## 说明

- `contextWindow` 为最新路由模型容量（适配器上报）；缺失时报告给出估计占用而非百分比
- `projectedTokens` 以 provider usage 为锚，加 surface 增减启发式重定价——比纯估计更接近下次请求真实 prompt 大小
- 累计花费四桶互斥（reasoning 已含于 output）；来源是会话日志中的 provider usage 记录，压缩不影响累计

## 测试

```sh
node node_modules/typescript/lib/tsc.js -p tsconfig.json && node --test
```