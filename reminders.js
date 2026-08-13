// Напоминания дневника питания: тик раз в минуту, время считается по часовому поясу пациента.
// Firestore и FCM дёргаются по REST — библиотека firebase-admin на Deno Deploy не нужна.
//
// Триггеры (местное время пациента): завтрак пуст в 13:00, обед в 17:00, ужин в 22:00.
// Каждое напоминание уходит один раз за день, без звука.

const SERVICE_ACCOUNT_RAW = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') || '';

const MEALS = [
  { key: 'breakfast', label: 'завтрак', hour: 13, field: 'lastBreakfastReminder', title: 'Не забудьте написать, что вы ели на завтрак' },
  { key: 'lunch', label: 'обед', hour: 17, field: 'lastLunchReminder', title: 'Не забудьте написать, что вы ели на обед' },
  { key: 'dinner', label: 'ужин', hour: 22, field: 'lastDinnerReminder', title: 'Не забудьте написать, что вы ели на ужин' },
];

// Токен считаем мёртвым только при этих кодах — остальные ошибки могут быть временными.
const DEAD_TOKEN_CODES = ['UNREGISTERED', 'INVALID_ARGUMENT'];

// --- Доступ к Google API: JWT сервис-аккаунта меняем на access token ---

let cachedToken = null; // { value, expiresAt }

function base64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PEM сервис-аккаунта -> ключ для подписи RS256.
async function importKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getAccessToken(account) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));

  const key = await importKey(account.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  );
  const jwt = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${await res.text()}`);

  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

// --- Firestore REST: значения приходят обёрнутыми в тип, разворачиваем ---

function unwrap(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(unwrap);
  if ('mapValue' in value) return unwrapFields(value.mapValue.fields || {});
  return null;
}

function unwrapFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = unwrap(v);
  return out;
}

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

async function listPatients(account, token) {
  const res = await fetch(`${firestoreBase(account.project_id)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'role' },
            op: 'EQUAL',
            value: { stringValue: 'patient' },
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore runQuery ${res.status}: ${await res.text()}`);

  const rows = await res.json();
  return rows
    .filter((row) => row.document)
    .map((row) => ({
      uid: row.document.name.split('/').pop(),
      data: unwrapFields(row.document.fields || {}),
    }));
}

async function getEntry(account, token, uid, date) {
  const res = await fetch(`${firestoreBase(account.project_id)}/users/${uid}/entries/${date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Firestore get ${res.status}: ${await res.text()}`);
  const doc = await res.json();
  return unwrapFields(doc.fields || {});
}

// PATCH с updateMask трогает только перечисленные поля — остальной документ цел.
async function patchUser(account, token, uid, updates) {
  const fields = {};
  const mask = [];
  for (const [key, value] of Object.entries(updates)) {
    mask.push(`updateMask.fieldPaths=${encodeURIComponent(key)}`);
    fields[key] = typeof value === 'string'
      ? { stringValue: value }
      : { arrayValue: { values: value.map((item) => ({
          mapValue: { fields: {
            token: { stringValue: item.token },
            standalone: { booleanValue: item.standalone === true },
            ...(item.updatedAt ? { updatedAt: { stringValue: item.updatedAt } } : {}),
          } },
        })) } };
  }

  const res = await fetch(
    `${firestoreBase(account.project_id)}/users/${uid}?${mask.join('&')}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }
  );
  if (!res.ok) throw new Error(`Firestore patch ${res.status}: ${await res.text()}`);
}

// --- FCM ---

// Шлём data-only: заголовок рисует сервис-воркер сам, поэтому уведомление тихое.
async function sendPush(account, token, deviceToken, title) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          data: { title, silent: 'true' },
          webpush: { headers: { Urgency: 'normal' } },
        },
      }),
    }
  );
  if (res.ok) return { ok: true };

  const text = await res.text();
  const code = DEAD_TOKEN_CODES.find((c) => text.includes(c)) || '';
  return { ok: false, dead: code !== '', error: text.slice(0, 200) };
}

// --- Правила ---

// Местные дата и час пациента в его часовом поясе.
function localParts(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function hasContent(field) {
  if (!field) return false;
  if (typeof field === 'string') return field.trim() !== '';
  if (!Array.isArray(field)) return false;
  return field.some((seg) => seg && typeof seg.text === 'string' && seg.text.trim() !== '');
}

// Старый формат (просто строка) считаем токеном из браузера.
function normalizeTokens(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? { token: item, standalone: false } : item))
    .filter((item) => item && typeof item.token === 'string' && item.token !== '');
}

// Установленное приложение важнее вкладки браузера: если есть его токены — шлём только на них.
function pickTargets(tokens) {
  const standalone = tokens.filter((item) => item.standalone);
  return standalone.length > 0 ? standalone : tokens;
}

export async function runReminders() {
  if (!SERVICE_ACCOUNT_RAW) {
    console.error('FIREBASE_SERVICE_ACCOUNT не задан — напоминания не работают');
    return { sent: 0, skipped: 'нет ключа' };
  }

  const account = JSON.parse(SERVICE_ACCOUNT_RAW);
  const token = await getAccessToken(account);
  const patients = await listPatients(account, token);

  let sentCount = 0;

  for (const { uid, data: user } of patients) {
    const tokens = normalizeTokens(user.fcmTokens);
    if (tokens.length === 0 || !user.timezone) continue;

    let local;
    try {
      local = localParts(user.timezone);
    } catch {
      console.error(`Пропущен (часовой пояс "${user.timezone}"): ${user.name}`);
      continue;
    }

    // Сначала решаем, есть ли вообще что слать: без этого не читаем запись дня.
    const due = MEALS.filter((meal) => local.hour >= meal.hour && user[meal.field] !== local.date);
    if (due.length === 0) continue;

    const entry = await getEntry(account, token, uid, local.date);
    const targets = pickTargets(tokens);
    const updates = {};
    const dead = new Set();

    for (const meal of due) {
      if (hasContent(entry[meal.key])) continue;

      let sent = false;
      for (const item of targets) {
        if (dead.has(item.token)) continue;
        const result = await sendPush(account, token, item.token, meal.title);
        if (result.ok) sent = true;
        else if (result.dead) dead.add(item.token);
        else console.error(`Не удалось отправить ${user.name}: ${result.error}`);
      }

      if (sent) {
        updates[meal.field] = local.date;
        sentCount += 1;
        console.log(`${user.name} / ${meal.label}: ОТПРАВЛЕНО (${user.timezone}, ${local.hour}:00)`);
      }
    }

    if (dead.size > 0) {
      updates.fcmTokens = tokens.filter((item) => !dead.has(item.token));
    }

    if (Object.keys(updates).length > 0) {
      await patchUser(account, token, uid, updates);
    }
  }

  return { sent: sentCount, patients: patients.length };
}
