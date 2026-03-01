
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// -------------------------
// Helpers
// -------------------------
function $(id) { return document.getElementById(id); }

function cleanText(s) {
  return String(s || '')
    .replace(/\*/g, '')
    .replace(/=/g, ':')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

function normalizeSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const a of arr) {
    const k = String(a || '').trim();
    if (!k) continue;
    const kk = k.toLowerCase();
    if (seen.has(kk)) continue;
    seen.add(kk);
    out.push(k);
  }
  return out;
}

function extractEmailFromLines(lines) {
  for (const ln of lines) {
    const m = ln.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
    if (m) return m[1].trim();
  }
  return '';
}

function extractRutFromLines(lines) {
  for (const ln of lines) {
    const l = ln.trim();
    const labeled = l.match(/\b(?:RUT|RUN)\b\s*[:\-]\s*([0-9kK\.\- ]{7,14})/i);
    if (labeled) return normalizeSpaces(labeled[1]).replace(/\s/g, '');
  }
  for (const ln of lines) {
    const l = ln.trim();
    let m = l.match(/\b(\d{1,2}\.\d{3}\.\d{3}-[0-9kK])\b/);
    if (m) return m[1];
    m = l.match(/\b(\d{7,8}-[0-9kK])\b/);
    if (m) return m[1];
    m = l.match(/\b(\d{7,8}[0-9kK])\b/);
    if (m) return m[1];
  }
  return '';
}

function rutParts(rut) {
  const raw = String(rut || '').toUpperCase().replace(/[^0-9K]/g, '');
  if (raw.length < 2) return { num: '', dv: '' };
  return { num: raw.slice(0, -1), dv: raw.slice(-1) };
}

function parseDobFromLines(lines) {
  // Accept:
  // - DD/MM/YYYY or DD-MM-YYYY
  // - YYYY-MM-DD or YYYY/MM/DD
  // - 22nov1980, 22 nov 1980, 22-nov-1980
  const months = {
    ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
    JUL: '07', AGO: '08', SEP: '09', SET: '09', OCT: '10', NOV: '11', DIC: '12',
  };

  for (const ln of lines) {
    const l = ln.trim();

    // DD/MM/YYYY or DD-MM-YYYY
    let m = l.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
    if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;

    // YYYY-MM-DD or YYYY/MM/DD
    m = l.match(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return `${String(m[3]).padStart(2, '0')}/${String(m[2]).padStart(2, '0')}/${m[1]}`;

    // 22nov1980
    m = l.match(/\b(\d{1,2})\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]{3,})\s*(\d{4})\b/);
    if (m) {
      const dd = String(m[1]).padStart(2, '0');
      const mon = normKey(m[2]).slice(0, 3);
      const mm = months[mon];
      if (mm) return `${dd}/${mm}/${m[3]}`;
    }
  }
  return '';
}

function extractPhonesFromLines(lines, rutNum, rutNumPlusDv) {
  // Prefer labeled lines
  const keyWords = /(CELULAR|CEL\.|MÓVIL|MOVIL|TELÉFONO|TELEFONO|FONO|WHATSAPP)/i;
  const candidates = [];

  const addCandidate = (raw) => {
    let s = String(raw || '').trim();
    // Keep + and digits
    s = s.replace(/[^\d+]/g, '');
    const only = s.replace(/\+/g, '');
    if (only.length < 8) return;
    // Exclude rut-related numbers
    if (only === rutNum || only === rutNumPlusDv) return;
    // If no + and starts with 56, add +
    if (!s.startsWith('+') && only.startsWith('56')) s = '+' + only;
    candidates.push(s);
  };

  for (const ln of lines) {
    if (!keyWords.test(ln)) continue;
    const m = ln.match(/[:\-]\s*(.+)$/);
    if (m) addCandidate(m[1]);
    else addCandidate(ln);
  }

  // Unlabeled: numeric-only lines
  for (const ln of lines) {
    const l = ln.trim();
    // skip lines that include letters (avoid 22nov1980)
    if (/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(l)) continue;
    const m = l.match(/^\+?\d[\d(). -]{6,}\d$/);
    if (m) addCandidate(l);
  }

  // Also detect +56... inside a line
  for (const ln of lines) {
    const ms = ln.match(/(\+?56\d{8,9})/g);
    if (ms) ms.forEach(addCandidate);
  }

  const out = uniq(candidates);
  return [out[0] || '', out[1] || ''];
}

function splitFullName(full) {
  const cleaned = normalizeSpaces(full).replace(/[,;]+/g, ' ');
  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length === 0) return { nombres: '', apellidos: '' };
  if (parts.length === 1) return { nombres: parts[0], apellidos: '' };
  if (parts.length === 2) return { nombres: parts[0], apellidos: parts[1] };
  // Heurística Chile: últimos 2 tokens = apellidos
  const apellidos = parts.slice(-2).join(' ');
  const nombres = parts.slice(0, -2).join(' ');
  return { nombres, apellidos };
}

function extractByLabels(lines, labels) {
  for (const lab of labels) {
    const re = new RegExp(`\\b${lab}\\b\\s*[:\\-]\\s*(.+)$`, 'i');
    for (const ln of lines) {
      const m = ln.match(re);
      if (m) return normalizeSpaces(m[1]);
    }
  }
  return '';
}

const PREVISION_CHOICES = new Set([
  'BANMEDICA','COLMENA','CONSALUD','CRUZ BLANCA','CRUZ DEL NORTE','DIPRECA','ESENCIAL',
  'FONASA','FUNDACION','I SALUD - EX CHUQUICAMATA','JEAFOSALE','MEDIMEL-BANMEDICA',
  'NUEVA MAS VIDA','OTRA DE FUERZAS ARMADAS','PAD FONASA PAD','PARTICULAR','VIDA TRES'
]);const ASEGURADORA_OPTIONS = [
  "Sin aseguradora asociada",
  "BANMEDICA","COLMENA","CONSALUD","CRUZ BLANCA","CRUZ DEL NORTE","DIPRECA","ESENCIAL",
  "FONASA","FUNDACION","I SALUD - EX CHUQUICAMATA","JEAFOSALE","MEDIMEL-BANMEDICA",
  "NUEVA MAS VIDA","OTRA DE FUERZAS ARMADAS","PAD Fonasa PAD","PARTICULAR","VIDA TRES"
];

const TRAMO_MODALIDAD_OPTIONS = [
  "Banmédica","Colmena","Consalud","Cruz Blanca","Cruz Norte","DIPRECA","Fonasa","Fuerza Armadas",
  "Fundación","I. Chuquicamata","MEDIMEL-CB","Más Vida","Particular",
  "Tramo A","Tramo B","Tramo C","Tramo D","Vida Tres"
];

