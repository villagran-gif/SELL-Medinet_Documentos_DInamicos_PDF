const BASE = (process.env.SELL_API_BASE || 'https://api.getbase.com').replace(/\/$/, '');
const TOKEN = process.env.SELL_ACCESS_TOKEN || '';

function requireToken() {
  if (!TOKEN) {
    const err = new Error('Falta variable de entorno SELL_ACCESS_TOKEN');
    err.code = 'MISSING_SELL_ACCESS_TOKEN';
    throw err;
  }
}


async function safeReadText(res) {
  try {
    return await res.text();
  } catch (_e) {
    return '';
  }
}

async function sellFetch(path, options = {}) {
  requireToken();
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Sell API ${res.status}: ${text}`);
    err.code = 'SELL_API_ERROR';
    err.http_status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// ---- Custom field mapping cache ----
const _mappingCache = new Map();

async function getCustomFieldsMapping(resource /* 'contacts' | 'deals' | 'leads' */) {
  const key = String(resource);
  if (_mappingCache.has(key)) return _mappingCache.get(key);

  const json = await sellFetch(`/v3/${key}/custom_fields`, { method: 'GET' });
  const items = (json && json.items) || [];
  const mapped = items
    .map((x) => x && x.data)
    .filter(Boolean)
    .map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      resource_type: d.resource_type,
      search_api_id: d.search_api_id,
    }));

  _mappingCache.set(key, mapped);
  return mapped;
}

async function resolveSearchApiId(resource, fieldNameOrId) {
  const val = String(fieldNameOrId || '').trim();
  if (!val) throw new Error(`Campo custom field vacío para ${resource}`);

  // If user passes something that already looks like a Search API id, use it.
  if (val.startsWith('custom_fields.')) return val;
  if (val.startsWith('custom_fields.contact:')) return val;
  if (val.startsWith('custom_fields.sales_account:')) return val;

  // If numeric id, build a best-guess.
  if (/^\d+$/.test(val)) {
    if (resource === 'contacts') return `custom_fields.contact:${val}`;
    return `custom_fields.${val}`;
  }

  // Otherwise resolve by name through mapping API.
  const mapping = await getCustomFieldsMapping(resource);
  const hit = mapping.find((x) => (x.name || '').toLowerCase() === val.toLowerCase());
  if (!hit) {
    const err = new Error(`No se encontró custom field '${val}' en mapping /v3/${resource}/custom_fields`);
    err.code = 'CUSTOM_FIELD_NOT_FOUND';
    throw err;
  }
  return hit.search_api_id;
}

function buildProjection(names) {
  return (names || [])
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function buildAnyFilter(attributeName, values) {
  const v = (values || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!v.length) throw new Error('Filtro vacío');

  return {
    filter: {
      attribute: { name: attributeName },
      parameter: v.length === 1 ? { eq: v[0] } : { any: v },
    },
  };
}

async function searchContactsByCustomField(searchApiId, values, perPage = 10) {
  const body = {
    items: [
      {
        data: {
          query: {
            filter: buildAnyFilter(searchApiId, values),
            projection: buildProjection(['id', 'display_name', searchApiId]),
          },
        },
        per_page: perPage,
      },
    ],
  };

  const json = await sellFetch('/v3/contacts/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const bucket = json?.items?.[0];
  const hits = bucket?.items || [];
  return hits.map((x) => x.data).filter(Boolean);
}

async function searchDealsByCustomField(searchApiId, values, perPage = 50) {
  const body = {
    items: [
      {
        data: {
          query: {
            filter: buildAnyFilter(searchApiId, values),
            // default projection already includes id; keep minimal
          },
        },
        per_page: perPage,
      },
    ],
  };

  const json = await sellFetch('/v3/deals/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const bucket = json?.items?.[0];
  const hits = bucket?.items || [];
  return hits.map((x) => x.data).filter(Boolean);
}

async function getDealsByIds(ids) {
  const unique = Array.from(new Set((ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
  if (!unique.length) return [];
  const json = await sellFetch(`/v2/deals?ids=${unique.join(',')}`, { method: 'GET' });
  return (json?.items || []).map((x) => x.data).filter(Boolean);
}

async function getStagesByIds(ids) {
  const unique = Array.from(new Set((ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
  if (!unique.length) return [];
  const json = await sellFetch(`/v2/stages?ids=${unique.join(',')}`, { method: 'GET' });
  return (json?.items || []).map((x) => x.data).filter(Boolean);
}

async function getFirstStageIdForPipeline(pipelineId) {
  const pid = Number(pipelineId);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('pipelineId inválido');
  const json = await sellFetch(`/v2/stages?pipeline_id=${encodeURIComponent(pid)}&active=true&sort_by=position&per_page=1`, {
    method: 'GET',
  });
  const st = json?.items?.[0]?.data;
  return st?.id || null;
}



async function getPipelinesByIds(ids) {
  const unique = Array.from(new Set((ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
  if (!unique.length) return [];
  const json = await sellFetch(`/v2/pipelines?ids=${unique.join(',')}`, { method: 'GET' });
  return (json?.items || []).map((x) => x.data).filter(Boolean);
}


async function getContactCustomFields() {
  // Returns array of {id,name,type,choices?...}
  const json = await sellFetch('/v2/contact/custom_fields');
  const items = (json && json.items) ? json.items : [];
  return items.map((it) => it.data);
}

async function createContact(payload) {
  // payload: { data: { ... } }
  const json = await sellFetch('/v2/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return json && json.data ? json.data : json;
}


async function getDealCustomFields() {
  // Returns array of {id,name,type,choices?...}
  const json = await sellFetch('/v2/deal/custom_fields');
  const items = (json && json.items) ? json.items : [];
  return items.map((it) => it.data);
}

async function createDeal(payload) {
  // payload: { data: { ... } }
  const json = await sellFetch('/v2/deals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return json && json.data ? json.data : json;
}

async function getDealById(id) {
  const dealId = Number(id);
  if (!Number.isFinite(dealId) || dealId <= 0) throw new Error('deal id inválido');
  const json = await sellFetch(`/v2/deals/${dealId}`, { method: 'GET' });
  return json && json.data ? json.data : json;
}

async function getContactById(id) {
  const contactId = Number(id);
  if (!Number.isFinite(contactId) || contactId <= 0) throw new Error('contact id inválido');
  const json = await sellFetch(`/v2/contacts/${contactId}`, { method: 'GET' });
  return json && json.data ? json.data : json;
}

async function createNoteForDeal(dealId, content) {
  const did = Number(dealId);
  if (!Number.isFinite(did) || did <= 0) throw new Error('deal id inválido');
  const payload = {
    data: {
      resource_type: 'deal',
      resource_id: did,
      content: String(content || '').trim(),
    },
  };
  const json = await sellFetch('/v2/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return json && json.data ? json.data : json;
}


module.exports = {
  resolveSearchApiId,
  searchContactsByCustomField,
  searchDealsByCustomField,
  getDealsByIds,
  getStagesByIds,
  getPipelinesByIds,
  getContactCustomFields,
  getDealCustomFields,
  createContact,
  createDeal,
  getFirstStageIdForPipeline,
  getDealById,
  getContactById,
  createNoteForDeal,
};
