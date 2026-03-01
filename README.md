# Portal (Render) · Búsqueda solo por RUT_normalizado

Portal mínimo (Node + Express) pensado para desplegarse en **Render.com**.

## Qué hace

- Recibe un RUT, lo **normaliza** y **valida DV**.
- Busca **solo** por el campo custom **RUT_normalizado** (contactos y deals) usando **Sell Search API v3**.
- Reglas:
  - **No pueden existir 2 contactos con el mismo RUT_normalizado** → responde **409**.
  - **No pueden existir 2 deals en el mismo pipeline con el mismo RUT_normalizado** → si envías `pipelineId`, responde **409**.

## Endpoints

- `GET /health` → `ok`
- `POST /api/search-rut` → JSON
  - body: `{ "rut": "12.345.678-k", "pipelineId": 1 }`

Nuevos (Drive/Docs/PDF):

- `POST /api/docs/generate-batch` → genera PDFs desde templates en Drive
  - body: `{ "deal_id": 123, "doc_types": ["exam_order","recipe"] }`
  - soporta `?dry_run=1`
- `GET /api/deal-context?deal_id=123` → trae deal+contact para deep-link (portal?deal_id=123)

## Variables de entorno (Render)

Obligatoria:

- `SELL_ACCESS_TOKEN` (Bearer token)

Para generación de documentos (Google Drive/Docs):

- `GOOGLE_ROOT_FOLDER_ID` (o `ROOT_FOLDER_ID`) → carpeta raíz (ideal en Shared Drive) donde se crean carpetas de pacientes
- Credenciales Service Account (una de estas opciones):
  - `GOOGLE_SERVICE_ACCOUNT_JSON` (recomendado, JSON completo en una sola línea)
  - **o** `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`
- `DOC_TEMPLATES_JSON` → JSON map de `doc_type -> template_file_id`.
  - Ej: `{"exam_order":"1AAA...","recipe":"1BBB...","inform":"1CCC..."}`
- `ALLOW_DOCS_WRITE=true` (o reutiliza `ALLOW_WRITE=true`) para permitir generación real (sin esto, solo dry-run)

Opcionales:

- `CONTACT_RUT_NORMALIZED_FIELD` (por defecto: `RUT_normalizado`)
- `DEAL_RUT_NORMALIZED_FIELD` (por defecto: `RUT_normalizado`)
- `SELL_DESKTOP_BASE_URL` (por defecto: `https://clinyco.zendesk.com/sales`)
- `SELL_MOBILE_CONTACT_BASE_URL` (por defecto: `https://app.futuresimple.com/crm`)
- `SELL_MOBILE_DEAL_BASE_URL` (por defecto: `https://app.futuresimple.com/sales`)

> Los custom fields se resuelven por nombre usando `/v3/{resource}/custom_fields`. También puedes pasar directamente el `search_api_id` (ej: `custom_fields.contact:2540090` o `custom_fields.2759433`) o el ID numérico.

## Deploy en Render

1. Sube este repo a GitHub.
2. Render → **New** → **Web Service** → conecta el repo.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Agrega variables de entorno (al menos `SELL_ACCESS_TOKEN`).

Render setea `PORT` automáticamente. El servidor escucha `process.env.PORT`.

## Desarrollo local

```bash
npm install
SELL_ACCESS_TOKEN=... npm start
# abrir http://localhost:3000
```


### Templates sin tocar Render

Configura una vez `TEMPLATE_FOLDER_ID` (carpeta Drive con plantillas). Luego, para agregar nuevas plantillas solo las copias a esa carpeta.
