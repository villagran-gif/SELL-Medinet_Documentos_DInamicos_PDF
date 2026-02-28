
async function resolvePipelineName(pipelineId) {
  try {
    const pipelines = await getPipelines();
    const p = (pipelines || []).find(x => Number(x.id) === Number(pipelineId));
    return p ? p.name : null;
  } catch (_e) {
    return null;
  }
}

const path = require('path');
const express = require('express');

const { normalizeRut } = require('./lib/rut');
const {
  resolveSearchApiId,
  searchContactsByCustomField,
  searchDealsByCustomField,
  getDealsByIds,
  getStagesByIds,
  getPipelinesByIds,
  getPipelines,
  getFirstStageIdForPipeline,
  getContactCustomFields,
  getDealCustomFields,
  createContact,
  createDeal,
  getDealById,
  getContactById,
  createNoteForDeal,
} = require('./lib/sell');

const {
  listTemplatesInFolder,
  ensurePatientFolders,
  copyTemplateToFolder,
  replacePlaceholdersInDoc,
  exportDocAsPdfBuffer,
  uploadPdfToFolder,
  driveFolderUrl,
  driveFileUrl,
  docsEditUrl,
} = require('./lib/drive_docs');

const { canonicalComuna, ERROR_COMUNA } = require('./lib/comunas');

const app = express();
app.use(express.json({ limit: '1mb' }));
// Be tolerant to accidental double slashes like "//api/search-rut"
app.use((req, _res, next) => {
  if (req.url && req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.status(200).send('ok'));

// Build URLs
function deskContactUrl(id) {
  const base = (process.env.SELL_DESKTOP_BASE_URL || 'https://clinyco.zendesk.com/sales').replace(/\/$/, '');
  return `${base}/contacts/${id}`;
}
function deskDealUrl(id) {
  const base = (process.env.SELL_DESKTOP_BASE_URL || 'https://clinyco.zendesk.com/sales').replace(/\/$/, '');
  return `${base}/deals/${id}`;
}
function mobileContactUrl(id) {
  const base = (process.env.SELL_MOBILE_CONTACT_BASE_URL || 'https://app.futuresimple.com/crm').replace(/\/$/, '');
  return `${base}/contacts/${id}`;
}
function mobileDealUrl(id) {
  const base = (process.env.SELL_MOBILE_DEAL_BASE_URL || 'https://app.futuresimple.com/sales').replace(/\/$/, '');
  return `${base}/deals/${id}`;
}

// --- Field catalog cache (Contact) ---
let CONTACT_CATALOG = null;
let CONTACT_CATALOG_AT = 0;
const CATALOG_TTL_MS = 15 * 60 * 1000; // 15 min

function normKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function getContactCatalog(force = false) {
  const now = Date.now();
  if (!force && CONTACT_CATALOG && (now - CONTACT_CATALOG_AT) < CATALOG_TTL_MS) return CONTACT_CATALOG;

  const fields = await getContactCustomFields();
  const byId = new Map();
  const byName = new Map();
  const listChoicesByFieldId = new Map(); // fieldId -> Map(normChoiceName -> {id,name})

  for (const f of fields) {
    byId.set(f.id, f);
    byName.set(f.name, f);
    if (f.type === 'list' && Array.isArray(f.choices)) {
      const cm = new Map();
      for (const ch of f.choices) cm.set(normKey(ch.name), { id: ch.id, name: ch.name });
      listChoicesByFieldId.set(f.id, cm);
    }
  }

  CONTACT_CATALOG = { fields, byId, byName, listChoicesByFieldId };
  CONTACT_CATALOG_AT = now;
  return CONTACT_CATALOG;
}


// --- Field catalog cache (Deal) ---
let DEAL_CATALOG = null;
let DEAL_CATALOG_AT = 0;

async function getDealCatalog(force = false) {
  const now = Date.now();
  if (!force && DEAL_CATALOG && (now - DEAL_CATALOG_AT) < CATALOG_TTL_MS) return DEAL_CATALOG;

  const fields = await getDealCustomFields();
  const byId = new Map();
  const byName = new Map();
  const listChoicesByFieldId = new Map(); // fieldId -> Map(normChoiceName -> {id,name})

  for (const f of fields) {
    byId.set(f.id, f);
    byName.set(f.name, f);
    if (f.type === 'list' && Array.isArray(f.choices)) {
      const cm = new Map();
      for (const ch of f.choices) cm.set(normKey(ch.name), { id: ch.id, name: ch.name });
      listChoicesByFieldId.set(f.id, cm);
    }
  }

  DEAL_CATALOG = { fields, byId, byName, listChoicesByFieldId };
  DEAL_CATALOG_AT = now;
  return DEAL_CATALOG;
}

function findDealFieldNameByNorm(cat, normNames /* array of normalized candidates */) {
  for (const f of cat.fields) {
    const n = normKey(f.name);
    if (normNames.includes(n)) return f.name;
  }
  return null;
}

function mustFieldNameById(cat, id) {
  const f = cat.byId.get(id);
  if (!f || !f.name) {
    const err = new Error(`No existe custom field contact id=${id}`);
    err.code = 'FIELD_NOT_FOUND';
    err.field_id = id;
    throw err;
  }
  return f.name;
}

function formatRutHumanFromNoDashLower(noDashLower) {
  // input: "16927228k" or "123456789"
  const raw = String(noDashLower || '').toUpperCase().replace(/[^0-9K]/g, '');
  if (raw.length < 2) return '';
  const dv = raw.slice(-1);
  let num = raw.slice(0, -1);
  let out = '';
  while (num.length > 3) { out = '.' + num.slice(-3) + out; num = num.slice(0, -3); }
  out = num + out;
  return `${out}-${dv}`;
}

function cleanValue(v) {
  return String(v ?? '')
    .replace(/\*/g, '')
    .replace(/=/g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumDot(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function calcImc(pesoKg, alturaM) {
  if (!Number.isFinite(pesoKg) || !Number.isFinite(alturaM) || alturaM <= 0) return null;
  const imc = pesoKg / (alturaM * alturaM);
  return Number.isFinite(imc) ? imc : null;
}

function classifyImc(imc) {
  if (!Number.isFinite(imc)) return null;
  if (imc < 18.5) return "Bajo peso";
  if (imc < 25.0) return "Normal";
  if (imc < 30.0) return "Sobrepeso";
  return "Obesidad";
}

function calcEdadFromDDMMYYYY(s) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(s||''))) return null;
  const [dd, mm, yyyy] = String(s).split('/').map(x => parseInt(x, 10));
  const dob = new Date(Date.UTC(yyyy, mm - 1, dd));
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return Number.isFinite(age) ? age : null;
}

function isoDateToday() {
  return new Date().toISOString().slice(0,10);
}

function waLinkFromPhone(phone) {
  const digits = String(phone||'').replace(/\D/g,'');
  if (!digits) return null;
  return `https://wa.me/${digits}`;
}

function isValidDobDDMMYYYY(s) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return false;
  const [dd, mm, yyyy] = s.split('/').map((x) => parseInt(x, 10));
  if (yyyy < 1900 || yyyy > 2100) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  return true;
}

function calcAgeFromDobDDMMYYYY(s) {
  if (!isValidDobDDMMYYYY(s)) return null;
  const [dd, mm, yyyy] = s.split('/').map((x) => parseInt(x, 10));
  const dob = new Date(Date.UTC(yyyy, mm - 1, dd));
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}


app.get('/api/pipelines', async (_req, res) => {
  try {
    const items = await getPipelines();
    const pipelines = (items || [])
      .map(p => ({ id: p.id, name: p.name, disabled: p.disabled === true }))
      .filter(p => !p.disabled);

    return res.status(200).json({ ok: true, pipelines });
  } catch (err) {
    console.error('pipelines error', err);

    // Fallback hardcoded list (when token/endpoint fails)
    const pipelines = [
      { id: 290779, name: "Pipeline Cirugía Bariátricas", disabled: false },
      { id: 4823817, name: "Pipeline Balones", disabled: false },
      { id: 4959507, name: "Pipeline Cirugía Plastica", disabled: false },
      { id: 5049979, name: "Pipeline Cirugía General", disabled: false },
    ];

    return res.status(200).json({
      ok: true,
      pipelines,
      fallback: true,
      details: err.message || String(err),
    });
  }
});

app.get('/api/owners', async (_req, res) => {
  try {
    const token = String(process.env.SELL_ACCESS_TOKEN || '').trim();
    if (!token) {
      return res.status(500).json({ ok: false, error: 'MISSING_SELL_ACCESS_TOKEN' });
    }

    const r = await fetch('https://api.getbase.com/v2/users?status=active&confirmed=true&per_page=100&sort_by=name', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_e) {}

    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        error: 'SELL_USERS_FETCH_FAILED',
        status: r.status,
        details: data || text,
      });
    }

    const owners = (data.items || [])
      .map(it => it.data)
      .filter(u => u && u.status === 'active' && u.confirmed === true)
      .map(u => ({ id: u.id, name: u.name, email: u.email || null }));

    return res.status(200).json({ ok: true, owners });
  } catch (err) {
    console.error('owners error', err);

    const fallback = [
      { id: 8348214, name: "Allison Contreras", email: "allison@clinyco.cl" },
      { id: 8380563, name: "Camila Alcayaga", email: null },
      { id: 8380557, name: "Carolin Cornejo", email: null },
      { id: 9499426, name: "Danitza Olivera", email: null },
      { id: 2129414, name: "Dr. Villagran", email: null },
      { id: 9460679, name: "Gabriela Heck", email: null },
      { id: 8348233, name: "Giselle Santander", email: null },
      { id: 9460685, name: "Maria Paz Plonka Rosales", email: null },
      { id: 9522577, name: "Nelson Aros", email: null },
    ];

    return res.status(200).json({ ok: true, owners: fallback, fallback: true });
  }
});



