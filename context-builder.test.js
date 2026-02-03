/**
 * Context Builder Module Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import contextBuilder, {
  buildContext,
  searchContext,
  getObservationDetails,
  getTimeline,
  search,
  timeline,
  get_observations,
  __IMPORTANT
} from './context-builder.js';

// Mock observations for testing
const mockObservations = [
  {
    id: 1,
    session_id: 'test-session',
    timestamp: '2026-02-03T10:00:00',
    tool_name: 'Read',
    tool_input: JSON.stringify({ file_path: '/test/file.js' }),
    tool_response: JSON.stringify({ content: 'file content' }),
    summary: 'Read test file for analysis',
    concepts: 'testing, file reading',
    tokens_discovery: 100,
    tokens_read: 25,
    type: 'discovery',
    narrative: 'Test file read operation',
    project_path: '/test/project'
  },
  {
    id: 2,
    session_id: 'test-session',
    timestamp: '2026-02-03T10:05:00',
    tool_name: 'Edit',
    tool_input: JSON.stringify({ file_path: '/test/file.js', old_string: 'a', new_string: 'b' }),
    tool_response: JSON.stringify({ success: true }),
    summary: 'Modified test file',
    concepts: 'editing, refactoring',
    tokens_discovery: 80,
    tokens_read: 20,
    type: 'refactor',
    narrative: 'Refactored test file',
    project_path: '/test/project'
  }
];

describe('context-builder utility functions', () => {
  describe('search function', () => {
    it('should handle string query', () => {
      const result = search('test query');
      expect(typeof result).toBe('string');
    });

    it('should handle object args with query', () => {
      const result = search({ query: 'test', limit: 5 });
      expect(typeof result).toBe('string');
    });

    it('should handle missing query', () => {
      const result = search({});
      expect(result).toBe('No query provided.');
    });
  });

  describe('timeline function', () => {
    it('should handle numeric anchor', () => {
      const result = timeline(999999);
      expect(result).toContain('not found');
    });

    it('should handle string anchor with hash', () => {
      const result = timeline('#999999');
      expect(result).toContain('not found');
    });

    it('should handle object args', () => {
      const result = timeline({ anchor: 999999 });
      expect(result).toContain('not found');
    });

    it('should handle missing anchor', () => {
      const result = timeline({});
      // When no anchor provided, anchorId becomes NaN which is checked
      expect(result).toContain('not found');
    });
  });

  describe('get_observations function', () => {
    it('should handle array of ids', () => {
      const result = get_observations([999999]);
      expect(result).toContain('No observations found');
    });

    it('should handle object with ids', () => {
      const result = get_observations({ ids: [999999] });
      expect(result).toContain('No observations found');
    });

    it('should handle string ids with hash prefix', () => {
      const result = get_observations({ ids: '#999999' });
      expect(result).toContain('No observations found');
    });

    it('should handle missing ids', () => {
      const result = get_observations({});
      expect(result).toBe('No observation IDs provided.');
    });
  });

  describe('__IMPORTANT function', () => {
    it('should return workflow instructions', () => {
      const result = __IMPORTANT();
      expect(result).toContain('3-layer workflow');
      expect(result).toContain('search');
      expect(result).toContain('timeline');
      expect(result).toContain('get_observations');
    });
  });
});

describe('context-builder default export', () => {
  it('should export all required functions', () => {
    expect(typeof contextBuilder.buildContext).toBe('function');
    expect(typeof contextBuilder.searchContext).toBe('function');
    expect(typeof contextBuilder.getObservationDetails).toBe('function');
    expect(typeof contextBuilder.getTimeline).toBe('function');
    expect(typeof contextBuilder.search).toBe('function');
    expect(typeof contextBuilder.timeline).toBe('function');
    expect(typeof contextBuilder.get_observations).toBe('function');
    expect(typeof contextBuilder.__IMPORTANT).toBe('function');
  });
});

describe('searchContext', () => {
  it('should return formatted message for no results', () => {
    const result = searchContext('xyznonexistent999', 10);
    expect(result).toContain('No observations found');
    expect(result).toContain('xyznonexistent999');
  });
});

describe('getObservationDetails', () => {
  it('should return message for non-existent ids', () => {
    const result = getObservationDetails([999999, 999998]);
    expect(result).toContain('No observations found');
  });
});

describe('getTimeline', () => {
  it('should return not found for invalid anchor', () => {
    const result = getTimeline(999999);
    expect(result).toContain('not found');
  });
});
