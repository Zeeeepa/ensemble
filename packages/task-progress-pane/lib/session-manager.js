/**
 * Session manager for multi-session task tracking
 *
 * Manages multiple concurrent task sessions using tool_use_id as session identifier.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.ai-mesh-task-progress');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

/**
 * Session manager class
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.activeSessionIndex = 0;
    this.paneId = null;
    this.signalFile = null;
    this.initialized = false;
  }

  /**
   * Initialize the session manager
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) return;

    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await this.loadState();
    } catch (error) {
      console.error('[session-manager] Init error:', error.message);
    }

    this.initialized = true;
  }

  /**
   * Create or update a session
   * @param {string} toolUseId - From hook input (used as session ID)
   * @param {Object} data - Session data
   * @returns {Object} Session object
   */
  upsertSession(toolUseId, data) {
    const sessionId = this.deriveSessionId(toolUseId);

    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        toolUseId,
        agentType: data.agentType || 'unknown',
        startedAt: new Date().toISOString(),
        tasks: [],
        progress: {
          completed: 0,
          inProgress: 0,
          pending: 0,
          failed: 0,
          total: 0,
          percentage: 0,
          totalElapsedMs: 0
        },
        currentTask: null,
        uiState: {
          scrollPosition: 0,
          cursorPosition: 0,
          expandedTasks: [],
          collapsedSections: [],
          searchQuery: null,
          searchMatches: []
        }
      };
    }

    // Update session with new data
    if (data.tasks !== undefined) {
      session.tasks = data.tasks;
    }
    if (data.progress !== undefined) {
      session.progress = data.progress;
    }
    if (data.currentTask !== undefined) {
      session.currentTask = data.currentTask;
    }
    if (data.agentType !== undefined) {
      session.agentType = data.agentType;
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Derive a short session ID from tool_use_id
   * @param {string} toolUseId - Full tool_use_id
   * @returns {string} Short session ID
   */
  deriveSessionId(toolUseId) {
    if (!toolUseId) {
      return `session-${Date.now()}`;
    }

    // Extract last segment or use hash
    if (toolUseId.includes('_')) {
      const parts = toolUseId.split('_');
      return parts[parts.length - 1].substring(0, 12);
    }

    return toolUseId.substring(0, 12);
  }

  /**
   * Get session by tool_use_id
   * @param {string} toolUseId - Session identifier
   * @returns {Object|null} Session or null
   */
  getSession(toolUseId) {
    const sessionId = this.deriveSessionId(toolUseId);
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get session by session ID
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session or null
   */
  getSessionById(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get all active sessions
   * @returns {Array} Array of sessions
   */
  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Remove a session
   * @param {string} toolUseId - Session identifier
   * @returns {boolean} True if removed
   */
  removeSession(toolUseId) {
    const sessionId = this.deriveSessionId(toolUseId);
    return this.sessions.delete(sessionId);
  }

  /**
   * Remove empty sessions (no tasks)
   * @returns {number} Number of sessions removed
   */
  cleanupEmpty() {
    let removed = 0;
    for (const [sessionId, session] of this.sessions) {
      if (!session.tasks || session.tasks.length === 0) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Check if any sessions have tasks
   * @returns {boolean} True if any session has tasks
   */
  hasTasks() {
    for (const session of this.sessions.values()) {
      if (session.tasks && session.tasks.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get total task count across all sessions
   * @returns {number} Total tasks
   */
  getTotalTaskCount() {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.tasks ? session.tasks.length : 0;
    }
    return total;
  }

  /**
   * Get the currently focused session
   * @returns {Object|null} Active session or null
   */
  getActiveSession() {
    const sessions = this.getAllSessions();
    if (sessions.length === 0) return null;

    const index = Math.min(this.activeSessionIndex, sessions.length - 1);
    return sessions[index] || null;
  }

  /**
   * Set the active session by index
   * @param {number} index - Session index
   */
  setActiveSessionIndex(index) {
    const sessions = this.getAllSessions();
    if (index >= 0 && index < sessions.length) {
      this.activeSessionIndex = index;
    }
  }

  /**
   * Move to next session
   * @returns {Object|null} New active session
   */
  nextSession() {
    const sessions = this.getAllSessions();
    if (sessions.length <= 1) return this.getActiveSession();

    this.activeSessionIndex = (this.activeSessionIndex + 1) % sessions.length;
    return this.getActiveSession();
  }

  /**
   * Move to previous session
   * @returns {Object|null} New active session
   */
  prevSession() {
    const sessions = this.getAllSessions();
    if (sessions.length <= 1) return this.getActiveSession();

    this.activeSessionIndex = (this.activeSessionIndex - 1 + sessions.length) % sessions.length;
    return this.getActiveSession();
  }

  /**
   * Set pane information
   * @param {string} paneId - Pane ID
   * @param {string} signalFile - Signal file path
   */
  setPaneInfo(paneId, signalFile) {
    this.paneId = paneId;
    this.signalFile = signalFile;
  }

  /**
   * Load state from disk
   * @returns {Promise<void>}
   */
  async loadState() {
    try {
      const content = await fs.readFile(STATE_PATH, 'utf-8');
      const data = JSON.parse(content);

      if (data.sessions && Array.isArray(data.sessions)) {
        this.sessions.clear();
        for (const session of data.sessions) {
          this.sessions.set(session.sessionId, session);
        }
      }

      if (typeof data.activeSessionIndex === 'number') {
        this.activeSessionIndex = data.activeSessionIndex;
      }

      if (data.paneId) {
        this.paneId = data.paneId;
      }

      if (data.signalFile) {
        this.signalFile = data.signalFile;
      }
    } catch (error) {
      // State file may not exist yet
      if (error.code !== 'ENOENT') {
        console.error('[session-manager] Load state error:', error.message);
      }
    }
  }

  /**
   * Save state to disk
   * @returns {Promise<void>}
   */
  async saveState() {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });

      const data = {
        sessions: this.getAllSessions(),
        activeSessionIndex: this.activeSessionIndex,
        paneId: this.paneId,
        signalFile: this.signalFile,
        lastUpdated: new Date().toISOString()
      };

      await fs.writeFile(STATE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('[session-manager] Save state error:', error.message);
    }
  }

  /**
   * Get the state file path
   * @returns {string} Path to state file
   */
  getStatePath() {
    return STATE_PATH;
  }

  /**
   * Clear all sessions
   */
  clear() {
    this.sessions.clear();
    this.activeSessionIndex = 0;
    this.paneId = null;
    this.signalFile = null;
  }
}

module.exports = { SessionManager, STATE_DIR, STATE_PATH };
