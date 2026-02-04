#!/usr/bin/env node
/**
 * OpenClaw-Mem MCP Server
 *
 * 实现 MCP (Model Context Protocol) 标准接口
 * 提供 3 层记忆检索工作流：search → timeline → get_observations
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import database from './database.js';
import { callGatewayEmbeddings } from './gateway-llm.js';

// ============ 工具函数 ============

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

function formatDateHeading(dateOrKey) {
  if (!dateOrKey) return '';
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOrKey)) {
    date = new Date(`${dateOrKey}T00:00:00`);
  } else {
    date = new Date(dateOrKey);
  }
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function truncateText(text, max = 80) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, Math.max(0, max - 3)) + '...';
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// Type mapping
const TYPE_EMOJI = {
  'session-request': '📋',
  'discovery': '🔵',
  'bugfix': '🔴',
  'feature': '🟣',
  'refactor': '🔄',
  'change': '✅',
  'decision': '⚖️',
  'problem-solution': '💡',
  'gotcha': '⚠️',
};

function getTypeLabel(observation) {
  const type = observation?.type || 'discovery';
  return TYPE_EMOJI[type] || '🔵';
}

function normalizeIds(input) {
  const ids = [];
  const pushId = (value) => {
    if (value === null || value === undefined) return;
    const cleaned = String(value).replace(/^#/, '').trim();
    if (!cleaned) return;
    const parsed = Number(cleaned);
    if (!Number.isNaN(parsed)) ids.push(parsed);
  };

  if (Array.isArray(input)) {
    input.forEach(pushId);
    return ids;
  }

  if (typeof input === 'string') {
    input.split(/[,\s]+/).forEach(pushId);
    return ids;
  }

  pushId(input);
  return ids;
}

// ============ 搜索功能 ============

/**
 * Hybrid search: merge FTS5 keyword results with vector KNN results.
 * FTS results get fts_score (normalized 0-1), vector results get vec_score (1 - distance).
 * Results found in both get a 0.2 intersection bonus.
 */
function mergeHybridResults(ftsResults, vectorResults, limit) {
  // Normalize FTS scores (rank is negative, lower is better)
  let ftsMin = Infinity, ftsMax = -Infinity;
  for (const r of ftsResults) {
    const rank = Math.abs(r.rank ?? 0);
    if (rank < ftsMin) ftsMin = rank;
    if (rank > ftsMax) ftsMax = rank;
  }
  const ftsRange = ftsMax - ftsMin || 1;

  const scoreMap = new Map(); // id -> { obs, ftsScore, vecScore }

  for (const r of ftsResults) {
    const rank = Math.abs(r.rank ?? 0);
    const ftsScore = 1 - ((rank - ftsMin) / ftsRange); // normalize to 0-1, higher is better
    scoreMap.set(r.id, { obs: r, ftsScore, vecScore: 0 });
  }

  for (const v of vectorResults) {
    const vecScore = 1 - (v.distance ?? 0); // cosine distance -> similarity
    const existing = scoreMap.get(v.observation_id);
    if (existing) {
      existing.vecScore = vecScore;
    } else {
      // Need to fetch the full observation for vector-only results
      const obs = database.getObservation(v.observation_id);
      if (obs) {
        scoreMap.set(v.observation_id, { obs, ftsScore: 0, vecScore });
      }
    }
  }

  // Calculate combined scores
  const scored = [];
  for (const [id, entry] of scoreMap) {
    const { obs, ftsScore, vecScore } = entry;
    const inBoth = ftsScore > 0 && vecScore > 0;
    const combined = (0.4 * ftsScore) + (0.6 * vecScore) + (inBoth ? 0.2 : 0);
    scored.push({ obs, combined, ftsScore, vecScore });
  }

  scored.sort((a, b) => b.combined - a.combined);
  return scored.slice(0, limit);
}