app.get('/api/deal-list-choices', async (req, res) => {
  try {
    const field = String(req.query.field || '').trim();
    if (!field) return res.status(400).json({ ok:false, error:'MISSING_FIELD', message:'field requerido' });

    const cat = await getDealCatalog();
    // match by normalized name
    const targetNorm = normKey(field);
    const f = cat.fields.find(x => normKey(x.name) === targetNorm);
    if (!f) return res.status(404).json({ ok:false, error:'FIELD_NOT_FOUND', field });

    if (f.type !== 'list' || !Array.isArray(f.choices)) {
      return res.status(200).json({ ok:true, field: f.name, type: f.type, choices: [] });
    }

    const choices = f.choices.map(ch => ({ id: ch.id, name: ch.name }));
    return res.status(200).json({ ok:true, field: f.name, type: f.type, choices });
  } catch (err) {
    console.error('deal-list-choices error', err);
    return res.status(500).json({ ok:false, error:'ERROR', message: err.message || String(err) });
  }
});

app.post('/api/search-rut', async (req, res) => {
  // IMPORTANT: Always respond with the same JSON shape.
  const rutInput = (req.body && req.body.rut) || '';
  const pipelineIdRaw = (req.body && req.body.pipelineId) ?? null;
  const pipelineId =
    pipelineIdRaw === null || pipelineIdRaw === undefined || pipelineIdRaw === ''
      ? null
      : Number(pipelineIdRaw);

  // Response state (filled progressively)
  let normalized = null;
  let normalizedNoDash = null;
  let valuesToMatch = [];
  let contactSearchApiId = null;
  let dealSearchApiId = null;
  let contactsOut = [];
  let dealsFoundTotal = 0;
  let dealsOut = [];
  let dealsInSamePipeline = [];
  let dealsByPipeline = [];
  let duplicateDealsByPipeline = [];

  const rules = {
    rut_unique_in_contacts: null,
    rut_unique_in_pipeline: null,
    rut_unique_in_any_pipeline: null,
  };

  const send = (status, error = null, message = null) => {
    const payload = {
      ok: status < 400,
      status,
      error,
      message,
      rut_input: rutInput,
      rut_normalized: normalized,
      rut_normalized_no_dash: normalizedNoDash,
      used_match_values: valuesToMatch,
      contact_custom_field_search_api_id: contactSearchApiId,
      deal_custom_field_search_api_id: dealSearchApiId,
      contacts: contactsOut,
      contacts_found: contactsOut.length,
      contact: contactsOut.length ? contactsOut[0] : null,      deals_found_total: dealsFoundTotal,
      deals: dealsOut,
      deals_found: dealsOut.length,
      deal: dealsOut.length ? dealsOut[0] : null,
      pipeline_id_checked: Number.isFinite(pipelineId) ? pipelineId : null,
      deals_in_same_pipeline: dealsInSamePipeline,
      deals_by_pipeline: dealsByPipeline,
      duplicate_deals_by_pipeline: duplicateDealsByPipeline,
      rules,
    };
    return res.status(status).json(payload);
  };

  try {
    // Validate pipeline id if provided
    if (pipelineIdRaw !== null && pipelineIdRaw !== undefined && pipelineIdRaw !== '' && !Number.isFinite(pipelineId)) {
      return send(400, 'INVALID_PIPELINE_ID', 'Pipeline ID inválido (debe ser numérico).');
    }

    // Normalize and validate DV
    const norm = normalizeRut(rutInput);
    normalized = norm.normalized;
    normalizedNoDash = norm.normalizedNoDash;

    if (!normalized) {
      return send(400, 'MISSING_RUT', 'Debes ingresar un RUT.');
    }

    const contactField = process.env.CONTACT_RUT_NORMALIZED_FIELD || 'RUT_normalizado';
    const dealField = process.env.DEAL_RUT_NORMALIZED_FIELD || 'RUT_normalizado';

    // Resolve Search API attribute ids
    contactSearchApiId = await resolveSearchApiId('contacts', contactField);
    dealSearchApiId = await resolveSearchApiId('deals', dealField);

    // Match mode: "both" (default) searches both 13580388-K and 13580388K to survive legacy data.
    // Set RUT_MATCH_MODE=canonical to search only the canonical format with dash.
    const matchMode = String(process.env.RUT_MATCH_MODE || 'both').toLowerCase();
    valuesToMatch =
      matchMode === 'canonical'
        ? [normalized]
        : Array.from(new Set([normalized, normalizedNoDash]));

    const contacts = await searchContactsByCustomField(contactSearchApiId, valuesToMatch, 10);
    const deals = await searchDealsByCustomField(dealSearchApiId, valuesToMatch, 100);

    contactsOut = contacts.map((c) => ({
      id: c.id,
      display_name: c.display_name,
      desktop_url: deskContactUrl(c.id),
      mobile_url: mobileContactUrl(c.id),
    }));

    dealsFoundTotal = deals.length;

    // Build deal results (even if pipelineId is not provided) so the UI can display them.
    dealsOut = [];
    if (dealsFoundTotal > 0) {
      const dealIdsAll = deals.map((d) => d.id).filter(Boolean);
      // Cap to avoid overly heavy calls if there are many matches.
      const dealIds = dealIdsAll.slice(0, 50);
      const dealDetails = await getDealsByIds(dealIds);

      // Resolve stage -> pipeline and stage names for all deals (useful for UI and pipeline duplicate checks).
      const stageIds = dealDetails.map((d) => d.stage_id).filter(Boolean);
      const stages = await getStagesByIds(stageIds);
      const stageById = new Map(stages.map((s) => [s.id, s]));
      const pipelineIds = Array.from(new Set(stages.map((s) => s.pipeline_id).filter(Boolean)));
      const pipelines = await getPipelinesByIds(pipelineIds);
      const pipelineNameById = new Map(pipelines.map((p) => [p.id, p.name]));

      dealsOut = dealDetails.map((d) => {
        const st = stageById.get(d.stage_id);
        const pid = st ? st.pipeline_id : null;
        return {
          id: d.id,
          name: d.name,
          stage_id: d.stage_id,
          stage_name: st ? st.name : null,
          pipeline_id: pid,
          pipeline_name: pid ? (pipelineNameById.get(pid) || null) : null,
          desktop_url: deskDealUrl(d.id),
          mobile_url: mobileDealUrl(d.id),
        };
      });
    }

    // Group deals by pipeline so the UI can show: "deals encontrados por pipeline"
    // and we can detect violations: 2+ deals with same RUT within the same pipeline.
    dealsByPipeline = [];
    duplicateDealsByPipeline = [];
    if (dealsOut.length > 0) {
      const map = new Map();
      for (const d of dealsOut) {
        const pid = Number.isFinite(d.pipeline_id) ? d.pipeline_id : null;
        const key = pid === null ? 'null' : String(pid);
        if (!map.has(key)) {
          map.set(key, {
            pipeline_id: pid,
            pipeline_name: d.pipeline_name ?? null,
            deals: [],
            deal_ids: [],
            count: 0,
          });
        }
        const g = map.get(key);
        g.deals.push(d);
        g.deal_ids.push(d.id);
        g.count = g.deal_ids.length;
      }
      dealsByPipeline = Array.from(map.values()).sort((a, b) => {
        const an = (a.pipeline_name || '').toLowerCase();
        const bn = (b.pipeline_name || '').toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        const ai = a.pipeline_id || 0;
        const bi = b.pipeline_id || 0;
        return ai - bi;
      });
      // Only count duplicates where pipeline_id is known.
      duplicateDealsByPipeline = dealsByPipeline.filter((g) => Number.isFinite(g.pipeline_id) && g.count > 1);
      rules.rut_unique_in_any_pipeline = duplicateDealsByPipeline.length === 0;
    } else {
      rules.rut_unique_in_any_pipeline = true;
    }



    // Contact uniqueness
    const contactDuplicate = contacts.length > 1;
    rules.rut_unique_in_contacts = !contactDuplicate;
    // Deals in pipeline uniqueness (derive pipeline_id via stage_id)
    dealsInSamePipeline = [];
    if (Number.isFinite(pipelineId) && pipelineId > 0) {
      // dealsOut already includes pipeline_id when pipelineId is provided.
      dealsInSamePipeline = dealsOut
        .filter((d) => d.pipeline_id === pipelineId)
        .map((d) => ({
          id: d.id,
          name: d.name,
          stage_id: d.stage_id,
          stage_name: d.stage_name ?? null,
          pipeline_id: d.pipeline_id,
          pipeline_name: d.pipeline_name ?? null,
          desktop_url: d.desktop_url,
          mobile_url: d.mobile_url,
        }));

      rules.rut_unique_in_pipeline = dealsInSamePipeline.length === 0;
    } else {
      rules.rut_unique_in_pipeline = null;
    }

    // Hard-fail on duplicates
    if (contactDuplicate) {
      return send(409, 'DUPLICATE_CONTACT_RUT', 'Ya existen 2 o más contactos con el mismo RUT_normalizado.');
    }
    if (Number.isFinite(pipelineId) && pipelineId > 0 && dealsInSamePipeline.length > 0) {
      return send(
        409,
        'DUPLICATE_DEAL_RUT_IN_PIPELINE',
        'Ya existe al menos 1 deal en el mismo pipeline con este RUT_normalizado.'
      );
    }

    // Global rule (general): There must not be 2+ deals with the same RUT inside the same pipeline (any pipeline).
    if (duplicateDealsByPipeline.length > 0) {
      return send(
        409,
        'DUPLICATE_DEAL_RUT_IN_PIPELINE',
        'Ya existen 2 o más deals con este RUT dentro del mismo pipeline.'
      );
    }

    return send(200, null, null);
  } catch (err) {
    const status =
      err && (err.code === 'INVALID_RUT_DV' || err.code === 'MISSING_RUT_DV')
        ? 400
        : err && err.http_status
          ? err.http_status
          : 500;
    return send(status, err.code || 'ERROR', err.message || String(err));
  }
});


