require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '1mb' }));

const REQUIRED_ENVS = ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'SHEETS_SPREADSHEET_ID'];
for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    // eslint-disable-next-line no-console
    console.warn(`Missing required env: ${key}`);
  }
}

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
  ],
});

const sheets = google.sheets({ version: 'v4', auth });
const docs = google.docs({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });

const CONFIG_TTL_MS = 60 * 1000;
const configCache = {
  expiresAt: 0,
  data: null,
};

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  return ['true', '1', 'yes'].includes(String(value).trim().toLowerCase());
}

function parseJsonArray(raw, fieldName) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON array`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON in ${fieldName}: ${error.message}`);
  }
}

function mapRowsToObjects(rows) {
  const [header = [], ...dataRows] = rows;
  return dataRows.map((row) => {
    const obj = {};
    header.forEach((column, index) => {
      obj[column] = row[index] ?? '';
    });
    return obj;
  });
}

async function readSheet(tabName) {
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });
  return response.data.values || [];
}

function normalizeTemplates(rows) {
  return mapRowsToObjects(rows)
    .filter((row) => parseBoolean(row.is_active))
    .map((row) => ({
      template_key: row.template_key,
      display_name: row.display_name,
      engine: row.engine,
      doc_template_id: row.doc_template_id,
      output_filename_pattern: row.output_filename_pattern,
      required_placeholders: parseJsonArray(row.required_placeholders, `templates.${row.template_key}.required_placeholders`),
      default_package_key: row.default_package_key,
      keep_intermediate_doc: parseBoolean(row.keep_intermediate_doc),
      version: row.version,
      is_active: true,
      notes: row.notes,
    }));
}

function normalizeExamPackages(rows) {
  return mapRowsToObjects(rows)
    .filter((row) => parseBoolean(row.is_active))
    .map((row) => ({
      package_key: row.package_key,
      display_name: row.display_name,
      exams: parseJsonArray(row.exams, `exam_packages.${row.package_key}.exams`),
      default_template_key: row.default_template_key,
      version: row.version,
      is_active: true,
      notes: row.notes,
    }));
}

async function loadConfig() {
  if (configCache.data && Date.now() < configCache.expiresAt) {
    return configCache.data;
  }

  const [templatesRows, packagesRows] = await Promise.all([
    readSheet('templates'),
    readSheet('exam_packages'),
  ]);

  const config = {
    templates: normalizeTemplates(templatesRows),
    exam_packages: normalizeExamPackages(packagesRows),
  };

  configCache.data = config;
  configCache.expiresAt = Date.now() + CONFIG_TTL_MS;
  return config;
}

function getValueByPath(obj, path) {
  const segments = path.split('.');
  let current = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function requireApiKey(req, res, next) {
  if (!process.env.RENDER_API_KEY) return next();
  if (req.header('x-api-key') !== process.env.RENDER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function resolveTemplate(config, payload) {
  if (payload.template_key) {
    return config.templates.find((t) => t.template_key === payload.template_key);
  }

  if (!payload.package_key) return null;
  const examPackage = config.exam_packages.find((p) => p.package_key === payload.package_key);
  if (!examPackage) return null;

  return config.templates.find((t) => t.template_key === examPackage.default_template_key);
}

function buildPdfFileName(pattern, payload) {
  const dateToken = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = (pattern || 'documento_{YYYYMMDD}')
    .replace(/{YYYYMMDD}/g, dateToken)
    .replace(/{([^}]+)}/g, (_, tokenPath) => {
      const value = getValueByPath(payload, tokenPath);
      return value == null ? '' : String(value);
    })
    .replace(/[\\/]/g, '_')
    .trim();

  const finalName = base || `documento_${dateToken}`;
  return finalName.toLowerCase().endsWith('.pdf') ? finalName : `${finalName}.pdf`;
}

async function createSellNote(payload, template, pdf) {
  const { sell = {}, actor = {} } = payload;
  if (!sell.resource_type || !sell.resource_id) {
    return null;
  }

  if (!process.env.SELL_PAT || !process.env.SELL_BASE_URL) {
    throw new Error('SELL_PAT and SELL_BASE_URL are required to create Sell notes');
  }

  const lines = [
    `Template: ${template.display_name || template.template_key}`,
    `PDF: ${pdf.name}`,
    `Link: ${pdf.web_view_url}`,
  ];
  if (payload.package_key) lines.push(`Package: ${payload.package_key}`);
  if (actor.email) lines.push(`Actor: ${actor.email}`);

  const response = await fetch(`${process.env.SELL_BASE_URL}/v2/notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SELL_PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resource_type: sell.resource_type,
      resource_id: sell.resource_id,
      content: lines.join('\n'),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sell note creation failed: ${response.status} ${body}`);
  }

  return response.json();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/v1/config', requireApiKey, async (_req, res) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/render', requireApiKey, async (req, res) => {
  let copiedDocId;
  try {
    const payload = req.body || {};
    const config = await loadConfig();
    const template = resolveTemplate(config, payload);

    if (!template) {
      return res.status(400).json({ error: 'Unable to resolve template from template_key/package_key' });
    }

    const missing = template.required_placeholders.filter((path) => {
      const value = getValueByPath(payload, path);
      return value === undefined || value === null || value === '';
    });

    if (missing.length > 0) {
      return res.status(400).json({ error: 'Missing required placeholders', missing });
    }

    const folderId = payload?.deal?.folder_id || payload.folder_id;
    const copyResponse = await drive.files.copy({
      supportsAllDrives: true,
      fileId: template.doc_template_id,
      requestBody: {
        name: `tmp_${Date.now()}_${template.template_key}`,
        ...(folderId ? { parents: [folderId] } : {}),
      },
      fields: 'id',
    });

    copiedDocId = copyResponse.data.id;

    await docs.documents.batchUpdate({
      documentId: copiedDocId,
      requestBody: {
        requests: template.required_placeholders.map((path) => ({
          replaceAllText: {
            containsText: {
              text: `{{${path}}}`,
              matchCase: true,
            },
            replaceText: String(getValueByPath(payload, path)),
          },
        })),
      },
    });

    const exportedPdf = await drive.files.export(
      {
        fileId: copiedDocId,
        mimeType: 'application/pdf',
      },
      {
        responseType: 'arraybuffer',
      }
    );

    const pdfName = buildPdfFileName(template.output_filename_pattern, payload);
    const createdPdf = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: pdfName,
        ...(folderId ? { parents: [folderId] } : {}),
      },
      media: {
        mimeType: 'application/pdf',
        body: Buffer.from(exportedPdf.data),
      },
      fields: 'id,name,webViewLink',
    });

    if (!template.keep_intermediate_doc && copiedDocId) {
      await drive.files.delete({ fileId: copiedDocId, supportsAllDrives: true });
      copiedDocId = null;
    }

    const pdf = {
      file_id: createdPdf.data.id,
      name: createdPdf.data.name,
      web_view_url: createdPdf.data.webViewLink,
    };

    const note = await createSellNote(payload, template, pdf);
    if (note) {
      return res.json({ pdf, note });
    }

    return res.json({ pdf });
  } catch (error) {
    if (copiedDocId) {
      try {
        await drive.files.delete({ fileId: copiedDocId, supportsAllDrives: true });
      } catch (_cleanupErr) {
        // noop
      }
    }
    return res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port}`);
});
