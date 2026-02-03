/**
 * OpenClaw-Mem Hook Handler
 *
 * Captures session content and provides memory context injection.
 *
 * Events handled:
 * - command:new - Save session content before reset
 * - gateway:startup - Initialize memory system
 * - agent:bootstrap - Inject historical context
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { summarizeSession, INTERNAL_SUMMARY_PREFIX } from './gateway-llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
console.log('[openclaw-mem] >>> HANDLER LOADED AT', new Date().toISOString(), '<<<');
const USE_LLM_EXTRACTION = false;
const SUMMARY_MAX_MESSAGES = 200;
const MCP_API_PORT = 18790;

// Track API server process
let apiServerProcess = null;
let apiServerStarted = false;

// Avoid recursive memory capture for internal LLM runs
function isInternalSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== 'string') return false;
  return sessionKey.startsWith(INTERNAL_SUMMARY_PREFIX);
}

// Lazy load modules
let database = null;
let contextBuilder = null;
let extractor = null;

async function loadModules() {
  if (database && contextBuilder) return true;

  try {
    const dbModule = await import('./database.js');
    const ctxModule = await import('./context-builder.js');
    database = dbModule.default || dbModule.database;
    contextBuilder = ctxModule.default || ctxModule;

    if (USE_LLM_EXTRACTION) {
      // Try to load extractor (optional, for LLM extraction)
      try {
        const extractorModule = await import('./extractor.js');
        extractor = extractorModule.default || extractorModule;
      } catch (e) {
        console.log('[openclaw-mem] LLM extractor not available, using basic extraction');
      }
    }

    return true;
  } catch (err) {
    console.error('[openclaw-mem] Failed to load modules:', err.message);
    return false;
  }
}

// Generate UUID
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Estimate tokens
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// Simple hash function for content deduplication
function hashContent(text) {
  if (!text) return '';
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Read session transcript and extract conversation
 */
async function extractSessionContent(sessionFile, maxMessages = 20) {
  try {
    if (!sessionFile) return null;

    const content = await fs.readFile(sessionFile, 'utf-8');
    const lines = content.trim().split('\n');

    const messages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
            const text = Array.isArray(msg.content)
              ? msg.content.find(c => c.type === 'text')?.text
              : msg.content;

            if (text && !text.startsWith('/')) {
              messages.push({
                role: msg.role,
                content: text.slice(0, 500) // Truncate long messages
              });
            }
          }
        }
      } catch {
        // Skip invalid lines
      }
    }

    return messages.slice(-maxMessages);
  } catch (err) {
    console.error('[openclaw-mem] Failed to read session file:', err.message);
    return null;
  }
}

/**
 * Start the MCP HTTP API server
 */
async function startApiServer() {
  if (apiServerStarted) {
    console.log('[openclaw-mem] API server already started');
    return;
  }

  // Check if server is already running
  try {
    const response = await fetch(`http://127.0.0.1:${MCP_API_PORT}/health`, {
      signal: AbortSignal.timeout(1000)
    });
    if (response.ok) {
      console.log('[openclaw-mem] API server already running on port', MCP_API_PORT);
      apiServerStarted = true;
      return;
    }
  } catch {
    // Server not running, start it
  }

  const apiScript = path.join(__dirname, 'mcp-http-api.js');
  const logDir = path.join(os.homedir(), '.openclaw-mem', 'logs');

  // Ensure log directory exists
  try {
    await fs.mkdir(logDir, { recursive: true });
  } catch {}

  const logFile = path.join(logDir, 'api.log');

  try {
    // Start API server as detached process
    apiServerProcess = spawn('node', [apiScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCLAW_MEM_API_PORT: String(MCP_API_PORT) },
      cwd: __dirname
    });

    // Log output to file
    const logStream = await fs.open(logFile, 'a');
    apiServerProcess.stdout?.on('data', (data) => {
      logStream.write(data);
    });
    apiServerProcess.stderr?.on('data', (data) => {
      logStream.write(data);
    });

    apiServerProcess.unref();
    apiServerStarted = true;

    console.log(`[openclaw-mem] ✓ API server started on port ${MCP_API_PORT} (PID: ${apiServerProcess.pid})`);

    // Wait for server to be ready
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const response = await fetch(`http://127.0.0.1:${MCP_API_PORT}/health`, {
          signal: AbortSignal.timeout(500)
        });
        if (response.ok) {
          console.log('[openclaw-mem] ✓ API server is ready');
          break;
        }
      } catch {}
    }
  } catch (err) {
    console.error('[openclaw-mem] Failed to start API server:', err.message);
  }
}