app.post('/api/create-contact', async (req, res) => {
  const dryRun = String(req.query.dry_run || '').toLowerCase() === '1' || String(req.query.dry_run || '').toLowerCase() === 'true';
  const debug = String(req.query.debug || '').toLowerCase() === '1' || String(req.query.debug || '').toLowerCase() === 'true';

  // Safety switch (unless dry-run)
  if (!dryRun && String(process.env.ALLOW_WRITE || 'false').toLowerCase() !== 'true') {
    return res.status(403).json({
      ok: false,
      status: 403,
      error: 'WRITE_DISABLED',
      message: 'Creación deshabilitada en este entorno (ALLOW_WRITE != true).',
    });
  }

  // Always reply with stable shape
  const out = (status, error = null, message = null, extra = {}) => {
    return res.status(status).json({
      ok: status < 400,
      status,
      error,
      message,
      ...extra,
    });
  };

  try {
    const body = req.body || {};

    const rutInput = cleanValue(body.rut || body.run || body.RUN);
    const nombres = cleanValue(body.nombres || body.Nombres);
    const apellidos = cleanValue(body.apellidos || body.Apellidos);
    const fechaNacimiento = cleanValue(body.fecha_nacimiento || body.fechaNacimiento || body['Fecha de Nacimiento'] || body['Fecha Nacimiento']);
    const telefono1 = cleanValue(body.telefono1 || body.telefono_1 || body['Teléfono 1'] || body['Telefono 1'] || body.phone1);
    const telefono2 = cleanValue(body.telefono2 || body.telefono_2 || body['Teléfono 2'] || body['Telefono 2'] || body.phone2) || telefono1;
    const email = cleanValue(body.email || body.correo || body['Correo electrónico'] || body['Correo electronico']);
    const aseguradoraRaw = cleanValue(body.aseguradora || body.prevision || body['Aseguradora'] || body['Previsión'] || body['Prevision']);
    const modalidad = cleanValue(body.modalidad || body['Modalidad']);
    const direccion = cleanValue(body.direccion || body['Dirección'] || body['Direccion']);
    const comunaInput = cleanValue(body.comuna || body['Comuna']);
    const comuna = canonicalComuna(comunaInput);

    // mínimos
    if (!rutInput) return out(400, 'MISSING_RUT', 'Debes ingresar un RUN/RUT.');
    if (!nombres) return out(400, 'MISSING_FIRST_NAME', 'Faltan Nombres.');
    if (!apellidos) return out(400, 'MISSING_LAST_NAME', 'Faltan Apellidos.');
    if (!fechaNacimiento) return out(400, 'MISSING_DOB', 'Falta Fecha de Nacimiento.');
    if (!isValidDobDDMMYYYY(fechaNacimiento)) return out(400, 'INVALID_DOB_FORMAT', 'Fecha de Nacimiento inválida. Debe ser DD/MM/YYYY.');
    if (!telefono1) return out(400, 'MISSING_PHONE1', 'Falta Teléfono 1.');
    if (!email) return out(400, 'MISSING_EMAIL', 'Falta Correo electrónico.');
    if (!aseguradoraRaw) return out(400, 'MISSING_ASEGURADORA', 'Falta Aseguradora/Previsión.');
    if (!modalidad) return out(400, 'MISSING_MODALIDAD', 'Falta Modalidad.');
    if (!direccion) return out(400, 'MISSING_ADDRESS', 'Falta Dirección.');

    // Normaliza RUT
    const norm = normalizeRut(rutInput);
    const rutNoDashUpper = norm.normalizedNoDash;               // 16927228K
    const rutNoDashLower = String(rutNoDashUpper).toLowerCase(); // 16927228k  <-- CANON write
    const rutHuman = formatRutHumanFromNoDashLower(rutNoDashLower); // 16.927.228-K

    // Catálogo
    const cat = await getContactCatalog();
    const FN_RUT_NORM = mustFieldNameById(cat, 6265931); // RUT_normalizado
    const FN_RUT_HUMAN = mustFieldNameById(cat, 5883525); // RUT o ID
    const FN_DOB = mustFieldNameById(cat, 5863844); // Fecha Nacimiento
    const FN_DOB_1 = mustFieldNameById(cat, 6236073); // Fecha Nacimiento#1
    const FN_PREV_LIST = mustFieldNameById(cat, 6373567); // Previsión (list)
    const FN_PREV_STR = mustFieldNameById(cat, 5853892); // Previsión##
    const FN_PREV_1 = mustFieldNameById(cat, 6235294); // Previsión#1
    const FN_EMAIL_MIRROR = mustFieldNameById(cat, 5862966); // Correo electrónico (custom)
    const FN_PHONE_MIRROR = mustFieldNameById(cat, 5862996); // Teléfono (custom)
    const FN_CITY_MIRROR = mustFieldNameById(cat, 5862997); // Ciudad (custom)
    const FN_AGE = mustFieldNameById(cat, 6244742); // Edad

    // Previsión (canon list): match choice
    const prevKey = normKey(aseguradoraRaw);
    const choices = cat.listChoicesByFieldId.get(6373567) || new Map();
    const choice = choices.get(prevKey);
    if (!choice) {
      return out(400, 'INVALID_ASEGURADORA', `Aseguradora/Previsión inválida: "${aseguradoraRaw}". Debe ser una de las opciones del campo Previsión (list).`, {
        allowed: Array.from(choices.values()).map((c) => c.name),
      });
    }

    // Dirección compuesta (DIRECCION + COMUNA)
    const addressLine1 = comuna ? `${direccion}, ${comuna}` : direccion;

    const age = calcAgeFromDobDDMMYYYY(fechaNacimiento);

// Vista previa (para humanos): qué se intentaría guardar
const vista_previa = {
  rut_normalizado: rutNoDashLower,
  rut_o_id: rutHuman,
  nombres,
  apellidos,
  fecha_nacimiento: fechaNacimiento,
  telefono1: telefono1,
  telefono2: telefono2,
  email: email,
  aseguradora: choice.name,
  modalidad: modalidad,
  direccion: addressLine1,
  comuna: comuna || ERROR_COMUNA,
};

const detalle_tecnico = debug ? { payload: null } : undefined;

    // Anti-duplicados por RUT_normalizado
    const contactSearchApiId = await resolveSearchApiId('contacts', FN_RUT_NORM);
    const valuesToMatch = Array.from(new Set([
      rutNoDashLower,
      rutNoDashUpper,
      norm.normalized,      // legacy with dash
      norm.normalizedNoDash // legacy without dash (upper)
    ]));

    const existing = await searchContactsByCustomField(contactSearchApiId, valuesToMatch, 10);

    if (existing.length > 1) {
      return out(409, 'DUPLICATE_CONTACT_RUT', 'Este RUT ya está duplicado en Sell (hay 2 o más contactos). No se puede crear otro hasta resolverlo.', {
        rut_input: rutInput,
        rut_normalizado: rutNoDashLower,
        rut_humano: rutHuman,
            vista_previa,
            detalle_tecnico,
        contacts: existing.map((c) => ({
          id: c.id,
          display_name: c.display_name,
          desktop_url: deskContactUrl(c.id),
          mobile_url: mobileContactUrl(c.id),
        })),
      });
    }
    if (existing.length === 1) {
      const c = existing[0];
      return out(409, 'CONTACT_EXISTS', 'Ya existe un contacto con este RUT. No se creará otro.', {
        rut_input: rutInput,
        rut_normalizado: rutNoDashLower,
        rut_humano: rutHuman,
            vista_previa,
            detalle_tecnico,
        contact: {
          id: c.id,
          display_name: c.display_name,
          desktop_url: deskContactUrl(c.id),
          mobile_url: mobileContactUrl(c.id),
        },
      });
    }

    // Construir custom_fields (por NOMBRE, no por ID)
    const custom_fields = {};
    custom_fields[FN_RUT_NORM] = rutNoDashLower;  // CANON
    custom_fields[FN_RUT_HUMAN] = rutHuman;       // ESPEJO humano

    // Fecha de nacimiento (DD/MM/YYYY según tu verificación)
    custom_fields[FN_DOB] = fechaNacimiento;
    custom_fields[FN_DOB_1] = fechaNacimiento;

    // Previsión list (en v2 suele leerse como string; intentamos string y si falla, retry con objeto)
    custom_fields[FN_PREV_LIST] = choice.name;
    custom_fields[FN_PREV_STR] = choice.name;
    custom_fields[FN_PREV_1] = choice.name;

    // Espejos
    custom_fields[FN_EMAIL_MIRROR] = email;
    custom_fields[FN_PHONE_MIRROR] = telefono1;
    custom_fields[FN_CITY_MIRROR] = comuna || ERROR_COMUNA;
    if (age !== null) custom_fields[FN_AGE] = String(age);



    const payload = {
      data: {
        is_organization: false,
        first_name: nombres,
        last_name: apellidos,
        email: email,
        phone: telefono1,
        mobile: telefono2,
        address: {
          line1: addressLine1,
          city: comuna || ERROR_COMUNA,
          country: 'CL',
        },
        custom_fields,
      },
    };
    if (debug) { detalle_tecnico.payload = payload; }


    if (dryRun) {
      return out(200, null, 'DRY_RUN: payload construido (no se creó contacto).', {
        rut_input: rutInput,
        rut_normalizado: rutNoDashLower,
        rut_humano: rutHuman,
        comuna,
        payload,
      });
    }

    // Create
    try {
      const created = await createContact(payload);
      return out(201, null, 'Contacto creado.', {
        contact: {
          id: created.id,
          display_name: created.name || `${created.first_name || ''} ${created.last_name || ''}`.trim(),
          desktop_url: deskContactUrl(created.id),
          mobile_url: mobileContactUrl(created.id),
        },
        rut_normalizado: rutNoDashLower,
        rut_humano: rutHuman,
      });
    } catch (e) {
      // Retry list format as object {id,name} if Sell rejects string for list (rare, but safe)
      const msg = String(e.message || '');
      if (msg.includes('422') || msg.includes('schema_validation_failed') || msg.includes('unprocessable')) {
        payload.data.custom_fields[FN_PREV_LIST] = { id: choice.id, name: choice.name };
        const created = await createContact(payload);
        return out(201, null, 'Contacto creado.', {
          contact: {
            id: created.id,
            display_name: created.name || `${created.first_name || ''} ${created.last_name || ''}`.trim(),
            desktop_url: deskContactUrl(created.id),
            mobile_url: mobileContactUrl(created.id),
          },
          rut_normalizado: rutNoDashLower,
          rut_humano: rutHuman,
        });
      }
      throw e;
    }
  } catch (err) {
    const status =
      err && (err.code === 'INVALID_RUT_DV' || err.code === 'MISSING_RUT_DV')
        ? 400
        : err && err.http_status
          ? err.http_status
          : 500;

    return out(status, err.code || 'ERROR', err.message || String(err), {
      details: err.field_id ? { field_id: err.field_id } : undefined,
    });
  }
});


