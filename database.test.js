/**
 * Database Module Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { database } from './database.js';

describe('database', () => {
  const testSessionId = `test-session-${Date.now()}`;
  const testSessionKey = `test-key-${Date.now()}`;
  let createdObservationId;

  describe('session operations', () => {
    it('should create a new session', () => {
      const result = database.createSession(
        testSessionId,
        '/test/project/path',
        testSessionKey,
        'test'
      );
      expect(result.success).toBe(true);
      expect(result.id).toBe(testSessionId);
    });

    it('should retrieve the created session', () => {
      const session = database.getSession(testSessionId);
      expect(session).toBeDefined();
      expect(session.id).toBe(testSessionId);
      expect(session.project_path).toBe('/test/project/path');
      expect(session.session_key).toBe(testSessionKey);
      expect(session.status).toBe('active');
    });

    it('should get active session by key', () => {
      const session = database.getActiveSession(testSessionKey);
      expect(session).toBeDefined();
      expect(session.id).toBe(testSessionId);
    });

    it('should handle duplicate session creation gracefully', () => {
      const result = database.createSession(
        testSessionId,
        '/test/project/path',
        testSessionKey,
        'test'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('UNIQUE constraint');
    });
  });

  describe('observation operations', () => {
    it('should save an observation', () => {
      const result = database.saveObservation(
        testSessionId,
        'Read',
        { file_path: '/test/file.js' },
        { content: 'test content' },
        {
          summary: 'Test observation summary',
          concepts: 'testing, database, vitest',
          tokensDiscovery: 100,
          tokensRead: 50,
          type: 'discovery',
          narrative: 'Test narrative for observation'
        }
      );
      expect(result.success).toBe(true);
      expect(typeof result.id).toBe('number');
      createdObservationId = Number(result.id);
    });

    it('should retrieve the observation by id', () => {
      const obs = database.getObservation(createdObservationId);
      expect(obs).toBeDefined();
      expect(obs.tool_name).toBe('Read');
      expect(obs.summary).toBe('Test observation summary');
      expect(obs.type).toBe('discovery');
      expect(obs.tool_input).toEqual({ file_path: '/test/file.js' });
    });

    it('should retrieve multiple observations by ids', () => {
      const observations = database.getObservations([createdObservationId]);
      expect(observations).toHaveLength(1);
      expect(observations[0].id).toBe(createdObservationId);
    });

    it('should get recent observations', () => {
      const observations = database.getRecentObservations('/test/project/path', 10);
      expect(Array.isArray(observations)).toBe(true);
      const found = observations.find(o => o.id === createdObservationId);
      expect(found).toBeDefined();
    });

    it('should update observation summary', () => {
      database.updateObservationSummary(
        createdObservationId,
        'Updated summary',
        'updated, concepts',
        75
      );
      const obs = database.getObservation(createdObservationId);
      expect(obs.summary).toBe('Updated summary');
      expect(obs.concepts).toBe('updated, concepts');
      expect(obs.tokens_read).toBe(75);
    });
  });

  describe('search operations', () => {
    it('should search observations by query', () => {
      const results = database.searchObservations('Updated summary', 10);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle empty search gracefully', () => {
      const results = database.searchObservations('xyznonexistent123', 10);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });
  });

  describe('user prompt operations', () => {
    it('should save user prompt', () => {
      const result = database.saveUserPrompt(testSessionId, 'Test user prompt content');
      expect(result.success).toBe(true);
      expect(typeof result.id).toBe('number');
    });

    it('should get recent user prompts', () => {
      const prompts = database.getRecentUserPrompts(testSessionId, 5);
      expect(Array.isArray(prompts)).toBe(true);
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts[0].content).toBe('Test user prompt content');
    });
  });

  describe('summary operations', () => {
    it('should save a summary', () => {
      const result = database.saveSummary(
        testSessionId,
        'Full summary content',
        'User request',
        'What was learned',
        'What was completed',
        'Next steps'
      );
      expect(result.success).toBe(true);
    });

    it('should get summary by session', () => {
      const summary = database.getSummaryBySession(testSessionId);
      expect(summary).toBeDefined();
      expect(summary.request).toBe('User request');
      expect(summary.learned).toBe('What was learned');
      expect(summary.completed).toBe('What was completed');
      expect(summary.next_steps).toBe('Next steps');
    });

    it('should get summary by session key', () => {
      const summary = database.getSummaryBySessionKey(testSessionKey);
      expect(summary).toBeDefined();
      expect(summary.session_key).toBe(testSessionKey);
    });
  });

  describe('stats', () => {
    it('should return database stats', () => {
      const stats = database.getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.total_sessions).toBe('number');
      expect(typeof stats.total_observations).toBe('number');
      expect(typeof stats.total_summaries).toBe('number');
    });
  });

  describe('session end', () => {
    it('should end the session', () => {
      database.endSession(testSessionId);
      const session = database.getSession(testSessionId);
      expect(session.status).toBe('completed');
      expect(session.ended_at).toBeDefined();
    });
  });
});