// Comunas (Chile)
const COMUNAS_OPTIONS = [
  "ALGARROBO",
  "ALHUÉ",
  "ALTO BIOBÍO",
  "ALTO DEL CARMEN",
  "ALTO HOSPICIO",
  "ANCUD",
  "ANDACOLLO",
  "ANGOL",
  "ANTOFAGASTA",
  "ANTUCO",
  "ANTÁRTICA",
  "ARAUCO",
  "ARICA",
  "AYSÉN",
  "BUIN",
  "BULNES",
  "CABILDO",
  "CABO DE HORNOS (EX-NAVARINO)",
  "CABRERO",
  "CALAMA",
  "CALBUCO",
  "CALDERA",
  "CALERA",
  "CALERA DE TANGO",
  "CALLE LARGA",
  "CAMARONES",
  "CAMIÑA",
  "CANELA",
  "CARAHUE",
  "CARTAGENA",
  "CASABLANCA",
  "CASTRO",
  "CATEMU",
  "CAUQUENES",
  "CAÑETE",
  "CERRILLOS",
  "CERRO NAVIA",
  "CHAITÉN",
  "CHANCO",
  "CHAÑARAL",
  "CHIGUAYANTE",
  "CHILE CHICO",
  "CHILLÁN",
  "CHILLÁN VIEJO",
  "CHIMBARONGO",
  "CHOLCHOL",
  "CHONCHI",
  "CHÉPICA",
  "CISNES",
  "COBQUECURA",
  "COCHAMÓ",
  "COCHRANE",
  "CODEGUA",
  "COELEMU",
  "COIHAIQUE",
  "COIHUECO",
  "COINCO",
  "COLBÚN",
  "COLCHANE",
  "COLINA",
  "COLLIPULLI",
  "COLTAUCO",
  "COMBARBALÁ",
  "CONCEPCIÓN",
  "CONCHALÍ",
  "CONCÓN",
  "CONSTITUCIÓN",
  "CONTULMO",
  "COPIAPÓ",
  "COQUIMBO",
  "CORONEL",
  "CORRAL",
  "CUNCO",
  "CURACAUTÍN",
  "CURACAVÍ",
  "CURACO DE VÉLEZ",
  "CURANILAHUE",
  "CURARREHUE",
  "CUREPTO",
  "CURICÓ",
  "DALCAHUE",
  "DIEGO DE ALMAGRO",
  "DOÑIHUE",
  "EL BOSQUE",
  "EL CARMEN",
  "EL MONTE",
  "EL QUISCO",
  "EL TABO",
  "EMPEDRADO",
  "ERCILLA",
  "ESTACIÓN CENTRAL",
  "FLORIDA",
  "FREIRE",
  "FREIRINA",
  "FRESIA",
  "FRUTILLAR",
  "FUTALEUFÚ",
  "FUTRONO",
  "GALVARINO",
  "GENERAL LAGOS",
  "GORBEA",
  "GRANEROS",
  "GUAITECAS",
  "HIJUELAS",
  "HUALAIHUÉ",
  "HUALAÑÉ",
  "HUALPÉN",
  "HUALQUI",
  "HUARA",
  "HUASCO",
  "HUECHURABA",
  "ILLAPEL",
  "INDEPENDENCIA",
  "IQUIQUE",
  "ISLA DE MAIPO",
  "ISLA DE PASCUA",
  "JUAN FERNÁNDEZ",
  "LA CISTERNA",
  "LA CRUZ",
  "LA ESTRELLA",
  "LA FLORIDA",
  "LA GRANJA",
  "LA HIGUERA",
  "LA LIGUA",
  "LA PINTANA",
  "LA REINA",
  "LA SERENA",
  "LA UNIÓN",
  "LAGO RANCO",
  "LAGO VERDE",
  "LAGUNA BLANCA",
  "LAJA",
  "LAMPA",
  "LANCO",
  "LAS CABRAS",
  "LAS CONDES",
  "LAUTARO",
  "LEBU",
  "LICANTÉN",
  "LIMACHE",
  "LINARES",
  "LITUECHE",
  "LLAILLAY",
  "LLANQUIHUE",
  "LO BARNECHEA",
  "LO ESPEJO",
  "LO PRADO",
  "LOLOL",
  "LONCOCHE",
  "LONGAVÍ",
  "LONQUIMAY",
  "LOS ALAMOS",
  "LOS ANDES",
  "LOS ANGELES",
  "LOS LAGOS",
  "LOS MUERMOS",
  "LOS SAUCES",
  "LOS VILOS",
  "LOTA",
  "LUMACO",
  "MACHALÍ",
  "MACUL",
  "MAIPÚ",
  "MALLOA",
  "MARCHIHUE",
  "MARIQUINA",
  "MARÍA ELENA",
  "MARÍA PINTO",
  "MAULE",
  "MAULLÍN",
  "MEJILLONES",
  "MELIPEUCO",
  "MELIPILLA",
  "MOLINA",
  "MONTE PATRIA",
  "MOSTAZAL",
  "MULCHÉN",
  "MÁFIL",
  "NACIMIENTO",
  "NANCAGUA",
  "NATALES",
  "NAVIDAD",
  "NEGRETE",
  "NINHUE",
  "NOGALES",
  "NUEVA IMPERIAL",
  "O'HIGGINS",
  "OLIVAR",
  "OLLAGÜE",
  "OLMUÉ",
  "OSORNO",
  "OVALLE",
  "PADRE HURTADO",
  "PADRE LAS CASAS",
  "PAIGUANO",
  "PAILLACO",
  "PAINE",
  "PALENA",
  "PALMILLA",
  "PANGUIPULLI",
  "PANQUEHUE",
  "PAPUDO",
  "PAREDONES",
  "PARRAL",
  "PEDRO AGUIRRE CERDA",
  "PELARCO",
  "PELLUHUE",
  "PEMUCO",
  "PENCAHUE",
  "PENCO",
  "PERALILLO",
  "PERQUENCO",
  "PETORCA",
  "PEUMO",
  "PEÑAFLOR",
  "PEÑALOLÉN",
  "PICA",
  "PICHIDEGUA",
  "PICHILEMU",
  "PINTO",
  "PIRQUE",
  "PITRUFQUÉN",
  "PLACILLA",
  "PORTEZUELO",
  "PORVENIR",
  "POZO ALMONTE",
  "PRIMAVERA",
  "PROVIDENCIA",
  "PUCHUNCAVÍ",
  "PUCÓN",
  "PUDAHUEL",
  "PUENTE ALTO",
  "PUERTO MONTT",
  "PUERTO OCTAY",
  "PUERTO VARAS",
  "PUMANQUE",
  "PUNITAQUI",
  "PUNTA ARENAS",
  "PUQUELDÓN",
  "PURRANQUE",
  "PURÉN",
  "PUTAENDO",
  "PUTRE",
  "PUYEHUE",
  "QUEILÉN",
  "QUELLÓN",
  "QUEMCHI",
  "QUILACO",
  "QUILICURA",
  "QUILLECO",
  "QUILLOTA",
  "QUILLÓN",
  "QUILPUÉ",
  "QUINCHAO",
  "QUINTA DE TILCOCO",
  "QUINTA NORMAL",
  "QUINTERO",
  "QUIRIHUE",
  "RANCAGUA",
  "RAUCO",
  "RECOLETA",
  "RENAICO",
  "RENCA",
  "RENGO",
  "REQUÍNOA",
  "RETIRO",
  "REÑACA",
  "RINCONADA",
  "ROMERAL",
  "RÁNQUIL",
  "RÍO BUENO",
  "RÍO CLARO",
  "RÍO HURTADO",
  "RÍO IBÁÑEZ",
  "RÍO NEGRO",
  "RÍO VERDE",
  "SAAVEDRA",
  "SAGRADA FAMILIA",
  "SALAMANCA",
  "SAN ANTONIO",
  "SAN BERNARDO",
  "SAN CARLOS",
  "SAN CLEMENTE",
  "SAN ESTEBAN",
  "SAN FABIÁN",
  "SAN FELIPE",
  "SAN FERNANDO",
  "SAN GREGORIO",
  "SAN IGNACIO",
  "SAN JAVIER",
  "SAN JOAQUÍN",
  "SAN JOSÉ DE MAIPO",
  "SAN JUAN DE LA COSTA",
  "SAN MIGUEL",
  "SAN NICOLÁS",
  "SAN PABLO",
  "SAN PEDRO",
  "SAN PEDRO DE ATACAMA",
  "SAN PEDRO DE LA PAZ",
  "SAN RAFAEL",
  "SAN RAMÓN",
  "SAN ROSENDO",
  "SAN VICENTE",
  "SANTA BÁRBARA",
  "SANTA CRUZ",
  "SANTA JUANA",
  "SANTA MARÍA",
  "SANTIAGO",
  "SANTO DOMINGO",
  "SIERRA GORDA",
  "TALAGANTE",
  "TALCA",
  "TALCAHUANO",
  "TALTAL",
  "TEMUCO",
  "TENO",
  "TEODORO SCHMIDT",
  "TIERRA AMARILLA",
  "TILTIL",
  "TIMAUKEL",
  "TIRÚA",
  "TOCOPILLA",
  "TOLTÉN",
  "TOMÉ",
  "TORRES DEL PAINE",
  "TORTEL",
  "TRAIGUÉN",
  "TREGUACO",
  "TUCAPEL",
  "VALDIVIA",
  "VALLENAR",
  "VALPARAÍSO",
  "VICHUQUÉN",
  "VICTORIA",
  "VICUÑA",
  "VILCÚN",
  "VILLA ALEGRE",
  "VILLA ALEMANA",
  "VILLARRICA",
  "VITACURA",
  "VIÑA DEL MAR",
  "YERBAS BUENAS",
  "YUMBEL",
  "YUNGAY",
  "ZAPALLAR",
  "ÑIQUÉN",
  "ÑUÑOA"
];