async function search(args = {}) {
  const query = typeof args === 'string' ? args : (args.query || args.q || '*');
  const limit = args.limit ?? args.maxResults ?? 30;
  const project = args.project || null;
  const type = args.type || args.obs_type || null;
  const dateStart = args.dateStart || null;
  const dateEnd = args.dateEnd || null;

  let results;

  if (query === '*' || !query) {
    // 获取最近的 observations — no embedding needed for recent listing
    results = database.getRecentObservations(project, limit * 2);
  } else {
    // Hybrid search: FTS5 + vector KNN
    const ftsResults = database.searchObservations(query, limit * 2);

    // Try vector search in parallel
    let vectorResults = [];
    try {
      const embedding = await callGatewayEmbeddings(query);
      if (embedding) {
        vectorResults = database.searchByVector(embedding, limit * 2);
      }
    } catch (err) {
      console.error('[openclaw-mem-mcp] Vector search error:', err.message);
    }

    if (vectorResults.length > 0) {
      // Merge hybrid results
      const merged = mergeHybridResults(ftsResults, vectorResults, limit * 2);
      results = merged.map(m => m.obs);
      console.error(`[openclaw-mem-mcp] Hybrid search: ${ftsResults.length} FTS + ${vectorResults.length} vector → ${results.length} merged`);
    } else {
      // Fallback to FTS-only
      results = ftsResults;
      console.error(`[openclaw-mem-mcp] FTS-only search: ${results.length} results`);
    }
  }

  // 过滤
  if (type) {
    results = results.filter(r => r.type === type);
  }
  if (dateStart) {
    const start = new Date(dateStart).getTime();
    results = results.filter(r => new Date(r.timestamp).getTime() >= start);
  }
  if (dateEnd) {
    const end = new Date(dateEnd).getTime() + 86400000; // 包含当天
    results = results.filter(r => new Date(r.timestamp).getTime() < end);
  }

  results = results.slice(0, limit);

  if (results.length === 0) {
    return `No observations found for query: "${query}"`;
  }

  // 按日期分组
  const grouped = new Map();
  for (const obs of results) {
    const dateKey = formatDate(obs.timestamp) || 'Unknown';
    if (!grouped.has(dateKey)) {
      grouped.set(dateKey, []);
    }
    grouped.get(dateKey).push(obs);
  }

  const lines = [
    `Found ${results.length} result(s) matching "${query}"`,
    ''
  ];

  for (const [dateKey, obs] of grouped.entries()) {
    const heading = formatDateHeading(dateKey) || dateKey;
    lines.push(`### ${heading}`);
    lines.push('');
    lines.push('| ID | Time | T | Title | Read |');
    lines.push('|----|------|---|-------|------|');

    for (const o of obs) {
      const id = `#${o.id}`;
      const time = formatTime(o.timestamp);
      const typeLabel = getTypeLabel(o);
      const title = truncateText(o.narrative || o.summary || `${o.tool_name} operation`, 60);
      const tokens = `~${o.tokens_read || estimateTokens(title)}`;
      lines.push(`| ${id} | ${time} | ${typeLabel} | ${title} | ${tokens} |`);
    }
    lines.push('');
  }

  lines.push(`*Use \`timeline\` or \`get_observations\` for full details.*`);

  return lines.join('\n');
}

// ============ Timeline 功能 ============