/**
 * Handle gateway:startup event
 */
async function handleGatewayStartup(event) {
  console.log('[openclaw-mem] Gateway startup - initializing memory system');

  if (!await loadModules()) return;

  const stats = database.getStats();
  console.log(`[openclaw-mem] Memory stats: ${stats.total_sessions} sessions, ${stats.total_observations} observations`);

  // Start MCP HTTP API server
  await startApiServer();
}

/**
 * Handle agent:bootstrap event
 * Inject historical context into new agent sessions
 * AND capture incoming message to database
 */
async function handleAgentBootstrap(event) {
  console.log('[openclaw-mem] Agent bootstrap:', event.sessionKey);
  console.log('[openclaw-mem] Event keys:', Object.keys(event));
  console.log('[openclaw-mem] Context exists:', !!event.context);

  if (!await loadModules()) return;

  // IMPORTANT: Ensure event.context exists (modify event directly, not a local copy)
  if (!event.context) {
    console.log('[openclaw-mem] WARNING: event.context is missing, creating it');
    event.context = {};
  }

  console.log('[openclaw-mem] Context keys:', Object.keys(event.context));

  const workspaceDir = event.context.workspaceDir || path.join(os.homedir(), '.openclaw', 'workspace');
  const sessionKey = event.sessionKey || 'unknown';

  console.log('[openclaw-mem] workspaceDir:', workspaceDir);
  console.log('[openclaw-mem] bootstrapFiles exists:', !!event.context.bootstrapFiles);
  console.log('[openclaw-mem] bootstrapFiles is array:', Array.isArray(event.context.bootstrapFiles));
  console.log('[openclaw-mem] bootstrapFiles length before:', event.context.bootstrapFiles?.length);
  // Debug: show structure of first file
  if (event.context.bootstrapFiles?.[0]) {
    const sample = event.context.bootstrapFiles[0];
    console.log('[openclaw-mem] Sample file keys:', Object.keys(sample));
    console.log('[openclaw-mem] Sample file name:', sample.name);
    console.log('[openclaw-mem] Sample has content:', !!sample.content);
  }

  // ============ NEW: Capture incoming messages to database ============
  // This ensures every message through gateway is captured, not just on /new
  // Messages can be in: event.messages (array), event.message, or event.context.userMessage
  let messagesToCapture = [];

  // ============ Capture messages from session file ============
  // At bootstrap time, the incoming message isn't in the event yet
  // But we can read the session file which contains previous messages

  // Construct session file path from sessionKey
  // Session files are stored at ~/.openclaw/agents/main/sessions/<sessionKey>.jsonl
  const agentId = event.context?.agentId || 'main';
  const sessionFile = path.join(os.homedir(), '.openclaw', 'agents', agentId, 'sessions', `${sessionKey}.jsonl`);
  console.log('[openclaw-mem] Constructed session file path:', sessionFile);

  // Check if session file exists
  let sessionFileExists = false;
  try {
    await fs.access(sessionFile);
    sessionFileExists = true;
  } catch {
    sessionFileExists = false;
  }

  if (sessionFileExists) {
    console.log('[openclaw-mem] Found session file:', sessionFile);
    try {
      const messages = await extractSessionContent(sessionFile, 50);
      if (messages && messages.length > 0) {
        console.log(`[openclaw-mem] Found ${messages.length} messages in session file`);

        // Get or create session for this sessionKey
        let dbSessionId = getOrCreateSessionForKey(sessionKey, workspaceDir);

        // Track which messages we've already saved (to avoid duplicates)
        const savedHashes = new Set();
        try {
          const existing = database.getRecentObservations(null, 100);
          for (const obs of existing) {
            // Content is stored in the 'result' field as JSON
            try {
              const result = JSON.parse(obs.result || '{}');
              if (result.content) {
                savedHashes.add(hashContent(result.content));
              }
            } catch {
              // If result isn't JSON, use summary
              if (obs.summary) {
                savedHashes.add(hashContent(obs.summary));
              }
            }
          }
          console.log(`[openclaw-mem] Loaded ${savedHashes.size} existing message hashes`);
        } catch (e) {
          console.log('[openclaw-mem] Could not check existing observations:', e.message);
        }

        let newCount = 0;
        for (const msg of messages) {
          const contentHash = hashContent(msg.content);
          if (savedHashes.has(contentHash)) {
            continue; // Skip already saved messages
          }

          const toolName = msg.role === 'assistant' ? 'AssistantMessage' : 'UserMessage';
          const summary = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
          database.saveObservation(
            dbSessionId,
            toolName,
            { role: msg.role, sessionKey },
            { content: msg.content },
            {
              summary,
              // Use full message text so FTS can index real topics
              concepts: msg.content,
              tokensDiscovery: estimateTokens(msg.content),
              tokensRead: estimateTokens(summary)
            }
          );
          savedHashes.add(contentHash);
          newCount++;
        }

        if (newCount > 0) {
          console.log(`[openclaw-mem] ✓ Saved ${newCount} new messages to database`);
        } else {
          console.log('[openclaw-mem] All messages already in database');
        }
      }
    } catch (err) {
      console.log('[openclaw-mem] Could not read session file:', err.message);
    }
  } else {
    console.log('[openclaw-mem] No session file found in context');
  }
  // ============ END: Capture messages ============

  // Ensure API server is running
  await startApiServer();

  // Build context to inject (async for LLM extraction)
  const memContext = await contextBuilder.buildContext(workspaceDir, {
    observationLimit: 30,
    fullDetailCount: 3,
    useLLMExtraction: USE_LLM_EXTRACTION
  });

  // Build tool instructions for memory retrieval
  const toolInstructions = `
---

## 🧠 记忆检索工具（重要：必须使用）

**⚠️ 当用户问到以下情况时，你必须先调用脚本获取详情，再回答：**
- "具体内容是什么"、"详细步骤"、"完整版"
- "之前说过的 XXX 具体是什么"
- 上面的摘要只有标题，用户想要完整内容
- 任何需要超出摘要范围的细节

### 使用方法（使用脚本，自动处理中文编码）

**1. 搜索记忆（找到相关 ID）**
\`\`\`bash
~/.openclaw/hooks/openclaw-mem/mem-search.sh "关键词" 10
\`\`\`

**2. 获取完整详情（用找到的 ID）**
\`\`\`bash
~/.openclaw/hooks/openclaw-mem/mem-get.sh ID1 ID2
\`\`\`

### 示例

用户问："之前讨论的效率提升方法具体有哪些步骤？"

你应该：
1. 搜索: \`~/.openclaw/hooks/openclaw-mem/mem-search.sh "效率提升" 10\`
2. 获取详情: \`~/.openclaw/hooks/openclaw-mem/mem-get.sh 535 526\`（用搜索到的 ID）
3. 根据返回的完整内容回答用户

**不要仅凭摘要回答需要详情的问题！**
`;

  if (memContext) {
    console.log(`[openclaw-mem] Built context: ${memContext.length} chars`);

    // Strategy: Write memory context to a dedicated file on disk
    // This ensures AI can read it with the Read tool
    const memContextFile = path.join(workspaceDir, 'SESSION-MEMORY.md');
    try {
      await fs.writeFile(memContextFile, memContext + toolInstructions, 'utf-8');
      console.log(`[openclaw-mem] ✓ Written SESSION-MEMORY.md to disk (${memContext.length} chars + tool instructions)`);
    } catch (err) {
      console.error('[openclaw-mem] Failed to write SESSION-MEMORY.md:', err.message);
    }

    // Also modify bootstrapFiles array for system prompt injection
    if (event.context.bootstrapFiles && Array.isArray(event.context.bootstrapFiles)) {
      const memoryFile = event.context.bootstrapFiles.find(f => f.name === 'MEMORY.md');
      if (memoryFile && memoryFile.content && !memoryFile.missing) {
        memoryFile.content = memoryFile.content + '\n\n---\n\n# Session Memory\n\nSee SESSION-MEMORY.md for recent activity and conversation history.\n\n' + memContext + toolInstructions;
        console.log('[openclaw-mem] ✓ Appended to MEMORY.md in bootstrapFiles');
      }
    }
  } else {
    console.log('[openclaw-mem] No context to inject (empty memory)');
    // Still write tool instructions even if no context
    const memContextFile = path.join(workspaceDir, 'SESSION-MEMORY.md');
    try {
      await fs.writeFile(memContextFile, '# Session Memory\n\nNo recent observations found.\n' + toolInstructions, 'utf-8');
      console.log('[openclaw-mem] ✓ Written SESSION-MEMORY.md with tool instructions only');
    } catch (err) {
      console.error('[openclaw-mem] Failed to write SESSION-MEMORY.md:', err.message);
    }
  }
}

