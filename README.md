# Documentos Dinámicos PDF (Google Docs + Drive + Sheets + Zendesk Sell)

Servicio backend en **Node.js + Express** para generar PDFs desde templates de Google Docs usando configuración en Google Sheets.

## Requisitos

- Node.js **20+**
- Cuenta de servicio de Google con acceso a:
  - Google Sheets (lectura)
  - Google Docs (edición del documento copiado)
  - Google Drive (copiar/exportar/subir/borra archivo intermedio)
- Spreadsheet con pestañas:
  - `templates`
  - `exam_packages`

## Instalación rápida

```bash
npm install
cp .env.example .env
# completar variables de entorno
npm start
```

Servidor por defecto en `http://localhost:3000`.

---

## Variables de entorno

```env
PORT=3000
GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SHEETS_SPREADSHEET_ID=...
SELL_BASE_URL=https://api.getbase.com
SELL_PAT=...
RENDER_API_KEY=change_me
```

Notas:
- Si `RENDER_API_KEY` existe, `/v1/config` y `/v1/render` requieren header `x-api-key`.
- Si se envía `sell.resource_type` y `sell.resource_id`, se intentará crear nota en Sell; para eso `SELL_BASE_URL` y `SELL_PAT` deben estar configurados.

---

## Esquema de configuración en Google Sheets

### Pestaña `templates`

Columnas esperadas:

- `template_key`
- `display_name`
- `engine`
- `doc_template_id`
- `output_filename_pattern`
- `required_placeholders` (JSON array string)
- `default_package_key`
- `keep_intermediate_doc`
- `version`
- `is_active`
- `notes`

Ejemplo de `required_placeholders`:

```json
["fecha","object.nombres","object.run"]
```

### Pestaña `exam_packages`

Columnas esperadas:

- `package_key`
- `display_name`
- `exams` (JSON array string)
- `default_template_key`
- `version`
- `is_active`
- `notes`

Ejemplo de `exams`:

```json
[{"code":"0301045","name":"Hemograma"}]
```

### Reglas

- Solo se cargan filas con `is_active = TRUE`.
- Configuración cacheada por **60 segundos** en memoria.

---

## Placeholders en Google Docs

Formato exacto:

- `{{fecha}}`
- `{{object.nombres}}`
- `{{object.run}}`

El reemplazo se hace con `matchCase: true`.

---

## Endpoints

### `GET /health`

Respuesta:

```json
{ "ok": true }
```

### `GET /v1/config`

Protegido por `x-api-key` si `RENDER_API_KEY` existe.

Respuesta:

```json
{
  "templates": [...],
  "exam_packages": [...]
}
```

### `POST /v1/render`

Protegido por `x-api-key` si `RENDER_API_KEY` existe.

#### Request ejemplo

```json
{
  "template_key": "ORDEN_PRE_PAD_MUJER",
  "package_key": "PRE_PAD_BASE",
  "fecha": "20 de Mayo, 2025",
  "object": {
    "run": "12.345.678-9",
    "nombres": "JUANA",
    "paterno": "PÉREZ",
    "prevision": "ISAPRE",
    "comuna": "LAS CONDES"
  },
  "deal": { "id": 123, "folder_id": "DRIVE_FOLDER_ID" },
  "sell": { "resource_type": "deal", "resource_id": 123 },
  "actor": { "email": "agente@tuempresa.cl" }
}
```

#### Flujo

1. Resuelve template por `template_key`; si no viene, intenta `package_key -> exam_packages.default_template_key`.
2. Valida placeholders requeridos (`required_placeholders`) por path (`object.run`, `fecha`, etc.).
3. Copia el Google Doc template.
4. Reemplaza placeholders con Docs API (`replaceAllText`).
5. Exporta a PDF.
6. Sube PDF al folder destino (`deal.folder_id` o `payload.folder_id`).
7. Nombre de archivo usando `output_filename_pattern`:
   - Tokens soportados: `{YYYYMMDD}` y `{<path>}` (ej. `{object.run}`)
   - Sanitiza `/` y `\` por `_`
   - Asegura sufijo `.pdf`
8. Borra doc intermedio si `keep_intermediate_doc = FALSE`.
9. Si hay datos de Sell, crea nota en `/v2/notes`.

#### Respuesta

Sin nota:

```json
{
  "pdf": {
    "file_id": "...",
    "name": "...pdf",
    "web_view_url": "https://drive.google.com/..."
  }
}
```

Con nota:

```json
{
  "pdf": { "file_id": "...", "name": "...pdf", "web_view_url": "..." },
  "note": { "data": { "id": "..." } }
}
```

#### Errores esperados

- `400` si no se puede resolver template.
- `400` si faltan placeholders requeridos:

```json
{
  "error": "Missing required placeholders",
  "missing": ["object.run", "fecha"]
}
```

- `401` si falta o es inválido `x-api-key` cuando aplica.
- `500` para errores externos (Google/Sell).

---

## cURL de ejemplo

### Health

```bash
curl http://localhost:3000/health
```

### Config con API key

```bash
curl -H "x-api-key: $RENDER_API_KEY" \
  http://localhost:3000/v1/config
```

### Render

```bash
curl -X POST http://localhost:3000/v1/render \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RENDER_API_KEY" \
  -d '{
    "template_key":"ORDEN_PRE_PAD_MUJER",
    "package_key":"PRE_PAD_BASE",
    "fecha":"20 de Mayo, 2025",
    "object":{"run":"12.345.678-9","nombres":"JUANA"},
    "deal":{"id":123,"folder_id":"DRIVE_FOLDER_ID"},
    "sell":{"resource_type":"deal","resource_id":123},
    "actor":{"email":"agente@tuempresa.cl"}
  }'
```

---

## Shared Drive troubleshooting

Si el template o la carpeta destino están en un **Shared Drive**:

- Asegura que la Service Account tenga acceso al archivo template y a la carpeta destino.
- Recomendado: agregar la Service Account como miembro del Shared Drive.
- Este servicio ya incluye soporte explícito para Shared Drives en operaciones de Drive (`copy`, `create`, `delete`) usando `supportsAllDrives: true`.