function timeline(args = {}) {
  let anchorId;

  if (typeof args === 'number' || typeof args === 'string') {
    anchorId = Number(String(args).replace(/^#/, ''));
  } else {
    const anchor = args.anchor ?? args.id ?? args.observation_id ?? args.observationId;

    // 如果提供了 query，自动查找 anchor
    if (!anchor && args.query) {
      const searchResults = database.searchObservations(args.query, 1);
      if (searchResults.length > 0) {
        anchorId = searchResults[0].id;
      }
    } else {
      anchorId = Number(String(anchor ?? '').replace(/^#/, ''));
    }
  }

  if (Number.isNaN(anchorId)) {
    return 'No anchor ID provided. Use timeline(anchor=<ID>) or timeline(query="...")';
  }

  const depthBefore = Number(args.depth_before ?? args.before ?? 3);
  const depthAfter = Number(args.depth_after ?? args.after ?? 2);

  const anchor = database.getObservation(anchorId);
  if (!anchor) {
    return `Observation #${anchorId} not found`;
  }

  // 获取周围的 observations
  const allObs = database.getRecentObservations(null, 100);
  const anchorIdx = allObs.findIndex(o => o.id === anchorId);

  if (anchorIdx === -1) {
    // 只返回 anchor 本身
    return buildFullDetails([anchor], 1);
  }

  // 注意：列表是 DESC 排序，所以 "after" 在时间上是 "before" 在索引上
  const startIdx = Math.max(0, anchorIdx - depthAfter);
  const endIdx = Math.min(allObs.length, anchorIdx + depthBefore + 1);
  const timelineObs = allObs.slice(startIdx, endIdx).reverse();

  const lines = [
    `## Timeline around #${anchorId}`,
    '',
    '| | Time | T | ID | Title |',
    '|---|------|---|-----|-------|'
  ];

  for (const o of timelineObs) {
    const marker = o.id === anchorId ? '→' : '';
    const time = formatTime(o.timestamp);
    const typeLabel = getTypeLabel(o);
    const title = truncateText(o.narrative || o.summary || `${o.tool_name} operation`, 70);
    lines.push(`| ${marker} | ${time} | ${typeLabel} | #${o.id} | ${title} |`);
  }

  lines.push('');
  lines.push(`*Use \`get_observations(ids=[...])\` for full details.*`);

  return lines.join('\n');
}

// ============ Get Observations 功能 ============

function buildFullDetails(observations, limit = 10) {
  if (!observations || observations.length === 0) {
    return 'No observations found.';
  }

  const toShow = observations.slice(0, limit);
  const lines = [];

  for (const o of toShow) {
    const title = (o.narrative || o.summary || `${o.tool_name} operation`).replace(/\s+/g, ' ').trim();
    const typeLabel = getTypeLabel(o);
    const dateLabel = formatDateHeading(o.timestamp);
    const timeLabel = formatTime(o.timestamp);

    lines.push(`## #${o.id} ${typeLabel} ${truncateText(title, 100)}`);
    lines.push('');

    if (dateLabel || timeLabel) {
      lines.push(`**Time**: ${[dateLabel, timeLabel].filter(Boolean).join(' ')}`);
    }
    if (o.tool_name) {
      lines.push(`**Tool**: ${o.tool_name}`);
    }
    if (o.type) {
      lines.push(`**Type**: ${o.type}`);
    }
    lines.push('');

    if (o.summary) {
      lines.push(`**Summary**: ${o.summary}`);
      lines.push('');
    }

    if (o.narrative && o.narrative !== o.summary) {
      lines.push(`**Narrative**: ${o.narrative}`);
      lines.push('');
    }

    // 解析 facts
    let facts = o.facts;
    if (typeof facts === 'string') {
      try {
        facts = JSON.parse(facts);
      } catch {
        facts = null;
      }
    }
    if (Array.isArray(facts) && facts.length > 0) {
      lines.push('**Facts**:');
      for (const fact of facts.slice(0, 8)) {
        if (fact) lines.push(`- ${fact}`);
      }
      lines.push('');
    }

    // 文件信息
    let filesRead = o.files_read;
    let filesModified = o.files_modified;
    if (typeof filesRead === 'string') {
      try { filesRead = JSON.parse(filesRead); } catch { filesRead = null; }
    }
    if (typeof filesModified === 'string') {
      try { filesModified = JSON.parse(filesModified); } catch { filesModified = null; }
    }

    if (Array.isArray(filesRead) && filesRead.length > 0) {
      lines.push(`**Files Read**: ${filesRead.map(f => `\`${f}\``).join(', ')}`);
    }
    if (Array.isArray(filesModified) && filesModified.length > 0) {
      lines.push(`**Files Modified**: ${filesModified.map(f => `\`${f}\``).join(', ')}`);
    }

    // Tool input 关键信息
    let input = o.tool_input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    input = input || {};

    const inputFacts = [];
    if (input.file_path) inputFacts.push(`File: \`${input.file_path}\``);
    if (input.command) inputFacts.push(`Command: \`${input.command.slice(0, 100)}\``);
    if (input.pattern) inputFacts.push(`Pattern: \`${input.pattern}\``);
    if (input.query) inputFacts.push(`Query: ${input.query.slice(0, 100)}`);
    if (input.url) inputFacts.push(`URL: ${input.url}`);

    if (inputFacts.length > 0) {
      lines.push('');
      lines.push('**Details**: ' + inputFacts.join(' | '));
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function get_observations(args = {}) {
  const ids = Array.isArray(args)
    ? normalizeIds(args)
    : normalizeIds(args.ids ?? args.id ?? args.observation_ids ?? args.observationIds);

  if (!ids.length) {
    return 'No observation IDs provided. Use get_observations(ids=[1, 2, 3])';
  }

  const observations = database.getObservations(ids);

  if (observations.length === 0) {
    return `No observations found for IDs: ${ids.join(', ')}`;
  }

  return buildFullDetails(observations, observations.length);
}

// ============ __IMPORTANT 功能 ============

function __IMPORTANT() {
  return `## 3-LAYER MEMORY RETRIEVAL WORKFLOW

**ALWAYS follow this workflow to minimize token usage:**

1. **search(query)** → Get index with IDs (~50-100 tokens/result)
   \`search(query="...", limit=20)\`

2. **timeline(anchor=ID)** → Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=2)\`

3. **get_observations(ids=[...])** → Fetch full details ONLY for filtered IDs
   \`get_observations(ids=[1, 2, 3])\`

**NEVER fetch full details without filtering first. 10x token savings.**

### Quick Examples

- Search recent: \`search(query="*", limit=10)\`
- Search topic: \`search(query="database migration")\`
- Get context: \`timeline(anchor=123)\`
- Get details: \`get_observations(ids=[123, 124, 125])\`
`;
}

// ============ MCP Server 设置 ============

const TOOLS = [
  {
    name: '__IMPORTANT',
    description: '3-LAYER WORKFLOW: 1. search(query) → index 2. timeline(anchor) → context 3. get_observations(ids) → details. NEVER fetch details without filtering first.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, type, dateStart, dateEnd',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (use "*" for recent)' },
        limit: { type: 'number', description: 'Max results (default 30)' },
        project: { type: 'string', description: 'Filter by project path' },
        type: { type: 'string', description: 'Filter by type: discovery, bugfix, feature, refactor, change, decision' },
        dateStart: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        dateEnd: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
    },
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'number', description: 'Observation ID to center on' },
        query: { type: 'string', description: 'Auto-find anchor from search query' },
        depth_before: { type: 'number', description: 'Observations before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Observations after anchor (default 2)' },
      },
    },
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs, required)',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs to fetch (required)',
        },
      },
      required: ['ids'],
    },
  },
];

// 创建 MCP Server
const server = new Server(
  {
    name: 'openclaw-mem-search',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`[openclaw-mem-mcp] Tool called: ${name}`);

  try {
    let result;

    switch (name) {
      case '__IMPORTANT':
        result = __IMPORTANT();
        break;

      case 'search':
        result = await search(args || {});
        break;

      case 'timeline':
        result = timeline(args || {});
        break;

      case 'get_observations':
        result = get_observations(args || {});
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error) {
    console.error(`[openclaw-mem-mcp] Error:`, error.message);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[openclaw-mem-mcp] MCP Server started (stdio)');

  // Preload embedding model in background so first search doesn't timeout
  callGatewayEmbeddings('warmup').then(() => {
    console.error('[openclaw-mem-mcp] Embedding model preloaded');
  }).catch(() => {
    console.error('[openclaw-mem-mcp] Embedding model preload failed (will retry on first search)');
  });
}

main().catch((error) => {
  console.error('[openclaw-mem-mcp] Fatal error:', error);
  process.exit(1);
});
