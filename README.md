# Generar Exámenes | Drive (Zendesk Sell App)

App privada para Zendesk Sell (ubicación: deal_card). Permite:

- Asegurar carpeta en Drive
- Generar documento desde plantilla
- Abrir carpeta / documento
- Crear nota en Sell con links

## Estructura

- manifest.json (raíz)
- assets/
  - iframe.html
  - app.js
  - style.css
- translations/
  - es.json
  - en.json

## Parámetros de instalación

- backend_base_url (opcional): si se omite, usa https://sell-medinet-documentos-dinamicos-pdf.onrender.com
- backend_api_key (secure, header)
- drive_root_folder_id (required)
- drive_shared_drive_id (opcional)