app.post('/api/create-deal', async (req, res) => {
  const dryRun = String(req.query.dry_run || '').toLowerCase() === '1' || String(req.query.dry_run || '').toLowerCase() === 'true';
  const debug = String(req.query.debug || '').toLowerCase() === '1' || String(req.query.debug || '').toLowerCase() === 'true';

  // Safety switch (unless dry-run)
  if (!dryRun && String(process.env.ALLOW_WRITE || 'false').toLowerCase() !== 'true') {
    return res.status(403).json({
      ok: false,
      status: 403,
      error: 'WRITE_DISABLED',
      message: 'Creación deshabilitada en este entorno (ALLOW_WRITE != true).',
    });
  }

  const out = (status, error = null, message = null, extra = {}) => {
    return res.status(status).json({
      ok: status < 400,
      status,
      error,
      message,
      ...extra,
    });
  };

  try {
    const body = req.body || {};

    const contactId = Number(body.contact_id || body.contactId || body.contact?.id);
    const ownerId = Number(body.owner_id || body.ownerId || body.owner?.id);
    const pipelineIdRaw = body.pipeline_id ?? body.pipelineId ?? body.pipeline_id_checked ?? body.pipelineIdChecked ?? null;
    const pipelineId = (pipelineIdRaw === null || pipelineIdRaw === undefined || pipelineIdRaw === '') ? null : Number(pipelineIdRaw);
    if (pipelineIdRaw !== null && pipelineIdRaw !== undefined && pipelineIdRaw !== '' && !Number.isFinite(pipelineId)) {
      return out(400, 'INVALID_PIPELINE_ID', 'Pipeline ID inválido (debe ser numérico).');
    }
    if (!Number.isFinite(pipelineId) || pipelineId <= 0) return out(400, 'MISSING_PIPELINE_ID', 'Debes seleccionar un pipeline_id para crear el Deal.');

    const rutInput = cleanValue(body.rut || body.run || body.RUN || body.rut_o_id || body.rut_humano);
    const nombres = cleanValue(body.nombres || body.Nombres);
    const apellidos = cleanValue(body.apellidos || body.Apellidos);
    const aseguradoraRaw = cleanValue(body.aseguradora || body.prevision || body['Aseguradora'] || body['Previsión'] || body['Prevision']);
    const modalidadRaw = cleanValue(body.modalidad || body['Modalidad'] || body['Tramo/Modalidad'] || body.tramo_modalidad);
    const comunaInput = cleanValue(body.comuna || body['Comuna']);
    const comuna = canonicalComuna(comunaInput);

const estaturaRaw = cleanValue(body.estatura || body['Estatura']);
const pesoRaw = cleanValue(body.peso || body['Peso']);
const interes = cleanValue(body.interes || body['Interés'] || body['Interes']);
const urlMedinet = cleanValue(body.url_medinet || body.urlMedinet || body['URL-MEDINET']);
const sucursal = cleanValue(body.sucursal || body['SUCURSAL'] || body['Sucursal']);
const cirugiasPrevias = cleanValue(body.cirugias_previas || body['Cirugías Previas'] || body['Cirugias Previas']);
const colaborador1 = cleanValue(body.colaborador1 || body['Colaborador1']);
const colaborador2 = cleanValue(body.colaborador2 || body['Colaborador2']);
const colaborador3 = cleanValue(body.colaborador3 || body['Colaborador3']);
const validacionPad = cleanValue(body.validacion_pad || body['Validacion PAD']);
const numFamiliaPaciente = cleanValue(body.numero_familia_paciente || body['Numero familia paciente']);

const cirujanoBariatrico = cleanValue(body.cirujano_bariatrico || body['CIRUJANO BARIÁTRICO'] || body['CIRUJANO BARIATRICO']);
const cirujanoPlastico = cleanValue(body.cirujano_plastico || body['CIRUJANO PLASTICO']);
const cirujanoBalon = cleanValue(body.cirujano_balon || body['CIRUJANO DE BALON']);

    if (!Number.isFinite(contactId) || contactId <= 0) return out(400, 'MISSING_CONTACT_ID', 'Falta contact_id para asociar el Deal.');
    if (!Number.isFinite(ownerId) || ownerId <= 0) return out(400, 'MISSING_OWNER_ID', 'Debes seleccionar un Dueño para el Deal.');
    if (!rutInput) return out(400, 'MISSING_RUT', 'Debes ingresar un RUN/RUT.');
    if (!aseguradoraRaw) return out(400, 'MISSING_ASEGURADORA', 'Falta Aseguradora/Previsión.');

    const norm = normalizeRut(rutInput);
    const rutNoDashUpper = norm.normalizedNoDash;
    const rutNoDashLower = String(rutNoDashUpper).toLowerCase();
    const rutHuman = formatRutHumanFromNoDashLower(rutNoDashLower);

    // Deal catalog
    const dcat = await getDealCatalog();

    // Canonical required fields (by ID)
    const DF_RUT_NORM = mustFieldNameById(dcat, 2759433); // RUT_normalizado (deal)
    const DF_PREV_LIST = mustFieldNameById(dcat, 2761582); // Previsión (deal, list)

    // Optional: modalidad / comuna (by name match)
    const DF_MODALIDAD = findDealFieldNameByNorm(dcat, [
      normKey('Modalidad'),
      normKey('Tramo/Modalidad'),
      normKey('Tramo Modalidad'),
    ]);
    const DF_COMUNA = findDealFieldNameByNorm(dcat, [
      normKey('Comuna'),
      normKey('Ciudad'),
    ]);

const DF_RUT_O_ID = findDealFieldNameByNorm(dcat, [normKey('RUT o ID')]);
const DF_CORREO = findDealFieldNameByNorm(dcat, [normKey('Correo electrónico'), normKey('Correo electronico')]);
const DF_TELEFONO = findDealFieldNameByNorm(dcat, [normKey('Teléfono'), normKey('Telefono')]);
const DF_FECHA_NAC = findDealFieldNameByNorm(dcat, [normKey('Fecha Nacimiento'), normKey('Fecha Nacimiento#1')]);
const DF_CIUDAD = findDealFieldNameByNorm(dcat, [normKey('Ciudad'), normKey('Comuna')]);
const DF_ESTATURA = findDealFieldNameByNorm(dcat, [normKey('Estatura')]);
const DF_PESO = findDealFieldNameByNorm(dcat, [normKey('Peso')]);
const DF_IMC = findDealFieldNameByNorm(dcat, [normKey('IMC'), normKey('Imc')]);
const DF_EDAD = findDealFieldNameByNorm(dcat, [normKey('EDAD'), normKey('Edad')]);
const DF_FECHA_INGRESA = findDealFieldNameByNorm(dcat, [normKey('Fecha Ingresa Formulario')]);
const DF_URL_MEDINET = findDealFieldNameByNorm(dcat, [normKey('URL-MEDINET')]);
const DF_SUCURSAL = findDealFieldNameByNorm(dcat, [normKey('SUCURSAL'), normKey('Sucursal')]);
const DF_INTERES = findDealFieldNameByNorm(dcat, [normKey('Interés'), normKey('Interes'), normKey('INTERES')]);
const DF_CIRUGIAS_PREVIAS = findDealFieldNameByNorm(dcat, [normKey('Cirugías Previas'), normKey('Cirugias Previas')]);
const DF_WHATSAPP = findDealFieldNameByNorm(dcat, [normKey('WhatsApp_Contactar_LINK'), normKey('WhatsApp Contactar LINK')]);
const DF_COLAB1 = findDealFieldNameByNorm(dcat, [normKey('Colaborador1')]);
const DF_COLAB2 = findDealFieldNameByNorm(dcat, [normKey('Colaborador2')]);
const DF_COLAB3 = findDealFieldNameByNorm(dcat, [normKey('Colaborador3')]);
const DF_VALIDACION_PAD = findDealFieldNameByNorm(dcat, [normKey('Validacion PAD')]);
const DF_NUM_FAMILIA = findDealFieldNameByNorm(dcat, [normKey('Numero familia paciente')]);
const DF_CIR_BARI = findDealFieldNameByNorm(dcat, [normKey('CIRUJANO BARIÁTRICO'), normKey('CIRUJANO BARIATRICO')]);
const DF_CIR_PLAST = findDealFieldNameByNorm(dcat, [normKey('CIRUJANO PLASTICO')]);
const DF_CIR_BALON = findDealFieldNameByNorm(dcat, [normKey('CIRUJANO DE BALON')]);


    // Match previsión choice
    const prevKey = normKey(aseguradoraRaw);
    const dChoices = dcat.listChoicesByFieldId.get(2761582) || new Map();
    const dChoice = dChoices.get(prevKey);
    if (!dChoice) {
      return out(400, 'INVALID_ASEGURADORA', `Aseguradora/Previsión inválida para Deal: "${aseguradoraRaw}".`, {
        allowed: Array.from(dChoices.values()).map((c) => c.name),
      });
    }

    const custom_fields = {};
    custom_fields[DF_RUT_NORM] = rutNoDashLower;
    custom_fields[DF_PREV_LIST] = dChoice.name;


// Mirrors / additional info for Medinet & operations
if (DF_RUT_O_ID) custom_fields[DF_RUT_O_ID] = rutHuman;
if (DF_CORREO && body.email) custom_fields[DF_CORREO] = cleanValue(body.email);
if (DF_TELEFONO) custom_fields[DF_TELEFONO] = cleanValue(body.telefono1 || body.telefono || body['Teléfono'] || body['Telefono'] || body.phone1 || '');
if (DF_FECHA_NAC && body.fecha_nacimiento) custom_fields[DF_FECHA_NAC] = cleanValue(body.fecha_nacimiento);
if (DF_CIUDAD && comuna) custom_fields[DF_CIUDAD] = comuna;

if (DF_ESTATURA && estaturaRaw) custom_fields[DF_ESTATURA] = estaturaRaw;
if (DF_PESO && pesoRaw) custom_fields[DF_PESO] = pesoRaw;
if (DF_IMC && imcStr) custom_fields[DF_IMC] = imcStr;
if (DF_EDAD && edadStr) custom_fields[DF_EDAD] = edadStr;
if (DF_FECHA_INGRESA) custom_fields[DF_FECHA_INGRESA] = fechaIngresaFormulario;

if (DF_URL_MEDINET && urlMedinet) custom_fields[DF_URL_MEDINET] = urlMedinet;
if (DF_INTERES && interes) custom_fields[DF_INTERES] = interes;
if (DF_CIRUGIAS_PREVIAS && cirugiasPrevias) custom_fields[DF_CIRUGIAS_PREVIAS] = cirugiasPrevias;

if (DF_WHATSAPP && whatsappLink) custom_fields[DF_WHATSAPP] = whatsappLink;

if (DF_COLAB1 && colaborador1) custom_fields[DF_COLAB1] = colaborador1;
if (DF_COLAB2 && colaborador2) custom_fields[DF_COLAB2] = colaborador2;
if (DF_COLAB3 && colaborador3) custom_fields[DF_COLAB3] = colaborador3;

if (DF_VALIDACION_PAD && validacionPad) custom_fields[DF_VALIDACION_PAD] = validacionPad;
if (DF_NUM_FAMILIA && numFamiliaPaciente) custom_fields[DF_NUM_FAMILIA] = numFamiliaPaciente;

// Surgeon fields are lists in Sell; store by name (Sell accepts name, and we retry {id,name} on 422 for Previsión already)
if (DF_CIR_BARI && cirujanoBariatrico) custom_fields[DF_CIR_BARI] = cirujanoBariatrico;
if (DF_CIR_PLAST && cirujanoPlastico) custom_fields[DF_CIR_PLAST] = cirujanoPlastico;
if (DF_CIR_BALON && cirujanoBalon) custom_fields[DF_CIR_BALON] = cirujanoBalon;

// Sucursal: fixed list; stored as string
if (DF_SUCURSAL && sucursal) custom_fields[DF_SUCURSAL] = sucursal;

    if (DF_MODALIDAD && modalidadRaw) custom_fields[DF_MODALIDAD] = modalidadRaw;
    if (DF_COMUNA && comuna) custom_fields[DF_COMUNA] = comuna;

    const dealName = cleanValue(body.deal_name) || `BOX - ${[nombres, apellidos].filter(Boolean).join(' ')}`.trim() || `BOX - ${rutHuman}`;

    
const pesoNum = parseNumDot(pesoRaw);
const estaturaNum = parseNumDot(estaturaRaw);
const imcCalc = calcImc(pesoNum, estaturaNum);
const imcStr = (imcCalc === null) ? null : imcCalc.toFixed(2);
const imcClasif = (imcCalc === null) ? null : classifyImc(imcCalc);
const edadCalc = calcEdadFromDDMMYYYY(cleanValue(body.fecha_nacimiento || body.fechaNacimiento || body['Fecha Nacimiento'] || body['Fecha Nacimiento']));
const edadStr = (edadCalc === null) ? null : String(edadCalc);
const whatsappLink = waLinkFromPhone(cleanValue(body.telefono1 || body.telefono_1 || body['Teléfono 1'] || body['Telefono 1'] || body.phone1 || body.telefono || body['Teléfono']));
const fechaIngresaFormulario = isoDateToday();

const vista_previa = {
      deal_name: dealName,
      contact_id: contactId,
      rut_normalizado: rutNoDashLower,
      rut_humano: rutHuman,
      aseguradora: dChoice.name,
      modalidad: modalidadRaw || null,
      comuna: comuna || ERROR_COMUNA,
      custom_fields,
      estatura: estaturaRaw || null,
      peso: pesoRaw || null,
      edad: edadStr,
      imc: imcStr,
      imc_clasificacion: imcClasif,
      sucursal: sucursal || null,
      interes: interes || null,
      url_medinet: urlMedinet || null,
      cirugias_previas: cirugiasPrevias || null,
      whatsapp_link: whatsappLink,
      fecha_ingresa_formulario: fechaIngresaFormulario,
      colaborador1: colaborador1 || null,
      colaborador2: colaborador2 || null,
      colaborador3: colaborador3 || null,
      validacion_pad: validacionPad || null,
      numero_familia_paciente: numFamiliaPaciente || null,
      cirujano_bariatrico: cirujanoBariatrico || null,
      cirujano_plastico: cirujanoPlastico || null,
      cirujano_balon: cirujanoBalon || null,

    };

    const detalle_tecnico = debug ? { payload: null } : undefined;

    // Anti-duplicados por RUT_normalizado en deals (por pipeline)
    // Regla: no puede existir 2 deals con el mismo RUT_normalizado dentro del mismo pipeline.
    const dealSearchApiId = await resolveSearchApiId('deals', DF_RUT_NORM);
    const valuesToMatch = Array.from(new Set([
      rutNoDashLower,
      rutNoDashUpper,
      norm.normalized,
      norm.normalizedNoDash
    ]));
    const existingDeals = await searchDealsByCustomField(dealSearchApiId, valuesToMatch, 100);

    let dealsSamePipeline = [];
    if (existingDeals.length > 0 && Number.isFinite(pipelineId) && pipelineId > 0) {
      // Derivar pipeline por stage_id
      const dealIds = existingDeals.map((d) => d.id).filter(Boolean).slice(0, 50);
      const dealDetails = await getDealsByIds(dealIds);
      const stageIds = dealDetails.map((d) => d.stage_id).filter(Boolean);
      const stages = await getStagesByIds(stageIds);
      const stageById = new Map(stages.map((s) => [s.id, s]));
      dealsSamePipeline = dealDetails
        .filter((d) => {
          const st = stageById.get(d.stage_id);
          return st && st.pipeline_id === pipelineId;
        })
        .map((d) => ({
          id: d.id,
          name: d.name,
          contact_id: d.contact_id,
          stage_id: d.stage_id,
          desktop_url: deskDealUrl(d.id),
          mobile_url: mobileDealUrl(d.id),
        }));
    } else if (existingDeals.length > 0 && !Number.isFinite(pipelineId)) {
      // Sin pipeline no podemos aplicar la regla por pipeline => avisamos
      // (pero NO bloqueamos aquí, solo dejamos warning y dejamos que se cree según el stage seleccionado)
    }

    if (dealsSamePipeline.length > 0) {
      return out(409, 'DEAL_EXISTS_IN_PIPELINE',
        '🚨 Revisar y Trabajar Zendesk Sell 🚨 Ya existe al menos 1 deal en el mismo pipeline con este RUT_normalizado. No se creará otro.',
        {
          rut_input: rutInput,
          pipeline_id: pipelineId,
          rut_normalizado: rutNoDashLower,
          rut_humano: rutHuman,
          vista_previa,
          detalle_tecnico,
          warning_banner: '🚨 Revisar y Trabajar Zendesk Sell 🚨',
          deals: dealsSamePipeline,
        }
      );
    }

    // Determinar stage_id para creación (stage define el pipeline)
    let stageId = null;
    if (Number.isFinite(pipelineId) && pipelineId > 0) {
      if (pipelineId === 1290779) {
        stageId = 10693252; // Bariátrica - CANDIDATO
      } else {
        // Mapping opcional por env: STAGE_BY_PIPELINE="4823817:12345,4959507:67890"
        const mapStr = String(process.env.STAGE_BY_PIPELINE || '');
        const pairs = mapStr.split(',').map((s) => s.trim()).filter(Boolean);
        for (const pair of pairs) {
          const [pid, sid] = pair.split(':').map((x) => String(x).trim());
          if (Number(pid) === pipelineId && sid) stageId = Number(sid);
        }
        if (!stageId) {
          stageId = await getFirstStageIdForPipeline(pipelineId);
        }
      }
    }

    const payload = { data: { name: dealName, contact_id: contactId, owner_id: ownerId, custom_fields,
      estatura: estaturaRaw || null,
      peso: pesoRaw || null,
      edad: edadStr,
      imc: imcStr,
      imc_clasificacion: imcClasif,
      sucursal: sucursal || null,
      interes: interes || null,
      url_medinet: urlMedinet || null,
      cirugias_previas: cirugiasPrevias || null,
      whatsapp_link: whatsappLink,
      fecha_ingresa_formulario: fechaIngresaFormulario,
      colaborador1: colaborador1 || null,
      colaborador2: colaborador2 || null,
      colaborador3: colaborador3 || null,
      validacion_pad: validacionPad || null,
      numero_familia_paciente: numFamiliaPaciente || null,
      cirujano_bariatrico: cirujanoBariatrico || null,
      cirujano_plastico: cirujanoPlastico || null,
      cirujano_balon: cirujanoBalon || null,
 ...(stageId ? { stage_id: stageId } : {}) } };
    if (debug) detalle_tecnico.payload = payload;

    if (dryRun) {
      return out(200, null, 'Vista previa de Deal (dry_run).', { vista_previa, detalle_tecnico });
    }

    try {
      const created = await createDeal(payload);
      return out(201, null, 'Deal creado.', {
        deal: {
          id: created.id,
          name: created.name || dealName,
          desktop_url: deskDealUrl(created.id),
          mobile_url: mobileDealUrl(created.id),
        },
        contact_id: contactId,
        rut_normalizado: rutNoDashLower,
        rut_humano: rutHuman,
      });
    } catch (e) {
      // If list format rejected, retry with {id,name}
      const msg = String(e.message || '');
      if (msg.includes('422') || msg.includes('schema_validation_failed') || msg.includes('unprocessable')) {
        payload.data.custom_fields[DF_PREV_LIST] = { id: dChoice.id, name: dChoice.name };
        const created = await createDeal(payload);
        return out(201, null, 'Deal creado.', {
          deal: {
            id: created.id,
            name: created.name || dealName,
            desktop_url: deskDealUrl(created.id),
            mobile_url: mobileDealUrl(created.id),
          },
          contact_id: contactId,
          rut_normalizado: rutNoDashLower,
          rut_humano: rutHuman,
        });
      }
      throw e;
    }
  } catch (err) {
    const status =
      err && (err.code === 'INVALID_RUT_DV' || err.code === 'MISSING_RUT_DV')
        ? 400
        : err && err.http_status
          ? err.http_status
          : 500;

    return res.status(status).json({
      ok: false,
      status,
      error: err.code || 'ERROR',
      message: err.message || String(err),
      details: err.field_id ? { field_id: err.field_id } : undefined,
    });
  }
});


