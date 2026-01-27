// Claude Companion Web Client

class ClaudeCompanion {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.currentSession = null;
    this.sessions = [];
    this.config = {
      host: '',
      port: 9877,
      token: '',
      useTls: false,
    };

    this.initElements();
    this.bindEvents();
    this.checkAutoConnect();
  }

  initElements() {
    // Screens
    this.connectScreen = document.getElementById('connect-screen');
    this.sessionScreen = document.getElementById('session-screen');

    // Connect form
    this.connectForm = document.getElementById('connect-form');
    this.hostInput = document.getElementById('host');
    this.portInput = document.getElementById('port');
    this.tokenInput = document.getElementById('token');
    this.useTlsCheckbox = document.getElementById('use-tls');
    this.connectBtn = document.getElementById('connect-btn');
    this.connectError = document.getElementById('connect-error');
    this.connectStatus = document.getElementById('connect-status');

    // Session screen
    this.backBtn = document.getElementById('back-btn');
    this.sessionName = document.getElementById('session-name');
    this.connectionStatus = document.getElementById('connection-status');
    this.messagesContainer = document.getElementById('messages');
    this.waitingIndicator = document.getElementById('waiting-indicator');
    this.inputForm = document.getElementById('input-form');
    this.messageInput = document.getElementById('message-input');
    this.sendBtn = document.getElementById('send-btn');

    // Sessions modal
    this.sessionsBtn = document.getElementById('sessions-btn');
    this.sessionsModal = document.getElementById('sessions-modal');
    this.closeSessionsBtn = document.getElementById('close-sessions-btn');
    this.sessionsList = document.getElementById('sessions-list');

    // Refresh button
    this.refreshBtn = document.getElementById('refresh-btn');
  }

  bindEvents() {
    this.connectForm.addEventListener('submit', (e) => this.handleConnect(e));
    this.backBtn.addEventListener('click', () => this.disconnect());
    this.inputForm.addEventListener('submit', (e) => this.handleSendMessage(e));
    this.sessionsBtn.addEventListener('click', () => this.showSessionsModal());
    this.closeSessionsBtn.addEventListener('click', () => this.hideSessionsModal());
    this.sessionsModal.addEventListener('click', (e) => {
      if (e.target === this.sessionsModal) this.hideSessionsModal();
    });
    this.refreshBtn.addEventListener('click', () => this.refreshConversation());
  }

  checkAutoConnect() {
    // Pre-fill host/port from current URL (user is already on the server)
    // But require manual token entry for security
    this.hostInput.value = window.location.hostname;
    this.portInput.value = window.location.port || (window.location.protocol === 'https:' ? 443 : 80);
    this.useTlsCheckbox.checked = window.location.protocol === 'https:';

    // Focus on token input for quick entry
    this.tokenInput.focus();
  }

  loadSavedConfig() {
    try {
      const saved = localStorage.getItem('claude-companion-config');
      if (saved) {
        const config = JSON.parse(saved);
        this.hostInput.value = config.host || '';
        this.portInput.value = config.port || 9877;
        this.tokenInput.value = config.token || '';
        this.useTlsCheckbox.checked = config.useTls || false;
      }
    } catch (e) {
      console.error('Failed to load saved config:', e);
    }
  }

  saveConfig() {
    try {
      localStorage.setItem('claude-companion-config', JSON.stringify(this.config));
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  }

  handleConnect(e) {
    e.preventDefault();

    this.config = {
      host: this.hostInput.value.trim(),
      port: parseInt(this.portInput.value, 10),
      token: this.tokenInput.value,
      useTls: this.useTlsCheckbox.checked,
    };

    this.connect();
  }

  connect() {
    this.connectError.textContent = '';
    this.connectStatus.textContent = 'Connecting...';
    this.connectBtn.disabled = true;

    const protocol = this.config.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${this.config.host}:${this.config.port}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.connected = true;
        this.connectStatus.textContent = 'Authenticating...';
        this.authenticate();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('Received message:', message.type, message);
          this.handleMessage(message);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.authenticated = false;
        this.connectBtn.disabled = false;
        this.connectStatus.textContent = '';

        if (this.sessionScreen.classList.contains('hidden')) {
          // Still on connect screen
        } else {
          // Was viewing session
          this.updateConnectionStatus('disconnected');
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        console.log('Attempted URL was:', url);
        this.connectError.textContent = 'Connection failed. Check host and port.';
        this.connectBtn.disabled = false;
        this.connectStatus.textContent = '';
      };
    } catch (e) {
      this.connectError.textContent = 'Failed to connect: ' + e.message;
      this.connectBtn.disabled = false;
      this.connectStatus.textContent = '';
    }
  }

  authenticate() {
    this.send({
      type: 'authenticate',
      token: this.config.token,
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'connected':
        // Server acknowledged connection, now authenticate
        this.authenticate();
        break;

      case 'authenticated':
        if (message.success) {
          this.authenticated = true;
          this.connectStatus.textContent = 'Fetching sessions...';
          this.send({ type: 'get_sessions' });
        } else {
          this.connectError.textContent = message.error || 'Authentication failed';
          this.connectBtn.disabled = false;
          this.connectStatus.textContent = '';
          this.ws.close();
        }
        break;

      case 'sessions':
        this.sessions = message.payload?.sessions || [];
        console.log('Sessions received:', this.sessions);
        this.handleSessionsList();
        break;

      case 'highlights':
        console.log('Highlights received:', message.payload);
        this.hideWorkingIndicator();
        this.renderConversation(message.payload);
        break;

      case 'update':
      case 'conversation_update':
        this.handleUpdate(message.payload || message);
        break;

      case 'status_change':
        this.handleStatusChange(message.payload || message);
        break;

      case 'subscribed':
        console.log('Subscribed to session');
        break;

      case 'error':
        console.error('Server error:', message);
        break;

      default:
        console.log('Unknown message type:', message.type, message);
    }
  }

  handleSessionsList() {
    if (this.sessions.length === 0) {
      this.connectError.textContent = 'No active sessions found';
      this.connectBtn.disabled = false;
      this.connectStatus.textContent = '';
      return;
    }

    // Auto-select first session or one that's waiting
    const waitingSession = this.sessions.find(s => s.isWaiting);
    this.currentSession = waitingSession || this.sessions[0];

    this.showSessionScreen();
    this.subscribe(this.currentSession.id);
  }

  showSessionScreen() {
    this.connectScreen.classList.add('hidden');
    this.sessionScreen.classList.remove('hidden');
    this.sessionName.textContent = this.currentSession?.name || 'Session';
    this.updateConnectionStatus('connected');
    this.messageInput.focus();
  }

  showConnectScreen() {
    this.sessionScreen.classList.add('hidden');
    this.connectScreen.classList.remove('hidden');
    this.messagesContainer.innerHTML = '';
    this.connectBtn.disabled = false;
    this.connectStatus.textContent = '';
  }

  updateConnectionStatus(status) {
    this.connectionStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    this.connectionStatus.className = 'status-badge ' + status;
  }

  subscribe(sessionId) {
    this.send({
      type: 'subscribe',
      sessionId,
    });
    // Also fetch the conversation
    this.send({
      type: 'get_highlights',
      sessionId,
    });
  }

  refreshConversation() {
    if (!this.currentSession) return;
    // Visual feedback
    this.refreshBtn.classList.add('spinning');
    setTimeout(() => this.refreshBtn.classList.remove('spinning'), 500);
    // Fetch fresh highlights
    this.send({
      type: 'get_highlights',
      sessionId: this.currentSession.id,
    });
  }

  renderConversation(payload) {
    const messages = payload.highlights || payload.messages || [];
    const isWaiting = payload.isWaiting;
    this.messagesContainer.innerHTML = '';

    if (!messages || messages.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'message system';
      emptyMsg.textContent = 'No messages yet';
      this.messagesContainer.appendChild(emptyMsg);
    } else {
      messages.forEach(msg => this.renderMessage(msg));
    }

    this.updateWaitingIndicator(isWaiting);
    this.scrollToBottom();
  }

  renderMessage(msg) {
    // Support both formats: {role, text} and {type, content}
    const role = msg.role || msg.type;
    const text = msg.text || msg.content || '';

    const div = document.createElement('div');
    div.className = `message ${role}`;

    // Main content
    const content = document.createElement('div');
    content.className = 'message-content';

    if (role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Render text content first
      if (text) {
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = text;
        content.appendChild(textDiv);
      }

      // Render tool cards
      msg.toolCalls.forEach(tool => {
        const toolCard = this.createToolCard(tool);
        content.appendChild(toolCard);
      });
    } else {
      content.textContent = text;
    }

    // Render options/choices if available
    if (msg.options && msg.options.length > 0) {
      const optionsContainer = document.createElement('div');
      optionsContainer.className = 'message-options';

      msg.options.forEach(option => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        // Options can be objects with label/description or plain strings
        const optionLabel = typeof option === 'object' ? (option.label || option.text || JSON.stringify(option)) : option;
        const optionDesc = typeof option === 'object' ? option.description : null;
        btn.textContent = optionLabel;
        if (optionDesc) {
          btn.title = optionDesc;
        }
        btn.addEventListener('click', () => this.sendOption(optionLabel));
        optionsContainer.appendChild(btn);
      });

      content.appendChild(optionsContainer);
    }

    div.appendChild(content);

    // Timestamp
    if (msg.timestamp) {
      const time = document.createElement('div');
      time.className = 'message-time';
      time.textContent = this.formatTime(msg.timestamp);
      div.appendChild(time);
    }

    this.messagesContainer.appendChild(div);
  }

  createToolCard(tool) {
    const card = document.createElement('div');
    card.className = 'tool-card';

    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = this.getToolIcon(tool.name);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = tool.name;

    const status = document.createElement('span');
    status.className = `tool-status ${tool.status || 'pending'}`;
    status.textContent = tool.status || 'pending';

    const chevron = document.createElement('span');
    chevron.className = 'tool-chevron';
    chevron.textContent = '▶';

    header.appendChild(icon);
    header.appendChild(name);
    header.appendChild(status);
    header.appendChild(chevron);
    card.appendChild(header);

    // Create expandable details section
    const details = document.createElement('div');
    details.className = 'tool-details';

    if (tool.summary) {
      const summary = document.createElement('div');
      summary.className = 'tool-summary';
      summary.textContent = tool.summary;
      details.appendChild(summary);
    }

    if (tool.input) {
      const input = document.createElement('div');
      input.className = 'tool-input';
      const inputLabel = document.createElement('div');
      inputLabel.className = 'tool-label';
      inputLabel.textContent = 'Input:';
      const inputContent = document.createElement('pre');
      inputContent.className = 'tool-content';
      inputContent.textContent = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2);
      input.appendChild(inputLabel);
      input.appendChild(inputContent);
      details.appendChild(input);
    }

    if (tool.output) {
      const output = document.createElement('div');
      output.className = 'tool-output';
      const outputLabel = document.createElement('div');
      outputLabel.className = 'tool-label';
      outputLabel.textContent = 'Output:';
      const outputContent = document.createElement('pre');
      outputContent.className = 'tool-content';
      outputContent.textContent = typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2);
      output.appendChild(outputLabel);
      output.appendChild(outputContent);
      details.appendChild(output);
    }

    card.appendChild(details);

    // Click to expand/collapse
    header.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    return card;
  }

  getToolIcon(toolName) {
    const icons = {
      Read: '📄',
      Write: '✏️',
      Edit: '📝',
      Bash: '💻',
      Glob: '🔍',
      Grep: '🔎',
      Task: '📋',
      WebFetch: '🌐',
      WebSearch: '🔎',
      AskUserQuestion: '❓',
    };
    return icons[toolName] || '🔧';
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  handleUpdate(payload) {
    // Hide working indicator on any update
    this.hideWorkingIndicator();

    if (payload.newMessages) {
      payload.newMessages.forEach(msg => this.renderMessage(msg));
      this.scrollToBottom();
    }

    if (payload.isWaiting !== undefined) {
      this.updateWaitingIndicator(payload.isWaiting);
    }

    // If we get a full conversation update, refresh
    if (payload.messages || payload.highlights) {
      this.renderConversation(payload);
    }
  }

  handleStatusChange(payload) {
    // Update waiting indicator based on status change
    if (payload.isWaitingForInput !== undefined) {
      this.updateWaitingIndicator(payload.isWaitingForInput);
    }

    // If there's a new last message, we should refresh
    if (payload.lastMessage) {
      // Refresh to get the latest messages
      this.refreshConversation();
    }
  }

  updateWaitingIndicator(isWaiting) {
    if (isWaiting) {
      this.waitingIndicator.classList.remove('hidden');
      this.messageInput.placeholder = 'Claude is waiting for your input...';
      this.messageInput.focus();
    } else {
      this.waitingIndicator.classList.add('hidden');
      this.messageInput.placeholder = 'Type a message...';
    }
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  handleSendMessage(e) {
    e.preventDefault();

    const text = this.messageInput.value.trim();
    if (!text) return;

    this.sendInput(text);
  }

  sendOption(option) {
    this.sendInput(option);
    // Remove option buttons after selection
    const optionBtns = this.messagesContainer.querySelectorAll('.message-options');
    optionBtns.forEach(btn => btn.remove());
  }

  sendInput(text) {
    // Clear input
    this.messageInput.value = '';

    // Send to daemon
    this.send({
      type: 'send_input',
      payload: { input: text },
    });

    // Optimistically add user message
    this.renderMessage({
      type: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    });
    this.scrollToBottom();

    // Show working indicator
    this.showWorkingIndicator();
  }

  showWorkingIndicator() {
    this.hideWorkingIndicator();
    const indicator = document.createElement('div');
    indicator.className = 'working-indicator';
    indicator.id = 'working-indicator';
    indicator.innerHTML = '<span class="working-spinner"></span> Claude is working...';
    this.messagesContainer.appendChild(indicator);
    this.scrollToBottom();
  }

  hideWorkingIndicator() {
    const existing = document.getElementById('working-indicator');
    if (existing) existing.remove();
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
    this.showConnectScreen();
  }

  showSessionsModal() {
    this.renderSessionsList();
    this.sessionsModal.classList.remove('hidden');
  }

  hideSessionsModal() {
    this.sessionsModal.classList.add('hidden');
  }

  renderSessionsList() {
    this.sessionsList.innerHTML = '';

    this.sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = `session-item ${session.id === this.currentSession?.id ? 'active' : ''}`;

      const icon = document.createElement('span');
      icon.className = 'session-status-icon';
      icon.textContent = session.isWaiting ? '⏳' : '🟢';

      const info = document.createElement('div');
      info.className = 'session-info';

      const name = document.createElement('div');
      name.className = 'session-name';
      name.textContent = session.name;

      const path = document.createElement('div');
      path.className = 'session-path';
      path.textContent = session.path || '';

      info.appendChild(name);
      info.appendChild(path);

      item.appendChild(icon);
      item.appendChild(info);

      item.addEventListener('click', () => this.switchSession(session));

      this.sessionsList.appendChild(item);
    });
  }

  switchSession(session) {
    if (session.id === this.currentSession?.id) {
      this.hideSessionsModal();
      return;
    }

    this.currentSession = session;
    this.sessionName.textContent = session.name;
    this.messagesContainer.innerHTML = '';

    this.subscribe(session.id);
    this.hideSessionsModal();
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ClaudeCompanion();
});
