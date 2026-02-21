/* server.js */
require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");
const { Readable } = require("stream");

// ---------------------------
// App init
// ---------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

// ✅ CORS + Preflight (IMPORTANTE: debe ir DESPUÉS de crear `app`)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, X-API-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------
// Helpers
// ---------------------------
const PORT = Number(process.env.PORT || 3000);
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const SELL_BASE_URL = process.env.SELL_BASE_URL || "https://api.getbase.com";
const SELL_PAT = process.env.SELL_PAT || "";
const RENDER_API_KEY = process.env.RENDER_API_KEY || "";

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ["true", "1", "yes", "y", "si", "sí"].includes(s);
}

function safeJsonParse(str, fallback) {
  try {
    if (typeof str !== "string") return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function fmtYYYYMMDD(date = new Date()) {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function buildFilename(pattern, payload) {
  const ymd = fmtYYYYMMDD(new Date());
  const base = String(pattern || "output_{YYYYMMDD}_{object.run}")
    .replace(/\{([^}]+)\}/g, (_, token) => {
      const t = token.trim();
      if (t === "YYYYMMDD") return ymd;
      const val = getByPath(payload, t);
      return val === undefined || val === null || val === "" ? "NA" : String(val);
    })
    .replace(/[/\\]/g, "_"); // sanitiza

  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function normalizeDriveId(input) {
  if (!input) return "";
  const s = String(input).trim();

  const m1 = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];

  const m2 = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];

  const m3 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m3) return m3[1];

  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authGuard(req, res, next) {
  if (!RENDER_API_KEY) return next();
  const key = req.header("x-api-key");
  if (key !== RENDER_API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------------------------
// Google Clients
// ---------------------------
function makeGoogleAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
}

async function makeGoogleClients() {
  const auth = makeGoogleAuth();
  await auth.authorize();

  return {
    auth,
    sheets: google.sheets({ version: "v4", auth }),
    drive: google.drive({ version: "v3", auth }),
    docs: google.docs({ version: "v1", auth }),
  };
}

// ---------------------------
// Config cache (Sheets)
// ---------------------------
const CONFIG_CACHE = { ts: 0, ttlMs: 60_000, data: null };

async function loadConfig(clients) {
  const now = Date.now();
  if (CONFIG_CACHE.data && now - CONFIG_CACHE.ts < CONFIG_CACHE.ttlMs) return CONFIG_CACHE.data;

  if (!SHEETS_SPREADSHEET_ID) throw new Error("Missing env: SHEETS_SPREADSHEET_ID");

  const [templatesResp, packagesResp] = await Promise.all([
    clients.sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_SPREADSHEET_ID,
      range: "templates!A:K",
      valueRenderOption: "FORMATTED_VALUE",
    }),
    clients.sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_SPREADSHEET_ID,
      range: "exam_packages!A:G",
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  function rowsToObjects(values) {
    const rows = values || [];
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => String(h || "").trim());
    return rows
      .slice(1)
      .filter((r) => r.some((cell) => String(cell || "").trim() !== ""))
      .map((r) => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = r[i];
        });
        return obj;
      });
  }

  const templatesRaw = rowsToObjects(templatesResp.data.values);
  const packagesRaw = rowsToObjects(packagesResp.data.values);

  const templates = templatesRaw
    .map((t) => ({
      template_key: t.template_key,
      display_name: t.display_name,
      engine: t.engine,
      doc_template_id: t.doc_template_id,
      output_filename_pattern: t.output_filename_pattern,
      required_placeholders: safeJsonParse(t.required_placeholders, []),
      default_package_key: t.default_package_key,
      keep_intermediate_doc: toBool(t.keep_intermediate_doc),
      version: t.version,
      is_active: toBool(t.is_active),
      notes: t.notes,
    }))
    .filter((t) => t.is_active);

  const exam_packages = packagesRaw
    .map((p) => ({
      package_key: p.package_key,
      display_name: p.display_name,
      exams: safeJsonParse(p.exams, []),
      default_template_key: p.default_template_key,
      version: p.version,
      is_active: toBool(p.is_active),
      notes: p.notes,
    }))
    .filter((p) => p.is_active);

  const data = {
    templates,
    exam_packages,
    byTemplateKey: Object.fromEntries(templates.map((t) => [t.template_key, t])),
    byPackageKey: Object.fromEntries(exam_packages.map((p) => [p.package_key, p])),
  };

  CONFIG_CACHE.data = data;
  CONFIG_CACHE.ts = now;
  return data;
}

