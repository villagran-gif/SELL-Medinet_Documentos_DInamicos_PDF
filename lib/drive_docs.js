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

async function ensurePatientFolders({ folderName }) {
  const drive = getDrive();
  const rootId = mustRootFolderId();

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

async function replacePlaceholdersInDoc({ documentId, placeholders }) {
  const docs = getDocs();

  const requests = Object.entries(placeholders || {})
    .filter(([, v]) => v !== undefined && v !== null)
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
  exportDocAsPdfBuffer,
  uploadPdfToFolder,
  driveFolderUrl,
  driveFileUrl,
  docsEditUrl,
};