function normalizePrevision(s) {
  let t = normKey(s);
  t = t.replace(/\s+/g, ' ').trim();
  // If includes "FONASA", keep only FONASA (tramo goes elsewhere)
  if (t.includes('FONASA')) return 'FONASA';
  // If includes any known choice as substring, pick it
  for (const ch of PREVISION_CHOICES) {
    if (t === ch) return ch;
  }
  // Special: PAD Fonasa PAD
  if (t.includes('PAD') && t.includes('FONASA')) return 'PAD FONASA PAD';
  return t;
}

function extractNameFromWhatsApp(lines) {
  // First non-empty line with letters and spaces, no @, no digits, not a label line.
  for (const ln of lines) {
    const l = ln.trim();
    if (!l) continue;
    if (l.includes('@')) continue;
    if (/[0-9]/.test(l)) continue;
    if (/^\w+\s*:/i.test(l)) continue;
    if (l.length < 3) continue;
    return l;
  }
  return '';
}

function guessAddressAndComuna(lines, rut, email, dob, phone1, phone2, fullName) {
  const exclude = new Set([normKey(rut), normKey(email), normKey(dob), normKey(phone1), normKey(phone2), normKey(fullName)]);
  const candidates = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('@'))
    .filter((l) => !exclude.has(normKey(l)));

  // If labels exist, use them
  let comuna = extractByLabels(lines, ['Comuna', 'Ciudad']);
  let direccion = extractByLabels(lines, ['Direcci[oó]n', 'Direccion', 'Domicilio']);
  if (direccion && !comuna) {
    const mm = direccion.match(/(.+),\s*([A-ZÁÉÍÓÚÑa-záéíóúñ ]{3,})$/);
    if (mm) {
      direccion = mm[1].trim();
      comuna = mm[2].trim();
    }
  }
  if (direccion || comuna) return { direccion, comuna };

  // Guess comuna: last line that is letters only (no digits) and short
  for (let i = candidates.length - 1; i >= 0; i--) {
    const l = candidates[i];
    if (/[0-9]/.test(l)) continue;
    if (l.length > 30) continue;
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(l)) continue;
    comuna = l;
    // Guess dirección: nearest previous line with digits (street number)
    for (let j = i - 1; j >= 0; j--) {
      const prev = candidates[j];
      if (/[0-9]/.test(prev) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(prev)) {
        direccion = prev;
        break;
      }
    }
    // fallback address: previous line even without digits
    if (!direccion && i - 1 >= 0) direccion = candidates[i - 1];
    break;
  }
  return { direccion, comuna };
}

