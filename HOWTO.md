# ZIP para PR — Fix placeholders + Header (modo portal)

## Qué arregla
- Reemplaza placeholders del tipo:
  - {{fecha}}
  - {{object.nombres}}, {{object.paterno}}, {{object.run}}, {{object.prevision}}, etc.
  - {{object.get_edad()}}
- Inserta header gris (9pt):
  - DEAL.<deal_id> <email>
  - Si no envías email, igual queda "DEAL.<deal_id>" (portal no se rompe).

## Cómo aplicar
```bash
git checkout -b fix/portal-placeholders-header
git apply portal_drive_docs_header.patch
git apply portal_server_placeholders_header_relaxed.patch
git status
git commit -am "Portal: placeholders /v1/render + header DEAL.<id> agente@email"
git push -u origin fix/portal-placeholders-header
```

## Prueba rápida (opcional)
POST /api/docs/generate-batch con:
- deal_id
- (opcional) agent_email
