const accessScreen = document.getElementById('access-screen');
const chatScreen = document.getElementById('chat-screen');
const accessInput = document.getElementById('access-input');
const accessSubmit = document.getElementById('access-submit');
const accessError = document.getElementById('access-error');
const messagesEl = document.getElementById('messages');
const emptyState = document.getElementById('empty-state');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const clearBtn = document.getElementById('clear-btn');

const AVATARS = { user: '🧑', assistant: '🤖' };

let accessCode = localStorage.getItem('groq-access-code') || '';
let history = JSON.parse(localStorage.getItem('groq-chat-history') || '[]');

function saveHistory() {
  localStorage.setItem('groq-chat-history', JSON.stringify(history));
}

function showChat() {
  accessScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  history.forEach((msg) => addMessage(msg.role, msg.content));
  chatInput.focus();
}

function enterAccess(code) {
  accessCode = code;
  localStorage.setItem('groq-access-code', code);
  showChat();
}

accessSubmit.addEventListener('click', () => enterAccess(accessInput.value));
accessInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterAccess(accessInput.value);
});

// Если код уже сохранён с прошлого раза — сразу в чат
if (accessCode !== null && localStorage.getItem('groq-access-code') !== null) {
  showChat();
}

function updateEmptyState() {
  emptyState.classList.toggle('hidden', messagesEl.querySelectorAll('.msg-row').length > 0);
}

function addMessage(role, content) {
  const row = document.createElement('div');
  row.className = `msg-row ${role === 'user' ? 'user' : 'assistant'}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = AVATARS[role] || AVATARS.assistant;

  const bubble = document.createElement('div');
  bubble.className = 'msg';
  bubble.textContent = content;

  row.append(avatar, bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateEmptyState();
  return bubble;
}

function addTypingIndicator() {
  const bubble = addMessage('assistant', '');
  bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  return bubble;
}

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  addMessage('user', text);
  history.push({ role: 'user', content: text });
  saveHistory();
  chatInput.value = '';
  chatInput.style.height = 'auto';

  sendBtn.disabled = true;
  const pending = addTypingIndicator();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-code': accessCode,
      },
      body: JSON.stringify({ messages: history }),
    });

    const data = await res.json();

    if (res.status === 401) {
      pending.parentElement.remove();
      history.pop();
      saveHistory();
      localStorage.removeItem('groq-access-code');
      accessScreen.classList.remove('hidden');
      chatScreen.classList.add('hidden');
      accessError.textContent = 'Неверный код доступа, попробуйте снова';
      return;
    }

    if (!res.ok) {
      pending.className = 'msg error';
      pending.textContent = data.error || 'Что-то пошло не так';
      history.pop();
      saveHistory();
      return;
    }

    pending.className = 'msg';
    pending.textContent = data.reply;
    history.push({ role: 'assistant', content: data.reply });
    saveHistory();
  } catch (err) {
    pending.className = 'msg error';
    pending.textContent = 'Ошибка сети — сервер недоступен';
    history.pop();
    saveHistory();
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
});

clearBtn.addEventListener('click', () => {
  history = [];
  saveHistory();
  messagesEl.querySelectorAll('.msg-row').forEach((row) => row.remove());
  updateEmptyState();
});
