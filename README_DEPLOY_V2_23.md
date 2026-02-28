# V2_23 CLEAN STABLE — Deploy checklist (Render)

## Env Vars (Render → Service → Environment)
- SELL_ACCESS_TOKEN = Zendesk Sell API token
- ALLOW_WRITE = true (only if you want to create contacts/deals)
- Optional:
  - SELL_DESKTOP_BASE_URL (default: https://clinyco.zendesk.com/sales)
  - SELL_MOBILE_CONTACT_BASE_URL (default: https://app.futuresimple.com/crm)
  - SELL_MOBILE_DEAL_BASE_URL (default: https://app.futuresimple.com/sales)
  - STAGE_BY_PIPELINE (optional mapping) e.g. 4823817:12345,4959507:67890

## Smoke tests
1) Pipelines must return JSON (never HTML):
   GET /api/pipelines

2) Dry run deal preview:
   POST /api/create-deal?dry_run=1

3) Create deal (when ALLOW_WRITE=true):
   POST /api/create-deal


## Templates dinámicos (recomendado)

- Configura `TEMPLATE_FOLDER_ID` con la carpeta de Drive donde están las plantillas (Google Docs).
- El portal listará automáticamente los templates desde `/api/docs/templates`.
- Para agregar un nuevo template: solo cópialo a esa carpeta en Drive. No necesitas tocar Render.

