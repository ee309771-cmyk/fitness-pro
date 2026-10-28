const DB = 'fitness-pro-local-v1';
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器未允许本地存储，可先导出报告')); 
  });
}
async function transact(mode, action) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', mode);
      let result;
      const request = action(tx.objectStore('sessions'));
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error('本地保存失败，可能存储空间不足；请先导出报告'));
      tx.onabort = () => reject(new Error('本地存储操作未完成，请先导出报告'));
    });
  } finally { db.close(); }
}
export async function saveSession(report, file) {
  const id = report.id ?? crypto.randomUUID();
  await transact('readwrite', store => store.put({ id, report: { ...report, id }, file: file ?? null, savedAt: Date.now() }));
  return id;
}
export async function listSessions() {
  const records = await transact('readonly', store => store.getAll());
  return records.sort((a, b) => b.savedAt - a.savedAt);
}
export function deleteSession(id) { return transact('readwrite', store => store.delete(id)); }
