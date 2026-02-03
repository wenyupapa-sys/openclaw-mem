/**
 * Gateway LLM Module Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeSession, callGatewayChat, INTERNAL_SUMMARY_PREFIX } from './gateway-llm.js';

describe('gateway-llm', () => {
  describe('INTERNAL_SUMMARY_PREFIX', () => {
    it('should be defined', () => {
      expect(INTERNAL_SUMMARY_PREFIX).toBe('mem-summary:');
    });
  });

  describe('summarizeSession', () => {
    it('should return null for empty messages', async () => {
      const result = await summarizeSession([]);
      expect(result).toBeNull();
    });

    it('should return null for messages with no content', async () => {
      const result = await summarizeSession([
        { role: 'user', content: '' },
        { role: 'assistant', content: '' }
      ]);
      expect(result).toBeNull();
    });

    it('should handle messages without API key', async () => {
      // Without KIMI_CODE_API_KEY set, should return null
      const originalKey = process.env.KIMI_CODE_API_KEY;
      delete process.env.KIMI_CODE_API_KEY;
      delete process.env.KIMI_API_KEY;

      const result = await summarizeSession([
        { role: 'user', content: 'Test message' },
        { role: 'assistant', content: 'Test response' }
      ]);

      // Restore original key if it existed
      if (originalKey) {
        process.env.KIMI_CODE_API_KEY = originalKey;
      }

      expect(result).toBeNull();
    });
  });

  describe('callGatewayChat', () => {
    it('should return null without API key', async () => {
      const originalKey = process.env.KIMI_CODE_API_KEY;
      delete process.env.KIMI_CODE_API_KEY;
      delete process.env.KIMI_API_KEY;

      const result = await callGatewayChat([
        { role: 'user', content: 'test' }
      ]);

      if (originalKey) {
        process.env.KIMI_CODE_API_KEY = originalKey;
      }

      expect(result).toBeNull();
    });
  });
});

describe('gateway-llm integration', () => {
  const hasApiKey = !!(process.env.KIMI_CODE_API_KEY || process.env.KIMI_API_KEY);

  it.skipIf(!hasApiKey)('should summarize a simple session', async () => {
    const messages = [
      { role: 'user', content: 'Please help me fix a bug in my code' },
      { role: 'assistant', content: 'I found the issue. The variable was undefined because of a typo.' },
      { role: 'user', content: 'Thanks! It works now.' }
    ];

    const result = await summarizeSession(messages, { sessionKey: 'test-integration' });

    expect(result).toBeDefined();
    expect(result).toHaveProperty('request');
    expect(result).toHaveProperty('learned');
    expect(result).toHaveProperty('completed');
    expect(result).toHaveProperty('next_steps');
  }, 30000); // 30s timeout for API call
});
