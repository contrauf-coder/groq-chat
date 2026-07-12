const accessScreen = document.getElementById('access-screen');
const chatScreen = document.getElementById('chat-screen');
const accessInput = document.getElementById('access-input');
const accessSubmit = document.getElementById('access-submit');
const accessError = document.getElementById('access-error');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const clearBtn = document.getElementById('clear-btn');

let accessCode = localStorage.getItem('groq-access-code') || '';
let history = [];

function showChat() {
  accessScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
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

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
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
  chatInput.value = '';
  chatInput.style.height = 'auto';

  sendBtn.disabled = true;
  const pending = addMessage('assistant pending', 'Печатает...');

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
      pending.remove();
      history.pop();
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
      return;
    }

    pending.className = 'msg assistant';
    pending.textContent = data.reply;
    history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    pending.className = 'msg error';
    pending.textContent = 'Ошибка сети — сервер недоступен';
    history.pop();
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
});

clearBtn.addEventListener('click', () => {
  history = [];
  messagesEl.innerHTML = '';
});
