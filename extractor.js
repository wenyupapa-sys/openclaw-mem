/**
 * OpenClaw-Mem LLM Extractor
 * Uses the local OpenClaw Gateway model to extract concepts and metadata
 */

import { callGatewayChat } from './gateway-llm.js';

// Cache for extracted concepts (to avoid repeated API calls)
const conceptCache = new Map();
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCacheKey(text) {
  // Simple hash for cache key
  let hash = 0;
  const str = text.slice(0, 500); // Only hash first 500 chars
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

function cleanCache() {
  if (conceptCache.size > CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [key, value] of conceptCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        conceptCache.delete(key);
      }
    }
    // If still too large, remove oldest entries
    if (conceptCache.size > CACHE_MAX_SIZE) {
      const entries = [...conceptCache.entries()];
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, entries.length - CACHE_MAX_SIZE / 2);
      for (const [key] of toRemove) {
        conceptCache.delete(key);
      }
    }
  }
}

/**
 * Extract concepts/keywords from text using LLM
 * @param {string} text - The text to extract concepts from
 * @param {object} options - Options
 * @returns {Promise<string[]>} - Array of extracted concepts
 */
export async function extractConcepts(text, options = {}) {
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return [];
  }

  // Check cache first
  const cacheKey = getCacheKey(text);
  const cached = conceptCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.concepts;
  }

  try {
    const content = await callGatewayChat([{
      role: 'user',
      content: `Extract 3-7 key concepts/topics from this text. Return ONLY a JSON array of strings, no explanation.

Text: "${text.slice(0, 800)}"

JSON array:`
    }], { sessionKey: 'extract-concepts', temperature: 0.2, max_tokens: 200 });

    if (!content) return [];
    // Parse JSON array from response
    let concepts = [];
    try {
      // Try to extract JSON array from response
      const match = content.match(/\[[\s\S]*?\]/);
      if (match) {
        concepts = JSON.parse(match[0]);
      }
    } catch (parseErr) {
      console.error('[openclaw-mem] Failed to parse LLM response:', parseErr.message);
      return [];
    }

    // Validate and clean concepts
    concepts = concepts
      .filter(c => typeof c === 'string' && c.length > 1 && c.length < 50)
      .map(c => c.trim().toLowerCase())
      .slice(0, 7);

    // Cache the result
    cleanCache();
    conceptCache.set(cacheKey, {
      concepts,
      timestamp: Date.now()
    });

    return concepts;
  } catch (err) {
    console.error('[openclaw-mem] LLM extraction error:', err.message);
    return [];
  }
}

/**
 * Extract structured information from a tool call
 * @param {object} data - Tool call data
 * @returns {Promise<object>} - Extracted information
 */
export async function extractFromToolCall(data) {
  const { tool_name, tool_input, tool_response, filesRead, filesModified } = data;

  // Build context for extraction
  const inputStr = typeof tool_input === 'string'
    ? tool_input.slice(0, 300)
    : JSON.stringify(tool_input).slice(0, 300);

  const responseStr = typeof tool_response === 'string'
    ? tool_response.slice(0, 300)
    : JSON.stringify(tool_response).slice(0, 300);

  try {
    const content = await callGatewayChat([{
      role: 'user',
      content: `Analyze this tool call and extract structured information. Return ONLY valid JSON.

Tool: ${tool_name}
Input: ${inputStr}
Output: ${responseStr}
Files read: ${filesRead?.join(', ') || 'none'}
Files modified: ${filesModified?.join(', ') || 'none'}

Return JSON with these fields:
{
  "type": "decision|bugfix|feature|refactor|discovery|testing|setup|other",
  "narrative": "One sentence describing what happened",
  "facts": ["fact1", "fact2"],
  "concepts": ["keyword1", "keyword2", "keyword3"]
}

JSON:`
    }], { sessionKey: 'extract-toolcall', temperature: 0.2, max_tokens: 300 });

    if (!content) throw new Error('empty response');

    // Parse JSON from response
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      return {
        type: result.type || 'other',
        narrative: result.narrative || '',
        facts: Array.isArray(result.facts) ? result.facts.slice(0, 5) : [],
        concepts: Array.isArray(result.concepts) ? result.concepts.slice(0, 7) : []
      };
    }
  } catch (err) {
    console.error('[openclaw-mem] Tool extraction error:', err.message);
  }

  // Return empty result on error
  return {
    type: 'other',
    narrative: '',
    facts: [],
    concepts: []
  };
}

/**
 * Batch extract concepts from multiple texts
 * @param {string[]} texts - Array of texts to extract from
 * @returns {Promise<Map<string, string[]>>} - Map of text to concepts
 */
export async function batchExtractConcepts(texts) {
  const results = new Map();

  // Filter out cached results first
  const uncached = [];
  for (const text of texts) {
    const cacheKey = getCacheKey(text);
    const cached = conceptCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.set(text, cached.concepts);
    } else {
      uncached.push(text);
    }
  }

  // Process uncached in batches
  const BATCH_SIZE = 5;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const promises = batch.map(text => extractConcepts(text));
    const batchResults = await Promise.all(promises);

    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j], batchResults[j]);
    }
  }

  return results;
}

export default {
  extractConcepts,
  extractFromToolCall,
  batchExtractConcepts
};
