/**
 * DeepSeek LLM helper
 * Calls the DeepSeek OpenAI-compatible endpoint to summarize sessions.
 */

const SUMMARY_SESSION_PREFIX = 'mem-summary:';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

function getDeepSeekBaseUrl() {
  return process.env.DEEPSEEK_BASE_URL
    || DEFAULT_DEEPSEEK_BASE_URL;
}

function getDeepSeekApiKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

function getDeepSeekModel() {
  return process.env.DEEPSEEK_MODEL
    || DEFAULT_DEEPSEEK_MODEL;
}

function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

function formatTranscript(messages, maxChars = 8000) {
  const lines = [];
  for (const m of messages) {
    const role = (m.role || 'unknown').toUpperCase();
    const content = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }
  return truncateText(lines.join('\n'), maxChars);
}

function parseSummaryJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function normalizeSummaryFields(obj) {
  if (!obj) return null;
  const pick = (key) => {
    const val = obj[key];
    if (typeof val === 'string') return val.trim();
    if (val == null) return '';
    return String(val).trim();
  };
  return {
    request: pick('request'),
    learned: pick('learned'),
    completed: pick('completed'),
    next_steps: pick('next_steps')
  };
}

async function callGatewayChat(messages, options = {}) {
  const {
    sessionKey = 'unknown',
    temperature = 0.2,
    max_tokens = 300,
    model
  } = options;
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    console.log('[openclaw-mem] No DEEPSEEK_API_KEY found');
    return null;
  }
  const baseUrl = getDeepSeekBaseUrl();
  const resolvedModel = model || getDeepSeekModel();
  const url = `${baseUrl}/chat/completions`;
  const payload = {
    model: resolvedModel,
    stream: false,
    temperature,
    max_tokens,
    messages
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  try {
    console.log('[openclaw-mem] Calling DeepSeek API...');
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[openclaw-mem] DeepSeek API error:', res.status, errText);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || '';
    console.log('[openclaw-mem] DeepSeek response received');
    return content;
  } catch (err) {
    console.error('[openclaw-mem] DeepSeek fetch error:', err.message);
    return null;
  }
}

export async function summarizeSession(messages, options = {}) {
  const { sessionKey = 'unknown' } = options;
  const transcript = formatTranscript(messages);
  if (!transcript) return null;

  const buildPrompts = (strict = false) => {
    const systemPrompt = [
      '你是一个对话总结助手。请用中文总结这段对话，返回一个 JSON 对象，包含以下字段：',
      '- request: 用户的主要问题或需求（一句话）',
      '- learned: 用户从对话中学到了什么',
      '- completed: 完成了什么任务或解答',
      '- next_steps: 建议的下一步行动',
      '只返回 JSON 对象，不要 markdown 代码块，不要其他内容。',
      strict ? '重要：只输出纯 JSON，不要任何额外文字。' : ''
    ].filter(Boolean).join('\n');
    const userPrompt = '对话记录:\n' + transcript + '\n\nJSON:';
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
  };

  // First attempt
  let content = await callGatewayChat(buildPrompts(false), { sessionKey, temperature: 0.2, max_tokens: 300 });
  let parsed = parseSummaryJson(content || '');
  if (parsed) return normalizeSummaryFields(parsed);

  // Retry once with stricter instruction
  content = await callGatewayChat(buildPrompts(true), { sessionKey, temperature: 0.2, max_tokens: 300 });
  parsed = parseSummaryJson(content || '');
  if (parsed) return normalizeSummaryFields(parsed);

  return null;
}

export const INTERNAL_SUMMARY_PREFIX = SUMMARY_SESSION_PREFIX;
export { callGatewayChat };