// Track active sessions by sessionKey
const activeSessions = new Map();

/**
 * Get or create a session ID for a given sessionKey
 */
function getOrCreateSessionForKey(sessionKey, workspaceDir) {
  if (activeSessions.has(sessionKey)) {
    return activeSessions.get(sessionKey);
  }

  const sessionId = generateId();
  database.createSession(sessionId, workspaceDir, sessionKey, 'bootstrap');
  activeSessions.set(sessionKey, sessionId);

  // Clean up old sessions after 1 hour
  setTimeout(() => {
    if (activeSessions.get(sessionKey) === sessionId) {
      activeSessions.delete(sessionKey);
      database.endSession(sessionId);
    }
  }, 60 * 60 * 1000);

  console.log(`[openclaw-mem] Created new session ${sessionId} for key ${sessionKey}`);
  return sessionId;
}

/**
 * Handle command:new event
 * Save session content before reset
 */
async function handleCommandNew(event) {
  console.log('[openclaw-mem] Command new - saving session');

  if (!await loadModules()) return;

  const context = event.context || {};
  const sessionKey = event.sessionKey || 'unknown';
  const sessionId = generateId();

  // Get workspace and session info
  const workspaceDir = context.workspaceDir ||
                       context.cfg?.agents?.defaults?.workspace ||
                       path.join(os.homedir(), '.openclaw', 'workspace');

  const sessionEntry = context.previousSessionEntry || context.sessionEntry || {};
  const sessionFile = sessionEntry.sessionFile;

  // Create session record
  database.createSession(sessionId, workspaceDir, sessionKey, context.commandSource || 'command');

  // Extract session content
  const messages = await extractSessionContent(sessionFile, 20);

  if (messages && messages.length > 0) {
    console.log(`[openclaw-mem] Extracted ${messages.length} messages from session`);

    // Save each message as an observation
    for (const msg of messages) {
      const toolName = msg.role === 'user' ? 'UserMessage' : 'AssistantMessage';
      const summary = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');

      database.saveObservation(
        sessionId,
        toolName,
        { role: msg.role },
        { content: msg.content },
        {
          summary,
          // Use message body for concepts to keep topic search working
          concepts: msg.content,
          tokensDiscovery: estimateTokens(msg.content),
          tokensRead: estimateTokens(summary)
        }
      );
    }

    console.log('[openclaw-mem] Session saved successfully');
    console.log('[openclaw-mem] >>> CODE VERSION 2026-02-03-1622 <<<');
    console.log('[openclaw-mem] >>> STARTING AI SUMMARY <<<');

    // Generate AI summary using DeepSeek
    let aiSummary = null;
    try {
      aiSummary = await summarizeSession(messages, { sessionKey });
      console.log('[openclaw-mem] Kimi summary result:', aiSummary ? 'success' : 'null');
    } catch (err) {
      console.error('[openclaw-mem] Kimi summary error:', err.message);
    }

    if (aiSummary && (aiSummary.request || aiSummary.learned || aiSummary.completed || aiSummary.next_steps)) {
      const summaryContent = JSON.stringify(aiSummary);
      database.saveSummary(
        sessionId,
        summaryContent,
        aiSummary.request,
        aiSummary.learned,
        aiSummary.completed,
        aiSummary.next_steps
      );
      console.log('[openclaw-mem] ✓ AI summary saved');
    } else {
      // Fallback summary
      const userMessages = messages.filter(m => m.role === 'user');
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      const fallbackRequest = userMessages[0]?.content?.slice(0, 200) || 'Session started';
      const fallbackCompleted = assistantMessages.slice(-1)[0]?.content?.slice(0, 200) || '';

      database.saveSummary(
        sessionId,
        `Session with ${messages.length} messages`,
        fallbackRequest,
        null,
        fallbackCompleted ? `Discussed: ${fallbackCompleted}` : null,
        null
      );
      console.log('[openclaw-mem] ✓ Fallback summary saved');
    }
  }

  // End session
  database.endSession(sessionId);
}