function parseIABox(raw) {
  const text = cleanText(raw);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const rut = extractRutFromLines(lines);
  const { num: rutNum, dv } = rutParts(rut);
  const rutNumPlusDv = rutNum && dv ? (rutNum + dv) : '';

  const email = extractEmailFromLines(lines);
  const fecha = parseDobFromLines(lines);

  // Names
  let nombres = extractByLabels(lines, ['Nombres?', 'Nombre\\s*\\(s\\)', 'First\\s*name']);
  let apellidos = extractByLabels(lines, ['Apellidos?', 'Last\\s*name']);
  if (!nombres && !apellidos) {
    const labeledFull = extractByLabels(lines, ['Nombre\\s*completo', 'Nombre', 'Paciente']);
    const full = labeledFull || extractNameFromWhatsApp(lines);
    const split = splitFullName(full);
    nombres = split.nombres;
    apellidos = split.apellidos;
  } else if (nombres && !apellidos) {
    // If "Nombre:" contains full name, split
    const split = splitFullName(nombres);
    if (split.apellidos) {
      nombres = split.nombres;
      apellidos = split.apellidos;
    }
  }

  // Phones (line-based, excludes RUT)
  const [telefono1, telefono2] = extractPhonesFromLines(lines, rutNum, rutNumPlusDv);

  // Previsión / Aseguradora
  let aseguradora = extractByLabels(lines, ['Aseguradora', 'Previsi[oó]n', 'Prevision']);
  if (!aseguradora) {
    // Try to detect a line that matches a choice
    for (const ln of lines) {
      const k = normKey(ln);
      if (PREVISION_CHOICES.has(k)) { aseguradora = ln; break; }
      if (k.includes('FONASA')) { aseguradora = 'FONASA'; break; }
    }
  }
  aseguradora = aseguradora ? normalizePrevision(aseguradora) : '';

  let modalidad = extractByLabels(lines, ['Modalidad']);
  if (!modalidad) modalidad = ''; // don't guess for now

  const fullNameGuess = normalizeSpaces([nombres, apellidos].filter(Boolean).join(' '));
  const addr = guessAddressAndComuna(lines, rut, email, fecha, telefono1, telefono2, fullNameGuess);

  let direccion = addr.direccion ? addr.direccion : '';
  let comuna = addr.comuna ? addr.comuna : '';

  comuna = comuna ? normKey(comuna) : '';
  // Keep accents? We will keep original if present; but for field, uppercase is ok.
  // If comuna had accents, normKey removes them; but backend canonicalComuna handles accents.
  // We'll keep the raw comuna if we can find it in original lines (last match).
  if (comuna) {
    // Find best original line matching comuna key
    const key = comuna;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (normKey(lines[i]) === key) { comuna = lines[i].toUpperCase().trim(); break; }
    }
  }

  return {
    rut,
    nombres,
    apellidos,
    fecha_nacimiento: fecha,
    telefono1: telefono1 || '',
    telefono2: telefono2 || '',
    email,
    aseguradora,
    modalidad,
    direccion,
    comuna,
  };
}


// -------------------------
// Search by RUT_normalizado
// -------------------------
const form = $('form');
const rutEl = $('rut');
const pipelineIdEl = $('pipelineId');
const statusEl = $('status');
const outEl = $('out');

// Docs generation UI (from search result)
const btnCreateDocs = $('btnCreateDocs');
const docsDryRunEl = $('docsDryRun');
const docsStatusEl = $('docs_status');
const docsOutEl = $('docs_out');
const docsLinksEl = $('docs_links');

// Templates UI
const docsTemplatesEl = $('docsTemplates');
const btnReloadTemplates = $('btnReloadTemplates');
const btnSelectAllTemplates = $('btnSelectAllTemplates');
const btnSelectNoneTemplates = $('btnSelectNoneTemplates');
const docsTemplatesSearchEl = $('docsTemplatesSearch');
const btnSelectFilteredTemplates = $('btnSelectFilteredTemplates');
const btnDeselectFilteredTemplates = $('btnDeselectFilteredTemplates');
const docsTemplatesCountEl = $('docsTemplatesCount');

let __selectedDealId = null;
let __lastSearchJson = null;

function updateDocsButton() {
  const ok = __lastSearchJson && __lastSearchJson.ok === true;
  const dealId = __lastSearchJson?.deal?.id;
  __selectedDealId = dealId || null;
  btnCreateDocs.disabled = !(ok && __selectedDealId);
}

let __templatesAll = [];
let __templatesFiltered = [];
let __selectedTemplateIds = new Set();

function readSavedTemplateSelection() {
  try {
    const raw = localStorage.getItem('docs.templateSelection');
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch (_e) {
    return null;
  }
}

function saveTemplateSelection(ids) {
  try {
    localStorage.setItem('docs.templateSelection', JSON.stringify(ids || []));
  } catch (_e) {}
}

function persistSelectedSet() {
  saveTemplateSelection(Array.from(__selectedTemplateIds));
}

function initSelectedSet(defaultSelectedIds = []) {
  // Default: NONE selected. (Safer UX)
  __selectedTemplateIds = new Set();
}

function updateTemplatesCount() {
  if (!docsTemplatesCountEl) return;
  const total = __templatesAll.length;
  const shown = __templatesFiltered.length;
  const selected = __selectedTemplateIds.size;
  docsTemplatesCountEl.textContent = total
    ? `Mostrando ${shown} de ${total} · Seleccionadas: ${selected}`
    : '';
}

function renderTemplates(list) {
  __templatesFiltered = list || [];
  if (!docsTemplatesEl) return;

  docsTemplatesEl.innerHTML = __templatesFiltered.map((t) => {
    const checked = __selectedTemplateIds.has(t.id) ? 'checked' : '';
    const sub = t.modifiedTime ? new Date(t.modifiedTime).toLocaleString() : '';
    return `
      <label class="templates-item">
        <input type="checkbox" data-template-id="${escapeHtml(t.id)}" ${checked} />
        <span class="meta">
          <span class="name">${escapeHtml(t.name || t.slug || t.id)}</span>
          <span class="sub">${escapeHtml(sub)} · ${escapeHtml(t.docs_url || '')}</span>
        </span>
      </label>
    `;
  }).join('');

  // Incremental persist on change (doesn't lose selection outside filter)
  docsTemplatesEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-template-id');
      if (!id) return;
      if (cb.checked) __selectedTemplateIds.add(id);
      else __selectedTemplateIds.delete(id);
      persistSelectedSet();
      updateTemplatesCount();
    });
  });

  updateTemplatesCount();
}

function applyTemplateFilter() {
  const q = (docsTemplatesSearchEl?.value || '').trim().toLowerCase();
  if (!q) {
    renderTemplates(__templatesAll);
    return;
  }
  const filtered = __templatesAll.filter((t) => {
    const hay = `${t.name || ''} ${t.slug || ''} ${t.id || ''}`.toLowerCase();
    return hay.includes(q);
  });
  renderTemplates(filtered);
}

async function loadTemplates(force = false) {
  if (!docsTemplatesEl) return;

  try {
    setStatus(docsStatusEl, 'Cargando templates...', 'info');
    const url = force ? '/api/docs/templates?force=1' : '/api/docs/templates';
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok || !json.ok) {
      setStatus(docsStatusEl, json.message || 'No se pudieron cargar templates', 'error');
      docsTemplatesEl.innerHTML = '';
      __templatesAll = [];
      __templatesFiltered = [];
      updateTemplatesCount();
      return;
    }

    __templatesAll = json.items || [];
    initSelectedSet(json.default_selected_ids || []);
    applyTemplateFilter(); // renders
    setStatus(docsStatusEl, `Templates cargados: ${json.count}`, 'ok');
  } catch (err) {
    setStatus(docsStatusEl, err.message || String(err), 'error');
  }
}

// Buttons
if (btnReloadTemplates) btnReloadTemplates.addEventListener('click', () => loadTemplates(true));

if (btnSelectAllTemplates) btnSelectAllTemplates.addEventListener('click', () => {
  __selectedTemplateIds = new Set(__templatesAll.map(t => t.id));
  persistSelectedSet();
  applyTemplateFilter();
});

if (btnSelectNoneTemplates) btnSelectNoneTemplates.addEventListener('click', () => {
  __selectedTemplateIds = new Set();
  persistSelectedSet();
  applyTemplateFilter();
});

