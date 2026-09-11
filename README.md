<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 上下文治理一体化插件：/context 命令 + ctx.contextMeter 服务 + 剪枝工具（prune_candidates/apply/expand/guard/stats，合并自 dsh-agent-context-pruner）
  inject: 'commands','tokenMeter','sessionProjections','tools'
  tools: prune_candidates,prune_apply,prune_guard,prune_stats,expand
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-context — 上下文管理插件


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-context"><img src="https://img.shields.io/badge/version-0.2.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
DSH（DeepSeek Harness）插件：会话上下文的注入与管理。

## 功能特性

- 上下文注入：按需向会话请求注入上下文内容
- 会话感知：与 agent 会话模型联动
- `/context` 命令：人类可读的上下文占用报告（占用、花费、组成）
- `ctx.contextMeter` 服务：结构化上下文快照（供其他插件消费）
- 剪枝工具：`prune_candidates` / `prune_apply` / `prune_guard` / `prune_stats` / `expand`
- **压缩失败守望**（v0.2.1）：压缩失败不再静默

## 压缩失败守望（v0.2.1）

**为什么需要它。** 压缩插件的「会话忙」路径是 fire-and-forget——工具返回「压缩已启动」，
真正的提交发生在之后（模型输出 checkpoint 时），此时抛出的错误**回不到工具调用方**，
最终只落一行 `logger.warn`。实测代价：10 次压缩全部失败、跨 2 天无人知晓，直到从
「流程跑完了但上下文没减少」这个症状才发现。**durable ≠ visible**——失败记录在会话事件流里，
但没有机制去读它。

**它做什么。** 在每轮结束（`turn/end`）时，从会话尾部有界回溯，找出最近一次
`compaction/end`；若它携带 `error`，就向会话投递一条【压缩告警】，附带失败原因与事件 seq，
供下一步取证。

**它不做什么（避免狼来了）。** 最近一次压缩成功即视为健康，不报历史旧错误；同一失败事件
只提醒一次；只看尾部固定窗口，不扫全库；纯读取 + 字符串拼装，任何异常静默返回——
提醒机制的故障绝不影响会话与压缩本身。

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-context.git
cd dsh-agent-context
pnpm install
pnpm build
```

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
