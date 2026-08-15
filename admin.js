// Точечная админ-операция: удалить пациента целиком — вызывается вручную,
// защищена тем же секретом, что и ручной прогон напоминаний.

import { getAccessToken } from './google-auth.js';

const SERVICE_ACCOUNT_RAW = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') || '';
const SCOPES = [
  'https://www.googleapis.com/auth/datastore',
  'https://www.googleapis.com/auth/identitytoolkit',
];

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

async function deleteDocument(url, token) {
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  // 404 — уже удалено кем-то ещё, не считаем ошибкой.
  if (!res.ok && res.status !== 404) throw new Error(`Firestore delete ${res.status}: ${await res.text()}`);
}

// Firestore REST не удаляет подколлекции вместе с документом — сначала listDocuments, потом каждый по одному.
async function deleteCollection(base, path, token) {
  let deleted = 0;
  let pageToken;
  do {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore list ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const doc of data.documents || []) {
      await deleteDocument(`https://firestore.googleapis.com/v1/${doc.name}`, token);
      deleted += 1;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return deleted;
}

// Удаляет и вход (Firebase Auth), и профиль с записями (Firestore). Возвращает, что реально снесли.
export async function deletePatient(uid) {
  if (!SERVICE_ACCOUNT_RAW) throw new Error('FIREBASE_SERVICE_ACCOUNT не задан');
  if (!uid) throw new Error('uid обязателен');

  const account = JSON.parse(SERVICE_ACCOUNT_RAW);
  const token = await getAccessToken(account, SCOPES);
  const base = firestoreBase(account.project_id);

  const entriesDeleted = await deleteCollection(base, `users/${uid}/entries`, token);
  await deleteDocument(`${base}/users/${uid}`, token);

  const authRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${account.project_id}/accounts:delete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uid }),
    }
  );
  // NOT_FOUND — входа могло не быть (например, доступ выдавался только по Firestore); не считаем ошибкой.
  let authDeleted = authRes.ok;
  if (!authRes.ok) {
    const text = await authRes.text();
    if (!text.includes('USER_NOT_FOUND')) throw new Error(`Auth delete ${authRes.status}: ${text}`);
  }

  return { uid, entriesDeleted, authDeleted };
}