if (btnSelectFilteredTemplates) btnSelectFilteredTemplates.addEventListener('click', () => {
  for (const t of __templatesFiltered) __selectedTemplateIds.add(t.id);
  persistSelectedSet();
  applyTemplateFilter();
});

if (btnDeselectFilteredTemplates) btnDeselectFilteredTemplates.addEventListener('click', () => {
  for (const t of __templatesFiltered) __selectedTemplateIds.delete(t.id);
  persistSelectedSet();
  applyTemplateFilter();
});

if (docsTemplatesSearchEl) docsTemplatesSearchEl.addEventListener('input', applyTemplateFilter);

// Load templates on page load
loadTemplates(false);

function renderDocsLinks(json) {
  if (!docsLinksEl) return;
  if (!json || !json.ok) {
    docsLinksEl.innerHTML = '';
    return;
  }

  const folderUrl = json.patient_folder_url || json.patient_folder_url || '';
  const header = folderUrl
    ? `<div class="docs-links-head"><a href="${escapeHtml(folderUrl)}" target="_blank" rel="noopener">📁 Abrir carpeta del paciente</a></div>`
    : '';

  const results = Array.isArray(json.results) ? json.results : [];
  const items = results.map((r) => {
    const name = escapeHtml(r.doc_name || r.pdf_name || r.doc_type || '');
    const doc = r.doc_url ? `<a href="${escapeHtml(r.doc_url)}" target="_blank" rel="noopener">DOC</a>` : '';
    const pdf = r.pdf_url ? `<a href="${escapeHtml(r.pdf_url)}" target="_blank" rel="noopener">PDF</a>` : '';
    const links = [doc, pdf].filter(Boolean).join(' · ');
    const status = r.status ? `<span class="tag">${escapeHtml(r.status)}</span>` : '';
    return `<li><span class="doc-name">${name}</span> ${status} <span class="doc-links">${links}</span></li>`;
  }).join('');

  docsLinksEl.innerHTML = header + (items ? `<ul class="docs-links-list">${items}</ul>` : '<div class="muted small">Sin resultados</div>');
}

function setStatus(el, msg, kind = 'info') {
  el.textContent = msg || '';
  el.className = `status ${kind}`;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const rut = rutEl.value;
  const pipelineId = pipelineIdEl.value;

  setStatus(statusEl, 'Buscando...', 'info');
  outEl.textContent = '';

  try {
    const res = await fetch('/api/search-rut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut, pipelineId }),
    });

    const json = await res.json();

    __lastSearchJson = json;
    updateDocsButton();


    if (json.warning_banner) {
      cSummary.insertAdjacentHTML('beforeend',
        `<div class="summary-row" style="color:#ff5a7a"><b>${escapeHtml(json.warning_banner)}</b></div>`
      );
    }

    outEl.textContent = JSON.stringify(json, null, 2);

    if (!res.ok) setStatus(statusEl, json.message || 'Error', 'error');
    else setStatus(statusEl, 'OK', 'ok');
  } catch (err) {
    setStatus(statusEl, err.message || String(err), 'error');
  }
});

btnCreateDocs.addEventListener('click', async () => {
  if (!__selectedDealId) return;

  const dry = !!docsDryRunEl.checked;
  setStatus(docsStatusEl, dry ? 'Preparando (dry-run)...' : 'Generando documentos...', 'info');
  docsOutEl.textContent = '';
  if (docsLinksEl) docsLinksEl.innerHTML = '';

  try {
    const url = dry ? '/api/docs/generate-batch?dry_run=1' : '/api/docs/generate-batch';
    const selectedTemplates = (__templatesAll || []).filter(t => __selectedTemplateIds.has(t.id));

if (docsTemplatesEl && selectedTemplates.length === 0) {
  setStatus(docsStatusEl, 'Debes seleccionar al menos 1 template.', 'error');
  return;
}

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deal_id: __selectedDealId,
    templates: selectedTemplates.map(t => ({ file_id: t.id, name: t.name })),
  }),
});

const json = await res.json();

    docsOutEl.textContent = JSON.stringify(json, null, 2);
    renderDocsLinks(json);
    if (!res.ok) setStatus(docsStatusEl, json.message || 'Error', 'error');
    else setStatus(docsStatusEl, 'OK', 'ok');
  } catch (err) {
    setStatus(docsStatusEl, err.message || String(err), 'error');
  }
});

// Deep-link support: /?deal_id=123
(() => {
  try {
    const qs = new URLSearchParams(location.search);
    const dealId = qs.get('deal_id') || qs.get('dealId');
    if (!dealId) return;

    setStatus(statusEl, `Cargando deal_id=${dealId}...`, 'info');
    fetch(`/api/deal-context?deal_id=${encodeURIComponent(dealId)}`)
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        // Emula salida similar a search-rut (solo para habilitar botón)
        const merged = {
          ok: ok && j.ok,
          status: j.status,
          error: j.error || null,
          message: j.message || null,
          contact: j.contact || null,
          deal: j.deal || null,
        };
        __lastSearchJson = merged;
        updateDocsButton();
        outEl.textContent = JSON.stringify(j, null, 2);
        setStatus(statusEl, ok ? 'OK' : (j.message || 'Error'), ok ? 'ok' : 'error');
      })
      .catch(err => setStatus(statusEl, err.message || String(err), 'error'));
  } catch (_e) {}
})();

// -------------------------
// IA BOX + Create Contact
// -------------------------
const iaText = $('iaText');
const btnExtract = $('btnExtract');
const btnClear = $('btnClear');
const techMode = $('techMode');

const cStatus = $('c_status');
const cSummary = $('c_summary');
const cOut = $('c_out');
const cDetails = $('c_details');

const fields = {
  rut: $('c_rut'),
  nombres: $('c_nombres'),
  apellidos: $('c_apellidos'),
  fecha_nacimiento: $('c_fecha'),
  telefono1: $('c_tel1'),
  telefono2: $('c_tel2'),
  email: $('c_email'),
  aseguradora: $('c_aseguradora'),
  modalidad: $('c_modalidad'),
  direccion: $('c_direccion'),
  comuna: $('c_comuna'),
};

function normalizeUpper(v) {
  return String(v ?? '').trim().toUpperCase();
}

function normalizeModalidad(v) {
  const s = String(v ?? '').trim();
  const key = s.toLowerCase();

  const map = {
    "fonasa": "Fonasa",
    "banmedica": "Banmédica",
    "banmédica": "Banmédica",
    "mas vida": "Más Vida",
    "más vida": "Más Vida",
    "vida tres": "Vida Tres",
    "cruz blanca": "Cruz Blanca",
    "cruz norte": "Cruz Norte",
    "cruz del norte": "Cruz Norte",
    "colmena": "Colmena",
    "consalud": "Consalud",
    "dipreca": "DIPRECA",
    "particular": "Particular",
    "tramo a": "Tramo A",
    "tramo b": "Tramo B",
    "tramo c": "Tramo C",
    "tramo d": "Tramo D",
    "fuerza armadas": "Fuerza Armadas",
    "fundacion": "Fundación",
    "fundación": "Fundación",
    "i chuquicamata": "I. Chuquicamata",
    "i. chuquicamata": "I. Chuquicamata",
    "medimel-cb": "MEDIMEL-CB",
  };

  return map[key] ?? s;
}

