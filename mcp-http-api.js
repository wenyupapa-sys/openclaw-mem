#!/usr/bin/env node
/**
 * OpenClaw-Mem HTTP API Server
 *
 * HTTP 接口替代 MCP（用于 OpenClaw 不支持 MCP 的情况）
 * 启动: node mcp-http-api.js
 * 端口: 18790
 */

import http from 'http';
import database from './database.js';
import { callGatewayEmbeddings } from './gateway-llm.js';

const PORT = process.env.OPENCLAW_MEM_API_PORT || 18790;

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

const TYPE_EMOJI = {
  'session-request': '📋',
  'discovery': '🔵',
  'bugfix': '🔴',
  'feature': '🟣',
  'refactor': '🔄',
  'change': '✅',
  'decision': '⚖️',
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

// ============ Hybrid Search ============

function mergeHybridResults(ftsResults, vectorResults, limit) {
  let ftsMin = Infinity, ftsMax = -Infinity;
  for (const r of ftsResults) {
    const rank = Math.abs(r.rank ?? 0);
    if (rank < ftsMin) ftsMin = rank;
    if (rank > ftsMax) ftsMax = rank;
  }
  const ftsRange = ftsMax - ftsMin || 1;

  const scoreMap = new Map();

  for (const r of ftsResults) {
    const rank = Math.abs(r.rank ?? 0);
    const ftsScore = 1 - ((rank - ftsMin) / ftsRange);
    scoreMap.set(r.id, { obs: r, ftsScore, vecScore: 0 });
  }

  for (const v of vectorResults) {
    const vecScore = 1 - (v.distance ?? 0);
    const existing = scoreMap.get(v.observation_id);
    if (existing) {
      existing.vecScore = vecScore;
    } else {
      const obs = database.getObservation(v.observation_id);
      if (obs) {
        scoreMap.set(v.observation_id, { obs, ftsScore: 0, vecScore });
      }
    }
  }

  const scored = [];
  for (const [id, entry] of scoreMap) {
    const { obs, ftsScore, vecScore } = entry;
    const inBoth = ftsScore > 0 && vecScore > 0;
    const combined = (0.4 * ftsScore) + (0.6 * vecScore) + (inBoth ? 0.2 : 0);
    scored.push({ obs, combined });
  }

  scored.sort((a, b) => b.combined - a.combined);
  return scored.slice(0, limit).map(s => s.obs);
}

// ============ API 功能 ============

async function search(args = {}) {
  const query = typeof args === 'string' ? args : (args.query || args.q || '*');
  const limit = args.limit ?? 30;

  let results;
  if (query === '*' || !query) {
    results = database.getRecentObservations(null, limit);
  } else {
    // Hybrid search: FTS + vector
    const ftsResults = database.searchObservations(query, limit * 2);

    let vectorResults = [];
    try {
      const embedding = await callGatewayEmbeddings(query);
      if (embedding) {
        vectorResults = database.searchByVector(embedding, limit * 2);
      }
    } catch (err) {
      console.error('[openclaw-mem-api] Vector search error:', err.message);
    }

    if (vectorResults.length > 0) {
      results = mergeHybridResults(ftsResults, vectorResults, limit);
      console.log(`[openclaw-mem-api] Hybrid: ${ftsResults.length} FTS + ${vectorResults.length} vector → ${results.length} merged`);
    } else {
      results = ftsResults.slice(0, limit);
    }
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

  const lines = [`Found ${results.length} result(s)`, ''];

  for (const [dateKey, obs] of grouped.entries()) {
    lines.push(`### ${formatDateHeading(dateKey) || dateKey}`);
    lines.push('| ID | Time | T | Title | Read |');
    lines.push('|----|------|---|-------|------|');

    for (const o of obs) {
      const title = truncateText(o.narrative || o.summary || o.tool_name, 60);
      lines.push(`| #${o.id} | ${formatTime(o.timestamp)} | ${getTypeLabel(o)} | ${title} | ~${o.tokens_read || estimateTokens(title)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function timeline(args = {}) {
  let anchorId = args.anchor ?? args.id;
  if (!anchorId && args.query) {
    const searchResults = database.searchObservations(args.query, 1);
    if (searchResults.length > 0) anchorId = searchResults[0].id;
  }

  anchorId = Number(String(anchorId ?? '').replace(/^#/, ''));
  if (Number.isNaN(anchorId)) {
    return 'No anchor ID provided';
  }

  const depthBefore = args.depth_before ?? 3;
  const depthAfter = args.depth_after ?? 2;

  const allObs = database.getRecentObservations(null, 100);
  const anchorIdx = allObs.findIndex(o => o.id === anchorId);

  if (anchorIdx === -1) {
    const anchor = database.getObservation(anchorId);
    return anchor ? get_observations({ ids: [anchorId] }) : `Observation #${anchorId} not found`;
  }

  const startIdx = Math.max(0, anchorIdx - depthAfter);
  const endIdx = Math.min(allObs.length, anchorIdx + depthBefore + 1);
  const timelineObs = allObs.slice(startIdx, endIdx).reverse();

  const lines = [`## Timeline around #${anchorId}`, '', '| | Time | T | ID | Title |', '|---|------|---|-----|-------|'];

  for (const o of timelineObs) {
    const marker = o.id === anchorId ? '→' : '';
    const title = truncateText(o.narrative || o.summary || o.tool_name, 70);
    lines.push(`| ${marker} | ${formatTime(o.timestamp)} | ${getTypeLabel(o)} | #${o.id} | ${title} |`);
  }

  return lines.join('\n');
}

function get_observations(args = {}) {
  const ids = normalizeIds(args.ids ?? args.id ?? []);
  if (!ids.length) return 'No IDs provided';

  const observations = database.getObservations(ids);
  if (!observations.length) return `No observations found for IDs: ${ids.join(', ')}`;

  const lines = [];
  for (const o of observations) {
    lines.push(`## #${o.id} ${getTypeLabel(o)} ${truncateText(o.narrative || o.summary || o.tool_name, 80)}`);
    lines.push('');
    if (o.timestamp) lines.push(`**Time**: ${formatDateHeading(o.timestamp)} ${formatTime(o.timestamp)}`);
    if (o.tool_name) lines.push(`**Tool**: ${o.tool_name}`);
    if (o.type) lines.push(`**Type**: ${o.type}`);
    lines.push('');

    // 优先显示完整内容（concepts 字段），而不是截断的 summary
    const fullContent = o.concepts || o.summary || '';
    if (fullContent) {
      lines.push(`**内容**:`);
      lines.push('');
      lines.push(fullContent);
      lines.push('');
    }

    let facts = o.facts;
    if (typeof facts === 'string') try { facts = JSON.parse(facts); } catch { facts = null; }
    if (Array.isArray(facts) && facts.length > 0) {
      lines.push('**Facts**:');
      facts.slice(0, 8).forEach(f => f && lines.push(`- ${f}`));
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function getStats() {
  const stats = database.getStats();
  return JSON.stringify(stats, null, 2);
}

// ============ HTTP Server ============

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    // 处理未编码的中文 URL - 手动编码非 ASCII 字符
    let safeUrl = req.url;
    try {
      // 检查 URL 是否包含未编码的非 ASCII 字符
      if (/[^\x00-\x7F]/.test(req.url)) {
        // 只编码查询字符串部分的非 ASCII 字符
        const [pathPart, queryPart] = req.url.split('?');
        if (queryPart) {
          const encodedQuery = queryPart.replace(/[^\x00-\x7F]/g, (char) => encodeURIComponent(char));
          safeUrl = pathPart + '?' + encodedQuery;
        }
      }
    } catch (e) {
      // 编码失败时使用原始 URL
    }
    const url = new URL(safeUrl, `http://localhost:${PORT}`);

    // 记录 API 请求（用于监控）- 详细日志
    if (url.pathname !== '/health') {
      const ts = new Date().toISOString();
      console.log(`[${ts}] ${req.method} ${url.pathname}`);
      console.log(`  Raw URL: ${req.url}`);
      console.log(`  Query: ${url.search}`);
      if (body) console.log(`  Body: ${body.slice(0, 200)}`);
    }

    // 解析参数
    let args = {};
    if (body) {
      try { args = JSON.parse(body); } catch { args = {}; }
    }
    // GET 参数
    for (const [key, value] of url.searchParams) {
      args[key] = value;
    }

    let result;
    let contentType = 'text/plain; charset=utf-8';

    try {
      switch (url.pathname) {
        case '/':
        case '/health':
          result = JSON.stringify({ status: 'ok', version: '1.0.0' });
          contentType = 'application/json';
          break;

        case '/search':
          result = await search(args);
          break;

        case '/timeline':
          result = timeline(args);
          break;

        case '/get_observations':
        case '/observations':
          result = get_observations(args);
          break;

        case '/stats':
          result = getStats();
          contentType = 'application/json';
          break;

        case '/help':
          result = `# OpenClaw-Mem HTTP API

## Endpoints

### GET/POST /search
Search memory observations.
Params: query, limit

### GET/POST /timeline
Get context around an observation.
Params: anchor (ID), query, depth_before, depth_after

### GET/POST /get_observations
Get full details for specific IDs.
Params: ids (array or comma-separated)

### GET /stats
Get database statistics.

## Examples

curl "http://localhost:${PORT}/search?query=database&limit=10"
curl "http://localhost:${PORT}/timeline?anchor=123"
curl -X POST "http://localhost:${PORT}/get_observations" -d '{"ids":[123,124]}'
`;
          break;

        default:
          res.writeHead(404);
          res.end('Not found. Try /help');
          return;
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(result);
    } catch (error) {
      console.error('[openclaw-mem-api] Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[openclaw-mem] HTTP API running on http://127.0.0.1:${PORT}`);
  console.log(`[openclaw-mem] Try: curl "http://127.0.0.1:${PORT}/help"`);

  // Preload embedding model in background
  callGatewayEmbeddings('warmup').then(() => {
    console.log('[openclaw-mem] Embedding model preloaded for HTTP API');
  }).catch(() => {});
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[openclaw-mem] Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[openclaw-mem] Shutting down...');
  server.close(() => process.exit(0));
});