/**
 * Handle agent:response event
 * Capture assistant responses to database
 */
async function handleAgentResponse(event) {
  console.log('[openclaw-mem] Agent response event');

  if (!await loadModules()) return;

  const sessionKey = event.sessionKey || 'unknown';
  const response = event.response || event.message || event.content;
  const workspaceDir = event.context?.workspaceDir || path.join(os.homedir(), '.openclaw', 'workspace');

  if (response && typeof response === 'string' && response.trim()) {
    console.log('[openclaw-mem] Capturing assistant response:', response.slice(0, 50) + '...');

    let sessionId = getOrCreateSessionForKey(sessionKey, workspaceDir);

    const summary = response.slice(0, 100) + (response.length > 100 ? '...' : '');
    database.saveObservation(
      sessionId,
      'AssistantMessage',
      { role: 'assistant', sessionKey },
      { content: response },
      {
        summary,
        // Keep full content in concepts column for better topic recall
        concepts: response,
        tokensDiscovery: estimateTokens(response),
        tokensRead: estimateTokens(summary)
      }
    );
    console.log('[openclaw-mem] ✓ Assistant response saved to database');
  }
}

/**
 * Handle message events
 * Alternative event type for capturing messages
 */
async function handleMessage(event) {
  console.log('[openclaw-mem] Message event:', event.action || 'unknown');

  if (!await loadModules()) return;

  const sessionKey = event.sessionKey || 'unknown';
  const message = event.message || event.content || event.text;
  const role = event.role || event.action || 'user';
  const workspaceDir = event.context?.workspaceDir || path.join(os.homedir(), '.openclaw', 'workspace');

  if (message && typeof message === 'string' && message.trim() && !message.startsWith('/')) {
    console.log(`[openclaw-mem] Capturing ${role} message:`, message.slice(0, 50) + '...');

    let sessionId = getOrCreateSessionForKey(sessionKey, workspaceDir);

    const toolName = role === 'assistant' ? 'AssistantMessage' : 'UserMessage';
    const summary = message.slice(0, 100) + (message.length > 100 ? '...' : '');
    database.saveObservation(
      sessionId,
      toolName,
      { role, sessionKey },
      { content: message },
      {
        summary,
        // Index actual message text (not just role) for topic search
        concepts: message,
        tokensDiscovery: estimateTokens(message),
        tokensRead: estimateTokens(summary)
      }
    );
    console.log(`[openclaw-mem] ✓ ${role} message saved to database`);
  }
}

