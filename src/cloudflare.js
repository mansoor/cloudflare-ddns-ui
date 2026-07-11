// Minimal Cloudflare API v4 client. Uses a scoped API token (Bearer auth).

const API_BASE = 'https://api.cloudflare.com/client/v4';

class CloudflareError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'CloudflareError';
    this.errors = errors || [];
  }
}

async function cfFetch(token, pathAndQuery, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(`${API_BASE}${pathAndQuery}`, {
      ...options,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new CloudflareError(`Cloudflare returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || body.success === false) {
    const errs = body.errors || [];
    const msg = errs.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new CloudflareError(msg, errs);
  }
  return body;
}

// Verify a token and return its zones. Also serves as the token validity check.
export async function listZones(token) {
  const zones = [];
  let page = 1;
  // Cloudflare paginates; 50 per page is plenty for typical accounts.
  for (;;) {
    const body = await cfFetch(token, `/zones?per_page=50&page=${page}`);
    for (const z of body.result) zones.push({ id: z.id, name: z.name, status: z.status });
    const info = body.result_info;
    if (!info || page >= info.total_pages) break;
    page += 1;
  }
  return zones;
}

// Find A/AAAA records for a specific FQDN and type within a zone.
export async function listRecords(token, zoneId, { type, name }) {
  const params = new URLSearchParams({ per_page: '100' });
  if (type) params.set('type', type);
  if (name) params.set('name', name);
  const body = await cfFetch(token, `/zones/${zoneId}/dns_records?${params.toString()}`);
  return body.result;
}

export async function createRecord(token, zoneId, record) {
  const body = await cfFetch(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(record),
  });
  return body.result;
}

export async function updateRecord(token, zoneId, recordId, record) {
  const body = await cfFetch(token, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PUT',
    body: JSON.stringify(record),
  });
  return body.result;
}

export async function deleteRecord(token, zoneId, recordId) {
  await cfFetch(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}

// --- Account-level IP Lists (WAF) ---

// List an account's rules lists. Also validates the token + account id.
export async function listAccountLists(token, accountId) {
  const body = await cfFetch(token, `/accounts/${accountId}/rules/lists`);
  return (body.result || []).map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind,
    num_items: l.num_items,
  }));
}

// All items in a list (paginated by cursor).
export async function getListItems(token, accountId, listId) {
  const items = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams({ per_page: '100' });
    if (cursor) params.set('cursor', cursor);
    const body = await cfFetch(
      token,
      `/accounts/${accountId}/rules/lists/${listId}/items?${params.toString()}`
    );
    for (const it of body.result || []) {
      items.push({ id: it.id, ip: it.ip, comment: it.comment || '' });
    }
    cursor = body.result_info?.cursors?.after;
    if (!cursor) break;
  }
  return items;
}

// Append items: [{ ip, comment }]. Async op — returns { operation_id }.
export async function addListItems(token, accountId, listId, items) {
  const body = await cfFetch(token, `/accounts/${accountId}/rules/lists/${listId}/items`, {
    method: 'POST',
    body: JSON.stringify(items),
  });
  return body.result;
}

// Remove items by id: ['itemId', ...]. Async op — returns { operation_id }.
export async function deleteListItems(token, accountId, listId, itemIds) {
  const body = await cfFetch(token, `/accounts/${accountId}/rules/lists/${listId}/items`, {
    method: 'DELETE',
    body: JSON.stringify({ items: itemIds.map((id) => ({ id })) }),
  });
  return body.result;
}

export { CloudflareError };