function setSmartValue(el, rawValue, opts = {}) {
  if (!el) return;
  if (rawValue == null) return;

  let v = String(rawValue).trim();
  if (!v) return;

  if (typeof opts.normalize === "function") v = opts.normalize(v);

  // If TomSelect is attached, use it so UI updates correctly
  if (el.tomselect) {
    const ts = el.tomselect;

    // If value doesn't exist, try case-insensitive match
    const keys = Object.keys(ts.options || {});
    const foundKey = keys.find(k => k.toLowerCase() === v.toLowerCase());
    if (foundKey) v = foundKey;

    // If still not found and allowCreate, add option
    if (!ts.options?.[v] && opts.allowCreate) {
      ts.addOption({ value: v, text: v });
    }

    // Finally set
    ts.setValue(v, true);
    ts.trigger("change");
    return;
  }

  // Fallback: plain inputs/selects
  el.value = v;
}

function clearSmartValue(el) {
  if (!el) return;
  if (el.tomselect) {
    el.tomselect.clear(true);
    el.tomselect.trigger("change");
  } else {
    el.value = "";
  }
}

function fillFields(obj) {
  if (obj.rut) fields.rut.value = obj.rut;
  if (obj.nombres) fields.nombres.value = obj.nombres;
  if (obj.apellidos) fields.apellidos.value = obj.apellidos;
  if (obj.fecha_nacimiento) fields.fecha_nacimiento.value = obj.fecha_nacimiento;
  if (obj.telefono1) fields.telefono1.value = obj.telefono1;
  if (obj.telefono2) fields.telefono2.value = obj.telefono2;
  if (obj.email) fields.email.value = obj.email;

  // Dropdowns (TomSelect combobox): use smart setter so UI updates + normalize
  if (obj.aseguradora) setSmartValue(fields.aseguradora, obj.aseguradora, { normalize: normalizeUpper, allowCreate: true });
  if (obj.modalidad) setSmartValue(fields.modalidad, obj.modalidad, { normalize: normalizeModalidad, allowCreate: true });
  if (obj.comuna) setSmartValue(fields.comuna, obj.comuna, { normalize: normalizeUpper, allowCreate: false });

  if (obj.direccion) fields.direccion.value = obj.direccion;
}


btnExtract.addEventListener('click', () => {
  const parsed = parseIABox(iaText.value);
  fillFields(parsed);
  setStatus(cStatus, 'Campos completados desde IA BOX (puedes editar).', 'ok');
});

btnClear.addEventListener('click', () => {
  iaText.value = '';
  for (const k of Object.keys(fields)) clearSmartValue(fields[k]);
  cSummary.innerHTML = '';
  cOut.textContent = '';
  setStatus(cStatus, '', 'info');
});

function collectContactData() {
  return {
    rut: fields.rut.value.trim(),
    nombres: fields.nombres.value.trim(),
    apellidos: fields.apellidos.value.trim(),
    fecha_nacimiento: fields.fecha_nacimiento.value.trim(),
    telefono1: fields.telefono1.value.trim(),
    telefono2: fields.telefono2.value.trim(),
    email: fields.email.value.trim(),
    aseguradora: fields.aseguradora.value.trim(),
    modalidad: fields.modalidad.value.trim(),
    direccion: fields.direccion.value.trim(),
    comuna: fields.comuna.value.trim(),
  };
}

function renderSummary(json) {
  cSummary.innerHTML = '';
  const vp = json.vista_previa;

  const parts = [];
  if (vp) {
    parts.push(`<div class="kv">
      <div class="k">RUT normalizado</div><div class="v"><span class="mono">${vp.rut_normalizado}</span></div>
      <div class="k">RUT (humano)</div><div class="v"><span class="mono">${vp.rut_o_id}</span></div>
      <div class="k">Nombres</div><div class="v">${vp.nombres}</div>
      <div class="k">Apellidos</div><div class="v">${vp.apellidos}</div>
      <div class="k">Fecha Nacimiento</div><div class="v">${vp.fecha_nacimiento}</div>
      <div class="k">Teléfono 1</div><div class="v">${vp.telefono1}</div>
      <div class="k">Teléfono 2</div><div class="v">${vp.telefono2}</div>
      <div class="k">Correo</div><div class="v">${vp.email}</div>
      <div class="k">Aseguradora</div><div class="v">${vp.aseguradora}</div>
      <div class="k">Modalidad</div><div class="v">${vp.modalidad}</div>
      <div class="k">Dirección</div><div class="v">${vp.direccion}</div>
      <div class="k">Comuna</div><div class="v">${vp.comuna}</div>
    </div>`);
  }

  if (json.contacts && Array.isArray(json.contacts) && json.contacts.length) {
    const links = json.contacts.map(c =>
      `<div>• ${c.display_name} — <a href="${c.desktop_url}" target="_blank" rel="noreferrer">Abrir en Sell</a> · <a href="${c.mobile_url}" target="_blank" rel="noreferrer">Mobile</a></div>`
    ).join('');
    parts.push(`<div class="links"><b>Contactos encontrados con este RUT:</b>${links}</div>`);
  }

  if (json.contact) {
    const c = json.contact;
    parts.push(`<div class="links"><b>Contacto existente:</b> ${c.display_name} — <a href="${c.desktop_url}" target="_blank" rel="noreferrer">Abrir en Sell</a> · <a href="${c.mobile_url}" target="_blank" rel="noreferrer">Mobile</a></div>`);
  }

  cSummary.innerHTML = parts.join('');
}

async function callCreateContact(dryRun) {
  const body = collectContactData();
  const debug = techMode.checked ? '&debug=1' : '';
  const url = dryRun ? `/api/create-contact?dry_run=1${debug}` : `/api/create-contact${debug}`;

  setStatus(cStatus, dryRun ? 'Generando vista previa...' : 'Creando contacto...', 'info');
  cOut.textContent = '';
  cSummary.innerHTML = '';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await res.json();


    if (json.warning_banner) {
      cSummary.insertAdjacentHTML('beforeend',
        `<div class="summary-row" style="color:#ff5a7a"><b>${escapeHtml(json.warning_banner)}</b></div>`
      );
    }


    setStatus(cStatus, json.message || (res.ok ? 'OK' : 'Error'), res.ok ? 'ok' : 'error');
    renderSummary(json);

    // Guardar último contact_id para creación de Deal/Trato
    if (json && json.contact && json.contact.id) {
      window.__lastContactId = Number(json.contact.id);
    }


    // detail JSON: only show if techMode is on (or if there was an error)
    if (techMode.checked || !res.ok) {
      cDetails.open = true;
      cOut.textContent = JSON.stringify(json, null, 2);
    } else {
      cDetails.open = false;
      cOut.textContent = '';
    }
  } catch (err) {
    setStatus(cStatus, err.message || String(err), 'error');
  }
}