// -------------------------
// Docs generation (Drive templates -> PDFs)
// -------------------------
function slugifyName(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'template';
}

function getTemplateFolderId() {
  const v = String(process.env.TEMPLATE_FOLDER_ID || process.env.DOC_TEMPLATES_FOLDER_ID || '').trim();
  return v || null;
}

// Cache templates listing to avoid hitting Drive too often
let TEMPLATE_CACHE = null;
let TEMPLATE_CACHE_AT = 0;
const TEMPLATE_TTL_MS = 5 * 60 * 1000; // 5 min

async function getTemplatesFromDriveFolder(force = false, folderIdOverride = null) {
  const folderId = String(folderIdOverride || getTemplateFolderId() || '').trim();
  if (!folderId) return null;

  const now = Date.now();
  if (!force && TEMPLATE_CACHE && (now - TEMPLATE_CACHE_AT) < TEMPLATE_TTL_MS && TEMPLATE_CACHE.folder_id === folderId) {
    return TEMPLATE_CACHE;
  }

  const items = await listTemplatesInFolder({ folderId });
  const mapped = items.map(it => ({
    id: it.id,
    name: it.name,
    slug: slugifyName(it.name),
    docs_url: it.docs_url,
    modifiedTime: it.modifiedTime,
  }));

  TEMPLATE_CACHE = { folder_id: folderId, items: mapped };
  TEMPLATE_CACHE_AT = now;
  return TEMPLATE_CACHE;
}