/**
 * Check if content should be excluded from memory (privacy protection)
 */
function shouldExclude(content) {
  if (!content || typeof content !== 'string') return false;

  // <private> tag exclusion
  if (content.includes('<private>') || content.includes('</private>')) return true;

  // Sensitive file patterns
  const sensitivePatterns = [
    '.env',
    'credentials',
    'secret',
    'password',
    'api_key',
    'apikey',
    'api-key',
    'private_key',
    'privatekey',
    'access_token',
    'accesstoken',
    'auth_token',
    'authtoken'
  ];

  const lowerContent = content.toLowerCase();
  for (const pattern of sensitivePatterns) {
    if (lowerContent.includes(pattern)) return true;
  }

  return false;
}

/**
 * Extract files read from tool call
 */
function extractFilesRead(toolName, toolInput) {
  if (!toolInput) return [];

  switch (toolName) {
    case 'Read':
      return toolInput.file_path ? [toolInput.file_path] : [];
    case 'Grep':
      return toolInput.path ? [toolInput.path] : [];
    case 'Glob':
      // Glob returns matched files, but input doesn't contain them
      return [];
    default:
      return [];
  }
}

/**
 * Extract files modified from tool call
 */
function extractFilesModified(toolName, toolInput) {
  if (!toolInput) return [];

  switch (toolName) {
    case 'Edit':
      return toolInput.file_path ? [toolInput.file_path] : [];
    case 'Write':
      return toolInput.file_path ? [toolInput.file_path] : [];
    case 'NotebookEdit':
      return toolInput.notebook_path ? [toolInput.notebook_path] : [];
    default:
      return [];
  }
}