async function callCreateDeal(dryRun, contactId) {
  const body = collectContactData();
  body.contact_id = Number(contactId);
  body.pipeline_id = pipelineIdEl && pipelineIdEl.value ? Number(pipelineIdEl.value) : null;
  if (!body.pipeline_id || !Number.isFinite(body.pipeline_id)) {
    setStatus(cStatus, 'Debes ingresar Pipeline ID para crear el Deal.', 'error');
    return;
  }

  const debug = techMode.checked ? '&debug=1' : '';
  const url = dryRun ? `/api/create-deal?dry_run=1${debug}` : `/api/create-deal${debug}`;

  setStatus(cStatus, dryRun ? 'Generando vista previa de Deal...' : 'Creando Deal...', 'info');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await res.json();


    if (json.warning_banner) {
      cSummary.insertAdjacentHTML('beforeend',
        `<div class="summary-row" style="color:#ff5a7a"><b>${escapeHtml(json.warning_banner)}</b></div>`
      );
    }


    // Reutilizamos el mismo summary panel (agrega bloque de deal abajo)
  
  if (json.preview) {
    const p = json.preview;
    parts.push(
      `<div class="summary-row"><b>Vista previa:</b> ${escapeHtml(p.name || "")}</div>` +
      `<div class="summary-row">pipeline: <b>${escapeHtml((p.pipeline_name) || (window.__pipelinesById && window.__pipelinesById[String(p.pipeline_id)]) || '')}</b> · pipeline_id: <span class="mono">${escapeHtml(p.pipeline_id)}</span> · stage_id: <span class="mono">${escapeHtml(p.stage_id)}</span> · contact_id: <span class="mono">${escapeHtml(p.contact_id)}</span></div>`
    );
  }

  if (json.deal) {
      const d = json.deal;
      cSummary.insertAdjacentHTML('beforeend',
        `<div class="summary-row"><b>Deal:</b> <a href="${d.desktop_url}" target="_blank" rel="noreferrer">${escapeHtml(d.name || ('Deal #' + d.id))}</a> · <a href="${d.mobile_url}" target="_blank" rel="noreferrer">Mobile</a></div>`
      );
    } else if (json.deals && Array.isArray(json.deals) && json.deals.length) {
      const items = json.deals.slice(0, 5).map(d =>
        `<li><a href="${d.desktop_url}" target="_blank" rel="noreferrer">${escapeHtml(d.name || ('Deal #' + d.id))}</a></li>`
      ).join('');
      cSummary.insertAdjacentHTML('beforeend',
        `<div class="summary-row"><b>Deals existentes:</b><ul style="margin:6px 0 0 18px;">${items}</ul></div>`
      );
    }

    setStatus(cStatus, json.message || (res.ok ? 'OK' : 'Error'), res.ok ? 'ok' : 'error');

    if (techMode.checked || !res.ok) {
      cDetails.open = true;
      cOut.textContent = JSON.stringify(json, null, 2);
    }
  } catch (err) {
    setStatus(cStatus, err.message || String(err), 'error');
  }
}

$('btnPreview').addEventListener('click', () => callCreateContact(true));
$('btnCreate').addEventListener('click', () => callCreateContact(false));


// -------------------------
// Comboboxes (Tom Select)
// -------------------------
function fillSelect(el, options) {
  if (!el) return;
  // keep first option (placeholder)
  const keep = el.querySelectorAll('option').length ? el.querySelectorAll('option')[0] : null;
  el.innerHTML = '';
  if (keep) el.appendChild(keep);
  else {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Selecciona…';
    el.appendChild(o);
  }
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    el.appendChild(o);
  }
}

function initComboboxes() {
  const elA = $("c_aseguradora");
  const elM = $("c_modalidad");
  const elC = $("c_comuna");

  fillSelect(elA, ASEGURADORA_OPTIONS);
  fillSelect(elM, TRAMO_MODALIDAD_OPTIONS);
  fillSelect(elC, COMUNAS_OPTIONS);

  if (window.TomSelect) {
    if (elA) new TomSelect(elA, { create: true, persist: true, maxOptions: 500, placeholder: "Selecciona…" });
    if (elM) new TomSelect(elM, { create: true, persist: true, maxOptions: 500, placeholder: "Selecciona…" });
    if (elC) new TomSelect(elC, { create: false, persist: true, maxOptions: 5000, placeholder: "Selecciona…" });
  }
}

document.addEventListener("DOMContentLoaded", initComboboxes);



// -------------------------
// Crear DEAL / TRATO (usa último contact_id detectado/creado)
// -------------------------
const dStatus = document.getElementById('d_status');
const dSummary = document.getElementById('d_summary');
const dDetails = document.getElementById('d_details');
const dOut = document.getElementById('d_out');

function renderDealResult(json) {
  const parts = [];
  if (json.warning_banner) {
    parts.push(`<div class="summary-row" style="color:#ff5a7a"><b>${escapeHtml(json.warning_banner)}</b></div>`);
  }

  if (json.deal) {
    const d = json.deal;
    parts.push(
      `<div class="summary-row"><b>Deal creado:</b> <a href="${d.desktop_url}" target="_blank" rel="noreferrer">${escapeHtml(d.name || ('Deal #' + d.id))}</a> · <a href="${d.mobile_url}" target="_blank" rel="noreferrer">Mobile</a></div>`
    );
  }

  if (json.deals && Array.isArray(json.deals) && json.deals.length) {
    const items = json.deals.slice(0, 10).map(d =>
      `<li><a href="${d.desktop_url}" target="_blank" rel="noreferrer">${escapeHtml(d.name || ('Deal #' + d.id))}</a> · <a href="${d.mobile_url}" target="_blank" rel="noreferrer">Mobile</a></li>`
    ).join('');
    parts.push(`<div class="summary-row"><b>Deals encontrados en el mismo pipeline:</b><ul style="margin:6px 0 0 18px;">${items}</ul></div>`);
  }

  dSummary.innerHTML = parts.join('') || `<div class="muted small">Sin datos.</div>`;
}