// ---------------------------
// Drive robustness helpers
// ---------------------------
async function waitForFile(drive, fileId) {
  // 6 intentos, delay creciente
  const delays = [200, 350, 550, 800, 1200, 1600];

  for (let i = 0; i < delays.length; i++) {
    try {
      await drive.files.get({
        fileId,
        supportsAllDrives: true,
        fields: "id",
      });
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      const notFound = msg.toLowerCase().includes("file not found") || e?.code === 404;
      if (!notFound) throw e;
      await sleep(delays[i]);
    }
  }
  throw new Error(`File not found (after retries): ${fileId}`);
}

// ---------------------------
// Sell API (Notas)
// ---------------------------
async function sellCreateNote({ resource_type, resource_id, content }) {
  if (!SELL_PAT) throw new Error("Missing env: SELL_PAT");

  const resp = await fetch(`${SELL_BASE_URL}/v2/notes`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${SELL_PAT}`,
    },
    body: JSON.stringify({ resource_type, resource_id, content }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Sell note error ${resp.status}: ${text}`);

  return text ? JSON.parse(text) : {};
}

// ---------------------------
// Render: template -> pdf
// ---------------------------
async function renderGoogleDocToPdf({ clients, template, payload, folderId }) {
  const drive = clients.drive;
  const docs = clients.docs;

  // 1) COPY template -> tmp doc (IMPORTANTE: NO poner parents aquí, para evitar issues de propagación)
  const copied = await drive.files.copy({
    fileId: template.doc_template_id,
    supportsAllDrives: true,
    requestBody: {
      name: `tmp_${Date.now()}_${template.template_key}`,
    },
    fields: "id",
  });

  const docId = copied.data.id;

  // esperar que exista el doc temporal
  await waitForFile(drive, docId);

  // 2) Reemplazo placeholders
  const required = Array.isArray(template.required_placeholders) ? template.required_placeholders : [];
  const missing = [];

  const requests = required.map((path) => {
    const value = getByPath(payload, path);
    if (value === undefined || value === null || value === "") missing.push(path);
    return {
      replaceAllText: {
        containsText: { text: `{{${path}}}`, matchCase: true },
        replaceText: value === undefined || value === null ? "" : String(value),
      },
    };
  });

  if (missing.length) {
    if (!template.keep_intermediate_doc) {
      try {
        await drive.files.delete({ fileId: docId, supportsAllDrives: true });
      } catch {}
    }
    const err = new Error(`Missing required placeholders: ${missing.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }

  if (requests.length) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests },
    });
  }

  // 3) Export PDF (esperar antes por seguridad)
  await waitForFile(drive, docId);

  const exportedPdf = await drive.files.export(
    { fileId: docId, mimeType: "application/pdf" },
    { responseType: "arraybuffer" }
  );

  // 4) Upload PDF to target folder
  const filename = buildFilename(template.output_filename_pattern, payload);
  const pdfBuffer = Buffer.isBuffer(exportedPdf.data) ? exportedPdf.data : Buffer.from(exportedPdf.data);

  const uploaded = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: filename,
      parents: folderId ? [folderId] : undefined,
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(pdfBuffer),
    },
    fields: "id, webViewLink, name",
  });

  // 5) Cleanup tmp
  if (!template.keep_intermediate_doc) {
    try {
      await drive.files.delete({ fileId: docId, supportsAllDrives: true });
    } catch {
      // si no puede borrar, no rompemos
    }
  }

  return {
    pdf_file_id: uploaded.data.id,
    pdf_name: uploaded.data.name,
    pdf_web_view_url: uploaded.data.webViewLink,
    tmp_doc_id: template.keep_intermediate_doc ? docId : undefined,
  };
}

// ---------------------------
// Extra endpoint: Ensure folder for a deal
// ---------------------------
async function ensureDealFolder({ clients, driveRootFolderId, dealId }) {
  const drive = clients.drive;

  const rootId = normalizeDriveId(driveRootFolderId);
  if (!rootId) {
    const err = new Error("drive_root_folder_id is required");
    err.statusCode = 400;
    throw err;
  }
  if (!dealId) {
    const err = new Error("deal_id is required");
    err.statusCode = 400;
    throw err;
  }

  // Obtener driveId (si es Shared Drive)
  const rootMeta = await drive.files.get({
    fileId: rootId,
    supportsAllDrives: true,
    fields: "id,name,driveId",
  });

  const driveId = rootMeta.data.driveId || null;
  const folderName = `Deal_${dealId}`;

  // Buscar si existe
  const q =
    `'${rootId}' in parents and trashed=false and ` +
    `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`;

  const listParams = {
    q,
    fields: "files(id,name,webViewLink)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 10,
  };

  // Si está en Shared Drive, usar corpora=drive + driveId (más confiable)
  if (driveId) {
    listParams.corpora = "drive";
    listParams.driveId = driveId;
  } else {
    listParams.corpora = "user";
  }

  const found = await drive.files.list(listParams);
  if (found.data.files && found.data.files.length > 0) {
    const f = found.data.files[0];
    return {
      folder_id: f.id,
      name: f.name,
      web_view_url: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`,
      drive_id: driveId || undefined,
    };
  }

  // Crear carpeta
  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootId],
    },
    fields: "id,name,webViewLink",
  });

  return {
    folder_id: created.data.id,
    name: created.data.name,
    web_view_url: created.data.webViewLink || `https://drive.google.com/drive/folders/${created.data.id}`,
    drive_id: driveId || undefined,
  };
}

