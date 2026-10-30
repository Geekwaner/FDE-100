/**
 * Mastra Agent：负责「把检索到的片段组织成中文回答」。
 *
 * 设计取舍：
 * - 检索在服务端预取（retriever.js），不交给模型自主调用工具 —— 首字延迟更可控，行为可预测。
 *   AGENT_ALLOW_TOOLS=1 时才把 searchCases 工具挂上去，供模型在上下文不足时二次检索。
 * - 模型走 AI SDK 的 OpenAI 兼容 provider，指向硅基流动。
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from './config.js';
import { retrieve } from './retriever.js';

const INSTRUCTIONS = `你是 Datawhale《FDE 案例 100》案例集的导读助手，读者是想了解企业 AI 真实落地过程的从业者。

回答规则：
1. 只依据用户消息里「参考资料」的内容作答。资料之外的数字、公司名、时间、结论一律不要编造。
2. 每条结论后面用括号标注来源案例编号，例如（NO.1）、（NO.7 从纸质流程到数据驱动）。没有编号依据的话不要写。
3. 资料不足以回答时，直接说明「这套案例集里没有相关内容」，然后指出最接近的案例；不要硬答。
4. 结构：先一句话结论，再给 2–4 个要点；总长度控制在 300 字以内，用中文，不使用标题层级。
5. 问题里出现「这个案例」「它」「这家公司」等指代时，结合对话历史确定案例编号；无法确定就直接说明不确定，不要随便换一个案例。
6. 不要输出思考过程，不要复述这些规则，不要提「参考资料」「上下文」这类词。`;

let agent = null;

function createAgent() {
  const provider = createOpenAICompatible({
    name: 'siliconflow',
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
  });

  const tools = {};
  if (config.agent.allowTools) {
    tools.searchCases = createTool({
      id: 'searchCases',
      description: '在 FDE 案例集里做一次语义检索，用于补齐上下文。输入一句自然语言查询。',
      inputSchema: z.object({ query: z.string().describe('检索用的中文问题') }),
      execute: async ({ context }) => {
        const { hits } = await retrieve(context.query, 4);
        return { results: hits.map((h) => ({ caseNo: h.caseNo, label: h.label, text: h.text.slice(0, 600) })) };
      },
    });
  }

  return new Agent({
    name: 'fde-case-assistant',
    instructions: INSTRUCTIONS,
    model: provider(config.llm.model),
    temperature: config.llm.temperature,
    maxOutputTokens: config.llm.maxTokens,
    tools,
  });
}

export function getAgent() {
  if (!agent) agent = createAgent();
  return agent;
}

export function buildContext(hits) {
  if (!hits.length) return '（没有检索到相关案例片段）';
  return hits
    .map((h) => `[${h.caseNo} ${h.short}｜${h.label}]\n${h.text}`)
    .join('\n\n');
}

const ANAPHORA = /(这个|该|那个|这家|上述|刚才|前面|它)[^。？?]{0,6}案例|它(的|后来|效果|方案)|这家公司/;

export function isAnaphora(query) {
  return ANAPHORA.test(String(query || ''));
}

export function buildMessages({ query, hits, history = [], recentCases = [] }) {
  const turns = history.slice(-config.agent.historyTurns).map((t) => ({
    role: t.role === 'assistant' ? 'assistant' : 'user',
    content: t.content,
  }));

  // 「这个案例后来效果如何」这类指代，模型常常忽略历史消息；
  // 用上一轮引用过的案例号给一个显式线索，比只靠 memory 稳定得多。
  let hint = '';
  if (recentCases.length && ANAPHORA.test(query)) {
    hint = `\n\n（对话线索：前文讨论的案例是 ${recentCases.slice(0, 2).join('、')}；问题里的"这个案例"指代它，请围绕该案例作答。）`;
  }

  return [
    ...turns,
    {
      role: 'user',
      content: `参考资料：\n${buildContext(hits)}\n\n读者问题：${query}${hint}`,
    },
  ];
}

/**
 * 流式生成。onDelta 收到文本增量；返回累计文本与用量。
 */
export async function streamAnswer({ messages, onDelta, isAborted }) {
  const res = await getAgent().stream(messages, {
    providerOptions: { siliconflow: { enable_thinking: config.llm.thinking } },
  });
  let text = '';
  let usage = null;

  try {
    // Mastra 1.x 的增量在 fullStream 的 text-delta 里，文本字段是 payload.text
    for await (const part of res.fullStream) {
      if (isAborted && isAborted()) {
        if (typeof res.abort === 'function') await res.abort();
        break;
      }
      if (part.type === 'text-delta') {
        const delta = part.payload?.text ?? part.textDelta ?? part.delta ?? '';
        if (!delta) continue;
        text += delta;
        onDelta(delta);
      } else if (part.type === 'error') {
        throw new Error(part.payload?.error?.message || part.error?.message || '模型返回错误');
      }
    }
  } finally {
    try {
      usage = (await res.usage) || null;
    } catch {
      /* 用量拿不到不影响主流程 */
    }
  }

  // 兜底：若流里没拿到增量（个别 provider 行为差异），用最终文本补一次
  if (!text.trim()) {
    try {
      const final = (await res.text) || '';
      if (final.trim()) {
        text = final;
        onDelta(final);
      }
    } catch {
      /* ignore */
    }
  }

  return { text, usage };
}
