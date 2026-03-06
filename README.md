# sell-medinet-backend

Backend mínimo en Node.js + Express para conectar Zendesk Sell con Medinet mediante endpoints protegidos por API key.

## Qué hace este servicio

- Expone `GET /` para validar que el backend está activo.
- Expone `POST /medinet/import` para recibir datos JSON.
- Expone `POST /medinet/search` para preparar búsquedas por identificador (`DNI` o `RUN`).
- Protege endpoints con header `X-API-Key` contra la variable de entorno `API_KEY`.
- Para `RUN`, acepta entrada “humana” (con puntos/guion), **valida DV chileno (módulo 11)** y responde tanto en formato UX como normalizado.

---

## Requisitos

- Node.js **>= 18** (ver `"engines"` en `package.json`)

---

## Variables de entorno

- `API_KEY` (**obligatoria**) — clave que debe venir en el header `X-API-Key`.
- `PORT` (opcional en local). En Render normalmente viene definida automáticamente.

Ejemplo local:
```bash
export API_KEY="tu_api_key"
export PORT=3000

---

## Fix CORS para ZAF/Portal (navegador)

Para que **Zendesk Sell App (ZAF)** y el **Portal (browser)** puedan llamar a `POST /medinet/import` y `POST /medinet/search`, este backend responde preflight `OPTIONS` y agrega headers:
- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Headers: Content-Type, X-API-Key`
- `Access-Control-Allow-Methods: POST, OPTIONS`

Configurable por env:
- `CORS_ALLOW_ORIGINS` (coma-separado). Ej:
  - `https://clinyco.zendesk.com,https://app.futuresimple.com`
  - o `*` para permitir cualquier origen (no recomendado).

> `GET /medinet/payload/:key` sigue restringido a `https://clinyco.medinetapp.com`.

## API_KEY

- Si `API_KEY` **esta seteada**, se exige `X-API-Key`.
- Si `API_KEY` **no** esta seteada, se permite la llamada (modo compatibilidad para evitar caidas).

Recomendacion: setear `API_KEY` en Render y en los clientes.