async function callDeal(dryRun) {
  const contactId = Number(window.__lastContactId || 0);
  if (!Number.isFinite(contactId) || contactId <= 0) {
    setStatus(dStatus, 'Primero crea/identifica un Contacto en el bloque anterior (se requiere contact_id).', 'error');
    return;
  }

  const pipelineEl = document.getElementById('dealPipelineId');
  const manualEl = document.getElementById('manualPipelineId');
  const pipelineId = (pipelineEl && pipelineEl.value ? Number(pipelineEl.value) : null) || (manualEl && manualEl.value ? Number(manualEl.value) : null);
  if (!pipelineId || !Number.isFinite(pipelineId)) {
    setStatus(dStatus, 'Debes ingresar Pipeline ID para crear el Deal/TRATO.', 'error');
    return;
  }


const ownerEl = document.getElementById('dealOwnerId');
const ownerId = ownerEl && ownerEl.value ? Number(ownerEl.value) : null;
if (!ownerId || !Number.isFinite(ownerId)) {
  setStatus(dStatus, 'Debes seleccionar un Dueño para el Deal.', 'error');
  return;
}

  // Tomamos los mismos datos extraídos del IA BOX (RUT, nombres, apellidos, previsión, etc.)
  const body = collectContactData();
  body.contact_id = contactId;
  body.pipeline_id = pipelineId;
  body.owner_id = ownerId;

  // Medical deal fields
  body.sucursal = (document.getElementById('dealSucursal')?.value || '').trim();
  body.peso = (document.getElementById('dealPeso')?.value || '').trim();
  body.estatura = (document.getElementById('dealEstatura')?.value || '').trim();
  body.interes = (document.getElementById('dealInteres')?.value || '').trim();
  body.url_medinet = (document.getElementById('dealUrlMedinet')?.value || '').trim();
  body.cirugias_previas = (document.getElementById('dealCirugiasPrevias')?.value || '').trim();
  body.cirujano_bariatrico = (document.getElementById('dealCirujanoBariatrico')?.value || '').trim();
  body.cirujano_plastico = (document.getElementById('dealCirujanoPlastico')?.value || '').trim();
  body.cirujano_balon = (document.getElementById('dealCirujanoBalon')?.value || '').trim();
  body.validacion_pad = (document.getElementById('dealValidacionPad')?.value || '').trim();
  body.numero_familia_paciente = (document.getElementById('dealNumeroFamilia')?.value || '').trim();
  body.colaborador1 = (document.getElementById('dealColab1')?.value || '').trim();
  body.colaborador2 = (document.getElementById('dealColab2')?.value || '').trim();
  body.colaborador3 = (document.getElementById('dealColab3')?.value || '').trim();

  const debug = (typeof techMode !== 'undefined' && techMode.checked) ? '&debug=1' : '';
  const url = dryRun ? `/api/create-deal?dry_run=1${debug}` : `/api/create-deal${debug}`;

  setStatus(dStatus, dryRun ? 'Generando vista previa de Deal...' : 'Creando Deal/TRATO...', 'info');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();

    // Mostrar banner en rojo si corresponde (409 duplicado o warning)
    if (json && json.warning_banner) {
      setStatus(dStatus, json.warning_banner, res.ok ? 'info' : 'error');
    } else {
      setStatus(dStatus, json.message || (res.ok ? 'OK' : 'Error'), res.ok ? 'ok' : 'error');
    }

    renderDealResult(json);

    if (dryRun || (typeof techMode !== 'undefined' && techMode.checked) || !res.ok) {
      if (dDetails) dDetails.open = true;
      if (dOut) dOut.textContent = JSON.stringify(json, null, 2);
    } else {
      if (dDetails) dDetails.open = false;
      if (dOut) dOut.textContent = '';
    }
  } catch (err) {
    setStatus(dStatus, err.message || String(err), 'error');
  }
}

const btnDealPreview = document.getElementById('btnDealPreview');
const btnDealCreate = document.getElementById('btnDealCreate');
if (btnDealPreview) btnDealPreview.addEventListener('click', () => callDeal(true));
if (btnDealCreate) btnDealCreate.addEventListener('click', () => callDeal(false));




// -------------------------
// Pipelines selector (por nombre)
// -------------------------
async function loadPipelinesForDealForm() {
  const sel = document.getElementById('dealPipelineId');
  if (!sel) return;

  sel.innerHTML = `<option value="">Cargando pipelines...</option>`;
  try {
    const res = await fetch('/api/pipelines');
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Error cargando pipelines');

    const pipelines = json.pipelines || [];
    window.__pipelinesById = {};
    pipelines.forEach(p => { window.__pipelinesById[String(p.id)] = p.name; });

    const help = document.getElementById('dealPipelineHelp');
    if (help) help.textContent = '';

    sel.innerHTML = `<option value="">Selecciona pipeline...</option>` + pipelines
      .map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.id})</option>`)
      .join('');

    // Default Bariátrica si existe
    if (window.__pipelinesById["1290779"]) sel.value = "1290779";

  } catch (err) {
    sel.innerHTML = `<option value="">No se pudieron cargar pipelines</option>`;
    const help = document.getElementById('dealPipelineHelp');
    if (help) help.textContent = err.message || String(err);

    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', loadPipelinesForDealForm);


// Manual pipeline toggle
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('toggleManualPipeline');
  const wrap = document.getElementById('manualPipelineWrap');
  if (btn && wrap) {
    btn.addEventListener('click', () => {
      wrap.style.display = (wrap.style.display === 'none' ? 'block' : 'none');
    });
  }
});


// -------------------------
// Owners selector (Dueño del Deal)
// -------------------------
async function loadOwnersForDealForm() {
  const sel = document.getElementById('dealOwnerId');
  const help = document.getElementById('dealOwnerHelp');
  if (!sel) return;

  sel.innerHTML = `<option value="">Cargando dueños...</option>`;
  try {
    const res = await fetch('/api/owners');
    const json = await res.json();

    if (!res.ok || !json.ok) throw new Error(json.error || 'Error cargando dueños');

    const owners = json.owners || [];
    window.__ownersById = {};
    owners.forEach(o => { window.__ownersById[String(o.id)] = o.name; });

    sel.innerHTML = `<option value="">Selecciona dueño...</option>` + owners
      .map(o => `<option value="${o.id}">${escapeHtml(o.name)} (${o.id})</option>`)
      .join('');

    if (help) help.textContent = json.fallback ? 'Dueños cargados por fallback.' : '';
  } catch (err) {
    sel.innerHTML = `<option value="">No se pudieron cargar dueños</option>`;
    if (help) help.textContent = err.message || String(err);
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', loadOwnersForDealForm);



async function loadDealListChoices(fieldName, selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = `<option value="">Cargando...</option>`;
  try {
    const res = await fetch(`/api/deal-list-choices?field=${encodeURIComponent(fieldName)}`);
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.message || json.error || 'Error cargando');
    const choices = json.choices || [];
    sel.innerHTML = `<option value="">(opcional)</option>` + choices.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  } catch (e) {
    sel.innerHTML = `<option value="">(opcional)</option>`;
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadDealListChoices('CIRUJANO BARIÁTRICO', 'dealCirujanoBariatrico');
  loadDealListChoices('CIRUJANO PLASTICO', 'dealCirujanoPlastico');
  loadDealListChoices('CIRUJANO DE BALON', 'dealCirujanoBalon');
});