// ---------------------------
// Routes
// ---------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/v1/config", authGuard, async (req, res) => {
  try {
    const clients = await makeGoogleClients();
    const config = await loadConfig(clients);
    res.json({ templates: config.templates, exam_packages: config.exam_packages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Usado por tu botón "Crear Drive Carpeta"
app.post("/v1/drive/folder/ensure", authGuard, async (req, res) => {
  try {
    const payload = req.body || {};
    const clients = await makeGoogleClients();

    const out = await ensureDealFolder({
      clients,
      driveRootFolderId: payload.drive_root_folder_id,
      dealId: payload.deal_id,
    });

    res.json(out);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/v1/render", authGuard, async (req, res) => {
  try {
    const payload = req.body || {};

    const clients = await makeGoogleClients();
    const config = await loadConfig(clients);

    const templateKey = payload.template_key;
    const packageKey = payload.package_key;

    // Resolver template
    let template = templateKey ? config.byTemplateKey[templateKey] : null;
    if (!template && packageKey) {
      const pkg = config.byPackageKey[packageKey];
      if (pkg?.default_template_key) template = config.byTemplateKey[pkg.default_template_key];
    }
    if (!template) return res.status(400).json({ error: "template not found (template_key / package_key)" });

    const folderId = normalizeDriveId(payload?.deal?.folder_id || payload?.folder_id || "");

    const out = await renderGoogleDocToPdf({
      clients,
      template,
      payload,
      folderId: folderId || null,
    });

    // Nota en Sell (opcional)
    const sell = payload.sell;
    if (sell?.resource_type && sell?.resource_id) {
      const noteText =
        `📄 Documento generado: ${template.display_name}\n` +
        `Archivo: ${out.pdf_name}\n` +
        `Link: ${out.pdf_web_view_url}\n` +
        (packageKey ? `Pack: ${packageKey}\n` : "") +
        (payload?.actor?.email ? `Solicitado por: ${payload.actor.email}\n` : "");

      const note = await sellCreateNote({
        resource_type: sell.resource_type,
        resource_id: sell.resource_id,
        content: noteText,
      });

      return res.json({ pdf: out, note });
    }

    return res.json({ pdf: out });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
