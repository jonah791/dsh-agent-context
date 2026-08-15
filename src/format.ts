/**
 * 报告格式化（纯函数，可独立测试）。
 */
import type { ContextReport } from './index.js';

/** 人类友好 token 数值：<1k 原样，<1M 显示 x.xk，其余 x.xxM。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

/** 中文人类可读报告：占用 → 花费 → 组成。 */
export function formatReportText(report: ContextReport): string {
  const lines: string[] = [];
  lines.push('上下文状态（事件 ' + report.asOfSeq + '）');
  const window = report.contextWindow;
  const projected = report.projectedTokens;
  if (window !== undefined) {
    const occ = projected ?? report.totalTokens;
    const pct = Math.round((occ / window) * 100);
    lines.push('占用：' + formatTokens(occ) + ' / ' + formatTokens(window) + ' (' + pct + '%)');
  } else {
    lines.push('占用（估计）：' + formatTokens(report.totalTokens));
    if (projected !== undefined) {
      lines.push('下次请求预计：' + formatTokens(projected));
    }
  }
  if (report.pressureTokens !== undefined) {
    lines.push('最近请求 prompt：' + formatTokens(report.pressureTokens));
  }
  lines.push('surface：' + formatTokens(report.surfaceTokens) + '（' + report.surfaceMessages.toLocaleString('zh-CN') + ' 条消息）');
  const u = report.usage;
  lines.push(
    '已花费（累计）：' + formatTokens(report.usageTotal)
      + ' = 未缓存输入 ' + formatTokens(u.uncachedInputTokens)
      + ' + 缓存读 ' + formatTokens(u.cacheReadTokens)
      + ' + 缓存写 ' + formatTokens(u.cacheWriteTokens)
      + ' + 输出 ' + formatTokens(u.outputTokens),
  );
  const b = report.breakdown;
  lines.push(
    '组成（启发式）：system ' + formatTokens(b.systemTokens)
      + ' / tools ' + formatTokens(b.toolsTokens)
      + ' / messages ' + formatTokens(b.messageTokens),
  );
  return lines.join('\n');
}