function parseDocTemplatesEnv() {
  const raw = String(process.env.DOC_TEMPLATES_JSON || '').trim();
  if (!raw) {
    const err = new Error('Falta DOC_TEMPLATES_JSON (map doc_type -> template_file_id)');
    err.code = 'MISSING_DOC_TEMPLATES_JSON';
    throw err;
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') throw new Error('DOC_TEMPLATES_JSON no es objeto');
    return obj;
  } catch (e) {
    const err = new Error(`DOC_TEMPLATES_JSON inválido: ${e.message || String(e)}`);
    err.code = 'INVALID_DOC_TEMPLATES_JSON';
    throw err;
  }
}

function parseDocTemplatesEnvOptional() {
  const raw = String(process.env.DOC_TEMPLATES_JSON || '').trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch (_e) {
    return null;
  }
}

function isWriteEnabledForDocs() {
  return String(process.env.ALLOW_DOCS_WRITE || process.env.ALLOW_WRITE || 'false').toLowerCase() === 'true';
}

function safeName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function buildPatientFolderName({ rutHuman, rutNormNoDash, firstName, lastName }) {
  const rutPart = safeName(rutHuman || rutNormNoDash || '').replace(/\*/g, '');
  const namePart = safeName(`${firstName || ''} ${lastName || ''}`);
  return safeName(`${rutPart} - ${namePart}`) || `PACIENTE-${Date.now()}`;
}

