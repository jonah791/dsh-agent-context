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

DSH（DeepSeek Harness）插件：会话上下文的注入与管理。

## 功能特性

- 上下文注入：按需向会话请求注入上下文内容
- 会话感知：与 agent 会话模型联动

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