/**
 * Classify tool call type
 */
function classifyToolType(toolName, toolInput, toolResponse) {
  // File modification tools
  if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
    return 'modification';
  }

  // File reading tools
  if (['Read', 'Grep', 'Glob'].includes(toolName)) {
    return 'discovery';
  }

  // Command execution
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';
    if (command.includes('git commit') || command.includes('git push')) {
      return 'commit';
    }
    if (command.includes('npm test') || command.includes('pytest') || command.includes('jest')) {
      return 'testing';
    }
    if (command.includes('npm install') || command.includes('pip install')) {
      return 'setup';
    }
    return 'command';
  }

  // Web tools
  if (['WebFetch', 'WebSearch'].includes(toolName)) {
    return 'research';
  }

  // Task/Agent tools
  if (toolName === 'Task') {
    return 'delegation';
  }

  return 'other';
}

/**
 * Handle tool:post event
 * Records every tool call for memory tracking
 */
async function handleToolPost(event) {
  console.log('[openclaw-mem] Tool post event');

  if (!await loadModules()) return;

  const toolName = event.tool_name || event.toolName || 'Unknown';
  const toolInput = event.tool_input || event.toolInput || event.input || {};
  const toolResponse = event.tool_response || event.toolResponse || event.response || event.output || {};
  const sessionKey = event.sessionKey || 'unknown';
  const workspaceDir = event.context?.workspaceDir || path.join(os.homedir(), '.openclaw', 'workspace');

  // Skip certain tools that generate noise
  const skipTools = ['AskUserQuestion', 'TaskList', 'TaskGet'];
  if (skipTools.includes(toolName)) {
    console.log(`[openclaw-mem] Skipping ${toolName} (noise filter)`);
    return;
  }

  // Privacy check - skip sensitive content
  const inputStr = JSON.stringify(toolInput);
  const responseStr = JSON.stringify(toolResponse);
  if (shouldExclude(inputStr) || shouldExclude(responseStr)) {
    console.log(`[openclaw-mem] Skipping ${toolName} (privacy filter)`);
    return;
  }

  // Extract metadata
  const filesRead = extractFilesRead(toolName, toolInput);
  const filesModified = extractFilesModified(toolName, toolInput);
  const toolType = classifyToolType(toolName, toolInput, toolResponse);

  // Build summary
  let summary = '';
  if (toolInput.file_path) {
    summary = `${toolName}: ${toolInput.file_path}`;
  } else if (toolInput.command) {
    summary = `${toolName}: ${toolInput.command.slice(0, 80)}`;
  } else if (toolInput.pattern) {
    summary = `${toolName}: ${toolInput.pattern}`;
  } else if (toolInput.query) {
    summary = `${toolName}: ${toolInput.query.slice(0, 80)}`;
  } else if (toolInput.url) {
    summary = `${toolName}: ${toolInput.url}`;
  } else {
    summary = `${toolName} operation`;
  }

  // Build basic narrative (fallback)
  let narrative = '';
  if (filesModified.length > 0) {
    narrative = `Modified ${filesModified.join(', ')}`;
  } else if (filesRead.length > 0) {
    narrative = `Read ${filesRead.join(', ')}`;
  } else if (toolInput.command) {
    narrative = `Executed command: ${toolInput.command.slice(0, 100)}`;
  } else if (toolInput.query) {
    narrative = `Searched for: ${toolInput.query}`;
  }

  // Get or create session
  let sessionId = getOrCreateSessionForKey(sessionKey, workspaceDir);

  // Try LLM extraction for richer metadata
  let extractedType = toolType;
  let extractedNarrative = narrative;
  let extractedFacts = null;
  let extractedConcepts = `${toolName} ${summary}`.slice(0, 500);

  if (USE_LLM_EXTRACTION && extractor && extractor.extractFromToolCall) {
    try {
      const extracted = await extractor.extractFromToolCall({
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        filesRead,
        filesModified
      });

      if (extracted) {
        extractedType = extracted.type || toolType;
        extractedNarrative = extracted.narrative || narrative;
        extractedFacts = extracted.facts;
        extractedConcepts = extracted.concepts?.join(', ') || extractedConcepts;
      }
      console.log(`[openclaw-mem] LLM extracted: type=${extractedType}, concepts=${extractedConcepts.slice(0, 50)}...`);
    } catch (err) {
      console.log(`[openclaw-mem] LLM extraction failed, using fallback: ${err.message}`);
    }
  }

  // Save observation with extended metadata
  database.saveObservation(
    sessionId,
    toolName,
    toolInput,
    toolResponse,
    {
      summary: summary.slice(0, 200),
      concepts: extractedConcepts,
      tokensDiscovery: estimateTokens(responseStr),
      tokensRead: estimateTokens(summary),
      type: extractedType,
      narrative: extractedNarrative.slice(0, 500),
      facts: extractedFacts,
      filesRead: filesRead,
      filesModified: filesModified
    }
  );

  console.log(`[openclaw-mem] ✓ Tool ${toolName} recorded (type: ${extractedType})`);
}

