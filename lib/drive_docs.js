const { Readable } = require('stream');
const { getDrive, getDocs } = require('./google');

function mustRootFolderId() {
  const id = String(process.env.GOOGLE_ROOT_FOLDER_ID || process.env.ROOT_FOLDER_ID || '').trim();
  if (!id) {
    const err = new Error('Falta GOOGLE_ROOT_FOLDER_ID (o ROOT_FOLDER_ID)');
    err.code = 'MISSING_GOOGLE_ROOT_FOLDER_ID';
    throw err;
  }
  return id;
}

function driveFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function docsEditUrl(docId) {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

async function findFolderByNameInParent(drive, parentId, name) {
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
    `'${parentId}' in parents`,
    `name='${String(name).replace(/'/g, "\\'")}'`,
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 10,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  const files = res?.data?.files || [];
  return files.length ? files[0] : null;
}

async function ensureFolder(drive, parentId, name) {
  const existing = await findFolderByNameInParent(drive, parentId, name);
  if (existing?.id) return existing;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });

  return created?.data;
}

async function ensurePatientFolders({ folderName, rootFolderId = null, sharedDriveId = null }) {
  const drive = getDrive();
  const rootId = String(rootFolderId || mustRootFolderId()).trim();

  if (sharedDriveId) {
    // reserved for compatibility with callers that provide shared drive context
    // current Drive operations already use supportsAllDrives/includeItemsFromAllDrives
  }

  const main = await ensureFolder(drive, rootId, folderName);
  const pdf = await ensureFolder(drive, main.id, '00_PDF');
  const docs = await ensureFolder(drive, main.id, '01_Docs_Generados');

  return {
    folder_id: main.id,
    pdf_folder_id: pdf.id,
    docs_folder_id: docs.id,
    folder_url: driveFolderUrl(main.id),
  };
}

async function copyTemplateToFolder({ templateFileId, newName, parentFolderId }) {
  const drive = getDrive();
  const res = await drive.files.copy({
    fileId: templateFileId,
    requestBody: {
      name: newName,
      parents: [parentFolderId],
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });
  return res?.data;
}

async function replacePlaceholdersInDoc({ documentId, placeholders, preserveMissingPlaceholders = false }) {
  const docs = getDocs();

  const requests = Object.entries(placeholders || {})
    .filter(([, v]) => {
      if (v === undefined || v === null) return false;
      if (preserveMissingPlaceholders && String(v).trim() === '') return false;
      return true;
    })
    .map(([k, v]) => ({
      replaceAllText: {
        containsText: { text: `{{${k}}}`, matchCase: true },
        replaceText: String(v),
      },
    }));

  if (!requests.length) return;

  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  });
}


/**
 * Ensure header exists and inserts a gray small text:
 *   DEAL.<dealId> <agentEmail>
 */
async function ensureDealAgentHeader({ documentId, dealId, agentEmail }) {
  const docs = getDocs();
  const safeDealId = String(dealId || '').trim();
  if (!safeDealId) return null;
  const safeEmail = String(agentEmail || '').trim();
  const headerText = `${safeEmail ? `DEAL.${safeDealId} ${safeEmail}` : `DEAL.${safeDealId}`}\n`;

  const readDoc = async () => docs.documents.get({
    documentId,
    fields: 'documentStyle,headers',
  });

  const extractHeaderText = (headerObj) => {
    const chunks = [];
    const content = Array.isArray(headerObj?.content) ? headerObj.content : [];
    for (const el of content) {
      const pe = Array.isArray(el?.paragraph?.elements) ? el.paragraph.elements : [];
      for (const it of pe) {
        const t = it?.textRun?.content;
        if (typeof t === 'string') chunks.push(t);
      }
    }
    return chunks.join('');
  };

  let doc = await readDoc();
  let headersMap = doc?.data?.headers || {};
  let headerId = doc?.data?.documentStyle?.defaultHeaderId || Object.keys(headersMap)[0] || null;

  if (!headerId) {
    const createRes = await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          createHeader: {
            type: 'DEFAULT',
            sectionBreakLocation: { index: 0 },
          },
        }],
      },
    });

    headerId = createRes?.data?.replies?.[0]?.createHeader?.headerId;
    if (!headerId) {
      const err = new Error('No se pudo crear header (headerId vacío).');
      err.code = 'HEADER_CREATE_FAILED';
      throw err;
    }

    doc = await readDoc();
    headersMap = doc?.data?.headers || {};
  }

  const existingText = extractHeaderText(headersMap[headerId]);
  if (existingText.includes(`DEAL.${safeDealId}`)) {
    return { headerId, skipped: true };
  }

  const insertAt = async (index) => {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          { insertText: { location: { segmentId: headerId, index }, text: headerText } },
          {
            updateTextStyle: {
              range: { segmentId: headerId, startIndex: index, endIndex: index + headerText.length },
              textStyle: {
                fontSize: { magnitude: 9, unit: 'PT' },
                foregroundColor: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
              },
              fields: 'fontSize,foregroundColor',
            },
          },
        ],
      },
    });
  };

  try {
    await insertAt(0);
  } catch (_e) {
    await insertAt(1);
  }

  return { headerId };
}

async function exportDocAsPdfBuffer({ fileId }) {
  const drive = getDrive();
  const res = await drive.files.export(
    { fileId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res?.data);
}

async function uploadPdfToFolder({ pdfBuffer, pdfName, parentFolderId }) {
  const drive = getDrive();

  const res = await drive.files.create({
    requestBody: {
      name: pdfName,
      parents: [parentFolderId],
      mimeType: 'application/pdf',
    },
    media: {
      mimeType: 'application/pdf',
      body: Readable.from(pdfBuffer),
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });

  return res?.data;
}

async function listTemplatesInFolder({ folderId, pageSize = 200 } = {}) {
  const drive = getDrive();
  const id = String(folderId || '').trim();
  if (!id) {
    const err = new Error('Falta TEMPLATE_FOLDER_ID (o folder_id) para listar templates');
    err.code = 'MISSING_TEMPLATE_FOLDER_ID';
    throw err;
  }

  // Only Google Docs templates (expandable)
  const q = [
    `'${id}' in parents`,
    `trashed=false`,
    `mimeType='application/vnd.google-apps.document'`,
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id,name,mimeType,modifiedTime)',
    orderBy: 'name',
    pageSize,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  return (res?.data?.files || []).map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    docs_url: docsEditUrl(f.id),
  }));
}

module.exports = {
  listTemplatesInFolder,
  ensurePatientFolders,
  copyTemplateToFolder,
  replacePlaceholdersInDoc,
  ensureDealAgentHeader,
  exportDocAsPdfBuffer,
  uploadPdfToFolder,
  driveFolderUrl,
  driveFileUrl,
  docsEditUrl,
};