function isoDateTodayLocal() {
  return new Date().toISOString().slice(0, 10);
}

app.get('/api/deal-context', async (req, res) => {
  try {
    const dealId = Number(req.query.deal_id || req.query.dealId || '');
    if (!Number.isFinite(dealId) || dealId <= 0) {
      return res.status(400).json({ ok: false, status: 400, error: 'INVALID_DEAL_ID', message: 'deal_id inválido' });
    }

    const deal = await getDealById(dealId);
    const contactId = deal?.contact_id || deal?.contact?.id || deal?.primary_contact_id;
    if (!contactId) {
      return res.status(404).json({ ok: false, status: 404, error: 'MISSING_CONTACT', message: 'Deal no tiene contact_id asociado' });
    }
    const contact = await getContactById(contactId);

    return res.status(200).json({
      ok: true,
      status: 200,
      deal: {
        id: dealId,
        name: deal?.name || null,
        pipeline_id: deal?.pipeline_id || null,
        stage_id: deal?.stage_id || null,
        desktop_url: deskDealUrl(dealId),
        mobile_url: mobileDealUrl(dealId),
      },
      contact: {
        id: contactId,
        display_name: contact?.name || `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim(),
        first_name: contact?.first_name || null,
        last_name: contact?.last_name || null,
        email: contact?.email || null,
        phone: contact?.phone || null,
        mobile: contact?.mobile || null,
        address: contact?.address || null,
        desktop_url: deskContactUrl(contactId),
        mobile_url: mobileContactUrl(contactId),
      },
    });
  } catch (err) {
    console.error('deal-context error', err);
    return res.status(500).json({ ok: false, status: 500, error: err.code || 'ERROR', message: err.message || String(err) });
  }
});

app.get('/api/docs/templates', async (req, res) => {
  try {
    const folderId = String(req.query.folder_id || req.query.folderId || '').trim() || null;
    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
    const data = await getTemplatesFromDriveFolder(force, folderId);
    if (!data) {
      return res.status(400).json({ ok: false, status: 400, error: 'MISSING_TEMPLATE_FOLDER_ID', message: 'Falta TEMPLATE_FOLDER_ID (o env DOC_TEMPLATES_FOLDER_ID), o enviar ?folder_id=' });
    }
    // Compute defaults from DOC_DEFAULT_TYPES (as slugs or ids)
const requested = String(process.env.DOC_DEFAULT_TYPES || '').trim()
  ? String(process.env.DOC_DEFAULT_TYPES).split(',').map(x => x.trim()).filter(Boolean)
  : [];
let default_selected_ids = [];
if (requested.length) {
  const byId = new Map(data.items.map(it => [it.id, it]));
  const bySlug = new Map(data.items.map(it => [it.slug, it]));
  for (const r of requested) {
    const hit = byId.get(r) || bySlug.get(slugifyName(r)) || bySlug.get(r);
    if (hit) default_selected_ids.push(hit.id);
  }
}

return res.status(200).json({
  ok: true,
  status: 200,
  folder_id: data.folder_id,
  count: data.items.length,
  items: data.items,
  default_selected_ids,
});
  } catch (err) {
    console.error('docs/templates error', err);
    return res.status(500).json({ ok: false, status: 500, error: err.code || 'ERROR', message: err.message || String(err) });
  }
});

app.post('/api/docs/generate-batch', async (req, res) => {
  const dryRun = String(req.query.dry_run || req.body?.dry_run || '').toLowerCase() === '1' || String(req.query.dry_run || req.body?.dry_run || '').toLowerCase() === 'true';

  if (!dryRun && !isWriteEnabledForDocs()) {
    return res.status(403).json({
      ok: false,
      status: 403,
      error: 'WRITE_DISABLED',
      message: 'Generación deshabilitada (ALLOW_DOCS_WRITE/ALLOW_WRITE != true).',
    });
  }

  try {
    const dealId = Number(req.body?.deal_id || req.body?.dealId || '');
    if (!Number.isFinite(dealId) || dealId <= 0) {
      return res.status(400).json({ ok: false, status: 400, error: 'INVALID_DEAL_ID', message: 'deal_id inválido' });
    }

// Templates selection priority:
// 1) req.body.templates = [{file_id, name}] (best for "folder mode" UI)
// 2) req.body.template_file_ids = ["1abc...", ...]
// 3) req.body.doc_types + DOC_TEMPLATES_JSON mapping (legacy mode)
// 4) TEMPLATE_FOLDER_ID + (DOC_DEFAULT_TYPES as slugs) else all templates in folder
const templatesFromEnv = parseDocTemplatesEnvOptional();
const templateFolderId = getTemplateFolderId();

const templatesPayload = Array.isArray(req.body?.templates) ? req.body.templates : null;
const templateFileIdsPayload = Array.isArray(req.body?.template_file_ids) ? req.body.template_file_ids : null;

let jobs = []; // { label, template_file_id }

if (templatesPayload && templatesPayload.length) {
  jobs = templatesPayload
    .map(t => ({ label: safeName(t.name || t.label || ''), template_file_id: String(t.file_id || t.id || '').trim() }))
    .filter(x => x.template_file_id);
} else if (templateFileIdsPayload && templateFileIdsPayload.length) {
  jobs = templateFileIdsPayload
    .map(id => ({ label: null, template_file_id: String(id).trim() }))
    .filter(x => x.template_file_id);
} else if (templatesFromEnv) {
  const docTypes = Array.isArray(req.body?.doc_types) && req.body.doc_types.length
    ? req.body.doc_types.map(String)
    : (String(process.env.DOC_DEFAULT_TYPES || '').trim()
        ? String(process.env.DOC_DEFAULT_TYPES).split(',').map(x => x.trim()).filter(Boolean)
        : Object.keys(templatesFromEnv));

  for (const k of docTypes) {
    const templateFileId = templatesFromEnv[k];
    if (templateFileId) jobs.push({ label: k, template_file_id: String(templateFileId) });
  }
} else if (templateFolderId) {
  const data = await getTemplatesFromDriveFolder(false, null);
  const items = data?.items || [];
  const requested = Array.isArray(req.body?.doc_types) && req.body.doc_types.length
    ? req.body.doc_types.map(String)
    : (String(process.env.DOC_DEFAULT_TYPES || '').trim()
        ? String(process.env.DOC_DEFAULT_TYPES).split(',').map(x => x.trim()).filter(Boolean)
        : []);

  if (requested.length) {
    const byId = new Map(items.map(it => [it.id, it]));
    const bySlug = new Map(items.map(it => [it.slug, it]));
    for (const r of requested) {
      const hit = byId.get(r) || bySlug.get(slugifyName(r)) || bySlug.get(r);
      if (hit) jobs.push({ label: hit.name, template_file_id: hit.id });
    }
  } else {
    // default: all templates in folder
    jobs = items.map(it => ({ label: it.name, template_file_id: it.id }));
  }
}

if (!jobs.length) {
  return res.status(400).json({
    ok: false,
    status: 400,
    error: 'MISSING_TEMPLATES',
    message: 'No hay templates seleccionados. Configura TEMPLATE_FOLDER_ID o DOC_TEMPLATES_JSON, o envía templates/template_file_ids en el request.',
  });
}

    // 1) Fetch deal + contact
    const deal = await getDealById(dealId);
    const contactId = deal?.contact_id || deal?.contact?.id || deal?.primary_contact_id;
    if (!contactId) {
      return res.status(404).json({ ok: false, status: 404, error: 'MISSING_CONTACT', message: 'Deal no tiene contact_id asociado' });
    }
    const contact = await getContactById(contactId);

    // 2) Resolve custom field names (by ID) to read consistent values
    const cCat = await getContactCatalog();
    const FN_RUT_NORM = mustFieldNameById(cCat, 6265931); // RUT_normalizado
    const FN_RUT_HUMAN = mustFieldNameById(cCat, 5883525); // RUT o ID
    const FN_DOB = mustFieldNameById(cCat, 5863844); // Fecha Nacimiento
    const FN_DOB_1 = mustFieldNameById(cCat, 6236073); // Fecha Nacimiento#1
    const FN_PREV_LIST = mustFieldNameById(cCat, 6373567); // Previsión (list)
    const FN_PREV_STR = mustFieldNameById(cCat, 5853892); // Previsión##

    const ccf = contact?.custom_fields || {};
    const rutNormNoDash = ccf[FN_RUT_NORM] || null; // e.g. 16927228k
    const rutHuman = ccf[FN_RUT_HUMAN] || (rutNormNoDash ? formatRutHumanFromNoDashLower(String(rutNormNoDash).toLowerCase()) : null);
    const dob = ccf[FN_DOB] || ccf[FN_DOB_1] || null;
    const prevision = ccf[FN_PREV_LIST] || ccf[FN_PREV_STR] || null;

    const folderName = buildPatientFolderName({
      rutHuman,
      rutNormNoDash,
      firstName: contact?.first_name,
      lastName: contact?.last_name,
    });

    // 3) Ensure patient folder
    const driveInfo = await ensurePatientFolders({ folderName });

    const placeholdersBase = {
      RUT: rutHuman || '',
      RUT_NORMALIZADO: rutNormNoDash || '',
      NOMBRES: contact?.first_name || '',
      APELLIDOS: contact?.last_name || '',
      NOMBRE: contact?.first_name || '',
      APELLIDO: contact?.last_name || '',
      RUT_O_ID: rutHuman || '',
      TELEFONO: contact?.phone || '',
      NOMBRE_COMPLETO: safeName(`${contact?.first_name || ''} ${contact?.last_name || ''}`),
      FECHA_NACIMIENTO: dob || '',
      EMAIL: contact?.email || '',
      TELEFONO1: contact?.phone || '',
      TELEFONO2: contact?.mobile || contact?.phone || '',
      DIRECCION: (typeof contact?.address === 'string' ? contact.address : (contact?.address?.line1 || contact?.address?.line_1 || contact?.address?.line || '')),
      
      COMUNA: contact?.address?.city || '',
      PREVISION: prevision || '',
      DEAL_ID: String(dealId),
      CONTACT_ID: String(contactId),
      DEAL_NAME: deal?.name || '',
      DEAL_URL: deskDealUrl(dealId),
      CONTACT_URL: deskContactUrl(contactId),
      FECHA_HOY: isoDateTodayLocal(),
    };

    const results = [];
    for (const job of jobs) {
      const docType = safeName(job.label || job.doc_type || slugifyName(job.template_file_id));
      const templateFileId = String(job.template_file_id || '').trim();
      if (!templateFileId) {
        results.push({ doc_type: docType, status: 'error', error: 'Missing template_file_id' });
        continue;
      }

      const copyName = safeName(`${docType} - ${folderName} - ${isoDateTodayLocal()}`);

      if (dryRun) {
        results.push({
          doc_type: docType,
          status: 'dry_run',
          template_file_id: templateFileId,
          would_copy_name: copyName,
          would_save_in: driveInfo.docs_folder_id,
          would_export_pdf_to: driveInfo.pdf_folder_id,
        });
        continue;
      }

      // 4) Copy template -> Docs folder
      const copied = await copyTemplateToFolder({
        templateFileId,
        newName: copyName,
        parentFolderId: driveInfo.docs_folder_id,
      });

      // 5) Replace placeholders
      await replacePlaceholdersInDoc({ documentId: copied.id, placeholders: placeholdersBase });

      // 6) Export PDF + upload
      const pdfBuffer = await exportDocAsPdfBuffer({ fileId: copied.id });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pdfName = safeName(`${rutHuman || rutNormNoDash || 'PACIENTE'}_${docType}_${stamp}.pdf`);

      const pdf = await uploadPdfToFolder({
        pdfBuffer,
        pdfName,
        parentFolderId: driveInfo.pdf_folder_id,
      });

      results.push({
        doc_type: docType,
        status: 'done',
        template_file_id: templateFileId,
        doc_file_id: copied.id,
        doc_name: copied.name,
        doc_url: docsEditUrl(copied.id),
        doc_view_url: driveFileUrl(copied.id),
        pdf_file_id: pdf.id,
        pdf_url: driveFileUrl(pdf.id),
        pdf_name: pdfName,
      });
    }

    // 7) Note in Sell (optional)
    const shouldNote = String(req.body?.create_note ?? 'true').toLowerCase() !== 'false';
    let note = null;
    if (!dryRun && shouldNote) {
      const okPdfs = results.filter(r => r.status === 'done' && r.pdf_url);
      const lines = [
        `📄 Documentos generados desde Portal`,
        `Carpeta Drive: ${driveInfo.folder_url}`,
        ...okPdfs.map(r => `• ${r.doc_type}: ${r.pdf_url}`),
      ];
      try {
        note = await createNoteForDeal(dealId, lines.join('\n'));
      } catch (e) {
        note = { error: e.code || 'NOTE_ERROR', message: e.message || String(e) };
      }
    }

    return res.status(200).json({
      ok: true,
      status: 200,
      dry_run: dryRun,
      deal_id: dealId,
      contact_id: contactId,
      patient_folder_id: driveInfo.folder_id,
      patient_folder_url: driveInfo.folder_url,
      folder: {
        name: folderName,
        id: driveInfo.folder_id,
        url: driveInfo.folder_url,
        pdf_folder_id: driveInfo.pdf_folder_id,
        docs_folder_id: driveInfo.docs_folder_id,
      },
      results,
      note,
    });
  } catch (err) {
    console.error('docs/generate-batch error', err);
    return res.status(500).json({
      ok: false,
      status: 500,
      error: err.code || 'ERROR',
      message: err.message || String(err),
    });
  }
});



const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Portal listo en :${port}`));