/**
 * Handle user:prompt:submit event (UserPromptSubmit)
 * Records user prompts to user_prompts table
 */
async function handleUserPromptSubmit(event) {
  console.log('[openclaw-mem] User prompt submit event');

  if (!await loadModules()) return;

  const sessionKey = event.sessionKey || 'unknown';
  const workspaceDir = event.context?.workspaceDir || path.join(os.homedir(), '.openclaw', 'workspace');

  // Extract user prompt from various possible locations in event
  const prompt = event.prompt || event.content || event.message || event.text || event.input;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    console.log('[openclaw-mem] No prompt content found in event');
    return;
  }

  // Skip slash commands
  if (prompt.trim().startsWith('/')) {
    console.log('[openclaw-mem] Skipping slash command');
    return;
  }

  // Privacy check
  if (shouldExclude(prompt)) {
    console.log('[openclaw-mem] Skipping prompt (privacy filter)');
    return;
  }

  // Get or create session
  const sessionId = getOrCreateSessionForKey(sessionKey, workspaceDir);

  // Save to user_prompts table
  database.saveUserPrompt(sessionId, prompt);
  console.log(`[openclaw-mem] ✓ User prompt saved (${prompt.slice(0, 50)}...)`);

  // Also save as an observation for searchability
  const summary = prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '');

  // Try LLM extraction for concepts
  let concepts = prompt;
  if (USE_LLM_EXTRACTION && extractor && extractor.extractConcepts) {
    try {
      const extracted = await extractor.extractConcepts(prompt);
      if (extracted && extracted.length > 0) {
        concepts = extracted.join(', ');
      }
    } catch (err) {
      console.log('[openclaw-mem] LLM extraction failed for prompt:', err.message);
    }
  }

  database.saveObservation(
    sessionId,
    'UserPrompt',
    { prompt: prompt.slice(0, 500) },
    { recorded: true },
    {
      summary,
      concepts,
      tokensDiscovery: estimateTokens(prompt),
      tokensRead: estimateTokens(summary),
      type: 'user_input',
      narrative: `User asked: ${summary}`,
      facts: null,
      filesRead: null,
      filesModified: null
    }
  );
  console.log('[openclaw-mem] ✓ User prompt observation saved');
}

/**
 * Handle agent:stop event (Stop)
 * Called when the model stops/completes a turn
 */
