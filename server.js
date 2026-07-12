require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ACCESS_CODE = process.env.ACCESS_CODE || '';

if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY не задан. Создайте .env на основе .env.example');
  process.exit(1);
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Простой rate limit по IP, чтобы случайный визитёр не сжёг лимиты API
const RATE_LIMIT = 20; // запросов
const RATE_WINDOW_MS = 60 * 1000; // за минуту
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

app.post('/api/chat', async (req, res) => {
  if (ACCESS_CODE && req.get('x-access-code') !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Неверный код доступа' });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Поле messages обязательно и должно быть непустым массивом' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Ошибка Groq API' });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    res.json({ reply });
  } catch (err) {
    console.error('Ошибка запроса к Groq:', err);
    res.status(502).json({ error: 'Не удалось связаться с Groq API' });
  }
});

app.listen(PORT, () => {
  console.log(`Groq Chat запущен: http://localhost:${PORT}`);
});