async function handleAgentStop(event) {
  console.log('[openclaw-mem] Agent stop event');

  if (!await loadModules()) return;

  const sessionKey = event.sessionKey || 'unknown';
  const workspaceDir = event.context?.workspaceDir || path.join(os.homedir(), '.openclaw', 'workspace');
  const stopReason = event.reason || event.stop_reason || 'unknown';

  // Get session
  const sessionId = getOrCreateSessionForKey(sessionKey, workspaceDir);

  // Record the stop event as an observation
  const summary = `Agent stopped: ${stopReason}`;
  database.saveObservation(
    sessionId,
    'AgentStop',
    { reason: stopReason, sessionKey },
    { stopped: true, timestamp: new Date().toISOString() },
    {
      summary,
      concepts: `stop, ${stopReason}`,
      tokensDiscovery: 10,
      tokensRead: 5,
      type: 'lifecycle',
      narrative: `Agent turn completed with reason: ${stopReason}`,
      facts: null,
      filesRead: null,
      filesModified: null
    }
  );

  console.log(`[openclaw-mem] ✓ Agent stop recorded (reason: ${stopReason})`);

  // Generate summary on stop (Claude-Mem parity)
  try {
    const existing = database.getSummaryBySession(sessionId);
    if (existing) {
      console.log('[openclaw-mem] Summary already exists for session, skipping stop summary');
      return;
    }

    const agentId = event.context?.agentId || 'main';
    const sessionFile = path.join(os.homedir(), '.openclaw', 'agents', agentId, 'sessions', `${sessionKey}.jsonl`);
    let sessionFileExists = false;
    try {
      await fs.access(sessionFile);
      sessionFileExists = true;
    } catch {
      sessionFileExists = false;
    }

    if (!sessionFileExists) {
      console.log('[openclaw-mem] No session file found for stop summary');
      return;
    }

    const messages = await extractSessionContent(sessionFile, SUMMARY_MAX_MESSAGES);
    if (!messages || messages.length === 0) {
      console.log('[openclaw-mem] No messages found for stop summary');
      return;
    }

    let summary = null;
    try {
      summary = await summarizeSession(messages, { sessionKey });
    } catch {
      summary = null;
    }

    if (summary && (summary.request || summary.learned || summary.completed || summary.next_steps)) {
      const summaryContent = JSON.stringify(summary);
      database.saveSummary(
        sessionId,
        summaryContent,
        summary.request,
        summary.learned,
        summary.completed,
        summary.next_steps
      );
      console.log('[openclaw-mem] ✓ Stop summary saved');
    } else {
      // Fallback summary if LLM failed
      const userMessages = messages.filter(m => m.role === 'user');
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      const summaryContent = `Session with ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant)`;
      const firstUserMsg = userMessages[0]?.content?.slice(0, 200) || '';
      const lastAssistant = assistantMessages.slice(-1)[0]?.content?.slice(0, 100) || 'various topics';

      database.saveSummary(
        sessionId,
        summaryContent,
        firstUserMsg,
        '',
        `Discussed: ${lastAssistant}`,
        null
      );
      console.log('[openclaw-mem] ✓ Stop summary saved (fallback)');
    }
  } catch (err) {
    console.error('[openclaw-mem] Stop summary error:', err.message);
  }

  // If this is an end_turn or max_tokens stop, we might want to
  // trigger a summary generation for the turn
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    console.log('[openclaw-mem] Turn completed normally');
  } else if (stopReason === 'max_tokens') {
    console.log('[openclaw-mem] Turn stopped due to max tokens');
  }
}

/**
 * Main hook handler
 */
const openclawMemHandler = async (event) => {
  const eventType = event.type;
  const eventAction = event.action;
  const eventSessionKey = event.sessionKey;

  if (isInternalSessionKey(eventSessionKey)) {
    console.log('[openclaw-mem] Skipping internal session:', eventSessionKey);
    return;
  }

  console.log('[openclaw-mem] Event:', eventType, eventAction || '', '(v2026-02-03-1629)');

  try {
    if (eventType === 'gateway' && eventAction === 'startup') {
      await handleGatewayStartup(event);
      return;
    }

    if (eventType === 'agent' && eventAction === 'bootstrap') {
      await handleAgentBootstrap(event);
      return;
    }

    if (eventType === 'command' && eventAction === 'new') {
      await handleCommandNew(event);
      return;
    }

    // Handle agent response to capture assistant messages
    if (eventType === 'agent' && eventAction === 'response') {
      await handleAgentResponse(event);
      return;
    }

    // Handle tool:post events to capture tool calls
    if (eventType === 'tool' && eventAction === 'post') {
      await handleToolPost(event);
      return;
    }

    // Handle user:prompt:submit (UserPromptSubmit) - when user submits a prompt
    if ((eventType === 'user' && eventAction === 'prompt') ||
        (eventType === 'prompt' && eventAction === 'submit') ||
        (eventType === 'user' && eventAction === 'submit')) {
      await handleUserPromptSubmit(event);
      return;
    }

    // Handle agent:stop (Stop) - when model stops/completes a turn
    if (eventType === 'agent' && eventAction === 'stop') {
      await handleAgentStop(event);
      return;
    }

    // Handle message events (alternative event type)
    if (eventType === 'message') {
      await handleMessage(event);
      return;
    }

  } catch (err) {
    console.error('[openclaw-mem] Handler error:', err.message);
    console.error(err.stack);
  }
};

export default openclawMemHandler;
