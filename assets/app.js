(function () {
  const client = ZAFClient.init();

  // --------- UI ---------
  const statusEl = document.getElementById("status");
  const debugEl = document.getElementById("debug");
  const debugDetails = document.getElementById("debugDetails");
  const pdfResultEl = document.getElementById("pdfResult");
  const pdfLinkEl = document.getElementById("pdfLink");

  const btnEnsureFolder = document.getElementById("btnEnsureFolder");
  const btnOpenFolder = document.getElementById("btnOpenFolder");
  const btnGenerate = document.getElementById("btnGenerate");
  const btnCreateNote = document.getElementById("btnCreateNote");
  const templateSelect = document.getElementById("templateSelect");

  const DEFAULT_BACKEND_BASE_URL = "https://sell-medinet-documentos-dinamicos-pdf.onrender.com";

  const FIELD_IDS = {
    rut: 2540090,
    birthDate: 2618055,
    emailPrimary: 2533760,
    emailSecondary: 2567316,
    direccion: 2567323,
    comuna: 2547816,
    telA: 2528872,
    telB: 2567315,
    telC: 2577564,
    tramoModalidad: 2758483,
  };

  const FIELD_KEYS = {
    rut: [FIELD_IDS.rut, "RUT o ID", "RUT O ID"],
    birthDate: [FIELD_IDS.birthDate, "Fecha Nacimiento", "Fecha de nacimiento"],
    emailPrimary: [FIELD_IDS.emailPrimary, "Correo electrónico", "Correo"],
    emailSecondary: [FIELD_IDS.emailSecondary, "correo electrónico", "Correo"],
    direccion: [FIELD_IDS.direccion, "Dirección", "Direccion"],
    comuna: [FIELD_IDS.comuna, "Comuna", "Ciudad"],
    telA: [FIELD_IDS.telA, "Teléfono", "Telefono"],
    telB: [FIELD_IDS.telB, "Numero de teléfono", "Número de teléfono", "Telefono"],
    telC: [FIELD_IDS.telC, "Telefono", "Teléfono"],
    tramoModalidad: [FIELD_IDS.tramoModalidad, "Tramo/Modalidad"],
  };

  const state = {
    settings: null,
    deal: null,
    contact: null,
    payload: null,
    deal_folder_url: null,
    deal_folder_id: null,
    last_doc_url: null,
    templates: [],
  };

  // --------- helpers ---------
  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
    scheduleResize();
  }

  function maskSecret(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.length <= 4) return "****";
    return `****${text.slice(-4)}`;
  }

  function sanitizeDebug(value) {
    if (Array.isArray(value)) return value.map(sanitizeDebug);
    if (!value || typeof value !== "object") return value;

    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/api[_-]?key/i.test(key)) out[key] = maskSecret(val);
      else out[key] = sanitizeDebug(val);
    }
    return out;
  }

  function setDebug(obj) {
    if (!debugEl) return;
    const safeObj = typeof obj === "string" ? obj : sanitizeDebug(obj);
    debugEl.textContent = typeof safeObj === "string" ? safeObj : JSON.stringify(safeObj, null, 2);
    scheduleResize();
  }

  function setPdfLink(url) {
    if (!pdfResultEl || !pdfLinkEl) return;
    if (!url) {
      pdfResultEl.style.display = "none";
      pdfLinkEl.href = "#";
      return;
    }
    pdfResultEl.style.display = "block";
    pdfLinkEl.href = url;
  }

  function isObject(x) {
    return x && typeof x === "object" && !Array.isArray(x);
  }

  function toStringValue(val) {
    if (val === null || val === undefined) return "";
    if (isObject(val)) {
      const line1 = val.line1 || val.street || "";
      const city = val.city || "";
      const state = val.state || "";
      const postal = val.postal_code || val.postalCode || "";
      const parts = [line1, city, state, postal]
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      return parts.join(", ");
    }
    return String(val).trim();
  }

  function getField(entity, keys) {
    if (!entity) return "";
    const keyList = (Array.isArray(keys) ? keys : [keys]).filter(
      (k) => k !== undefined && k !== null
    );

    const candidateMaps = [
      entity.custom_fields,
      entity.customFields,
      entity.custom_field_values,
      entity.customFieldValues,
    ];

    for (const key of keyList) {
      const keyStr = String(key);
      for (const map of candidateMaps) {
        if (map && isObject(map)) {
          if (Object.prototype.hasOwnProperty.call(map, keyStr)) return map[keyStr];
          if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
        }
      }
    }

    if (Array.isArray(entity.custom_fields)) {
      for (const key of keyList) {
        const id = String(key);
        const hit = entity.custom_fields.find(
          (x) => String(x.id) === id || String(x.custom_field_id) === id
        );
        if (hit) return hit.value;
      }
    }
    return "";
  }

  async function getSettings() {
    const metadata = await client.metadata().catch(() => ({}));
    const metadataSettings =
      (metadata && metadata.settings) ||
      (metadata && metadata.installationSettings) ||
      (metadata && metadata.config) ||
      {};

    const got = await client.get("settings").catch(() => ({}));
    const runtimeSettings =
      got && Object.keys(got).length
        ? got.settings && Object.keys(got.settings).length
          ? got.settings
          : got
        : {};

    const settings = Object.assign({}, metadataSettings, runtimeSettings);

    const baseUrl =
      settings.backend_base_url ||
      settings.backendBaseUrl ||
      settings.base_url ||
      settings.baseUrl ||
      DEFAULT_BACKEND_BASE_URL;

    const rootFolderId =
      settings.drive_root_folder_id ||
      settings.driveRootFolderId ||
      settings.root_folder_id ||
      settings.rootFolderId ||
      "";

    // secure setting: leer desde runtime (client.get("settings")), no desde metadata
    const apiKey =
      runtimeSettings.backend_api_key ||
      runtimeSettings.backendApiKey ||
      runtimeSettings.api_key ||
      runtimeSettings.apiKey ||
      "";

    const sharedDriveId =
      settings.drive_shared_drive_id ||
      settings.driveSharedDriveId ||
      settings.shared_drive_id ||
      settings.sharedDriveId ||
      "";

    const timeout =
      settings.backend_timeout_ms ||
      settings.backendTimeoutMs ||
      settings.timeout_ms ||
      settings.timeoutMs ||
      20000;

    return {
      backend_base_url: String(baseUrl || "").trim().replace(/\/$/, ""),
      drive_root_folder_id: String(rootFolderId || "").trim(),
      drive_shared_drive_id: String(sharedDriveId || "").trim(),
      backend_timeout_ms: Math.max(Number(timeout || 20000), 1000),
    };
  }

  async function getDealContext() {
    const sources = [];
    const tryPush = (value) => {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) sources.push(n);
    };

    const fromGet = await client
      .get(["deal.id", "deal", "currentDeal.id", "currentDeal", "dealId", "context.dealId"])
      .catch(() => ({}));

    tryPush(fromGet["deal.id"]);
    tryPush(fromGet["currentDeal.id"]);
    tryPush(fromGet.dealId);
    tryPush(fromGet["context.dealId"]);
    if (fromGet.deal && fromGet.deal.id) tryPush(fromGet.deal.id);
    if (fromGet.currentDeal && fromGet.currentDeal.id) tryPush(fromGet.currentDeal.id);

    const ctx = await client.context().catch(() => ({}));
    tryPush(ctx.dealId);
    tryPush(ctx.entityId);
    tryPush(ctx.resource_id);

    const urlParams = new URLSearchParams(window.location.search);
    tryPush(urlParams.get("deal_id"));
    tryPush(urlParams.get("dealId"));

    const dealId = sources.find((x) => Number.isFinite(x) && x > 0);
    if (!dealId) throw new Error("No fue posible determinar el Deal actual.");

    const dealResponse = await client.request({
      url: `/v2/deals/${dealId}`,
      type: "GET",
      contentType: "application/json",
    });

    const deal = dealResponse && dealResponse.data ? dealResponse.data : dealResponse;
    if (!deal || !deal.id) throw new Error("No se pudo cargar el Deal.");

    return deal;
  }

  async function getContactContext(deal) {
    const contactId = deal.contact_id || (deal.contact && deal.contact.id);
    if (!contactId) throw new Error("El Deal no tiene contacto asociado.");

    const contactResponse = await client.request({
      url: `/v2/contacts/${contactId}`,
      type: "GET",
      contentType: "application/json",
    });

    const contact = contactResponse && contactResponse.data ? contactResponse.data : contactResponse;
    if (!contact || !contact.id) throw new Error("No se pudo cargar el Contact.");

    return contact;
  }

  function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D+/g, "");
    if (!digits) return "";
    if (digits.startsWith("56") && digits.length >= 11) return digits.slice(2);
    return digits;
  }

  function pickTel1Tel2(contact) {
    const candidates = [
      toStringValue(getField(contact, FIELD_KEYS.telA)),
      toStringValue(getField(contact, FIELD_KEYS.telB)),
      toStringValue(getField(contact, FIELD_KEYS.telC)),
      toStringValue(contact.phone),
      toStringValue(contact.mobile_phone),
      toStringValue(contact.work_phone),
    ]
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    const tel1 = candidates[0] || "";
    if (!tel1) return { tel1: "", tel2: "" };

    const normalizedTel1 = normalizePhone(tel1);
    const tel2Distinct = candidates.find(
      (tel) => normalizePhone(tel) && normalizePhone(tel) !== normalizedTel1
    );

    return { tel1, tel2: tel2Distinct || tel1 };
  }

  function selectEmail(contact) {
    const emailA = toStringValue(getField(contact, FIELD_KEYS.emailPrimary));
    const emailB = toStringValue(getField(contact, FIELD_KEYS.emailSecondary));
    const emailStd = toStringValue(contact.email);
    return (emailA || emailB || emailStd || "").trim();
  }

  async function resolveTramoModalidadName(deal) {
    const rawValue = getField(deal, FIELD_KEYS.tramoModalidad);
    if (!rawValue) return "";

    if (typeof rawValue === "string" && Number.isNaN(Number(rawValue))) {
      return rawValue.trim();
    }

    const selectedId = String(rawValue);
    const endpoints = [
      `/v2/custom_fields/deals/${FIELD_IDS.tramoModalidad}`,
      `/v2/deal_custom_fields/${FIELD_IDS.tramoModalidad}`,
      `/v2/custom_fields/${FIELD_IDS.tramoModalidad}`,
    ];

    for (const endpoint of endpoints) {
      try {
        const definitionResponse = await client.request({
          url: endpoint,
          type: "GET",
          contentType: "application/json",
        });

        const definition =
          definitionResponse && definitionResponse.data ? definitionResponse.data : definitionResponse;

        const options =
          (definition && (definition.options || definition.choices || definition.values)) || [];

        if (Array.isArray(options)) {
          const hit = options.find(
            (opt) => String(opt.id) === selectedId || String(opt.value) === selectedId
          );
          if (hit) return String(hit.name || hit.label || hit.value || "").trim();
        }
      } catch (_e) {
        // intenta siguiente
      }
    }

    return String(rawValue).trim();
  }

  function requestWithTimeout(options, timeoutMs) {
    return Promise.race([
      client.request(options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout de backend")), Number(timeoutMs || 20000))
      ),
    ]);
  }

  function normalizeDriveId(input) {
    const raw = String(input || "").trim();
    if (!raw) return "";

    if (!raw.includes("/") && !raw.includes("?")) return raw;

    const foldersMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (foldersMatch && foldersMatch[1]) return foldersMatch[1];

    const dMatch = raw.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (dMatch && dMatch[1]) return dMatch[1];

    try {
      const parsed = new URL(raw);
      const byQuery = parsed.searchParams.get("id");
      if (byQuery) return byQuery;
    } catch (_e) {
      // no-op
    }

    const queryMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (queryMatch && queryMatch[1]) return queryMatch[1];

    return raw;
  }


  const API_ROUTES = {
    config: "/v1/config",
    driveFolderEnsure: "/v1/drive/folder/ensure",
    render: "/v1/render",
  };

  async function requestBackend(path, method = "GET", payload = null, { timeoutMs } = {}) {
    const s = state.settings;
    const url = `${s.backend_base_url}${path}`;
    const timeout = Number(timeoutMs || s.backend_timeout_ms || 20000);

    const options = {
      url,
      type: method,
      secure: true,
      contentType: "application/json",
      timeout,
      headers: {
        "x-api-key": "{{setting.backend_api_key}}",
      },
    };
    if (payload && method !== "GET") {
      options.data = JSON.stringify(payload);
    }

    try {
      const response = await client.request(options);
      const body = response && Object.prototype.hasOwnProperty.call(response, "data")
        ? response.data
        : response;
      return {
        status: 200,
        body,
        endpoint: path,
        request_url: url,
      };
    } catch (e) {
      const status = Number(e && (e.status || e.statusCode || (e.responseJSON && e.responseJSON.status))) || 0;
      const body =
        (e && (e.responseText || (e.responseJSON && JSON.stringify(e.responseJSON)) || e.message)) ||
        "";
      const message =
        status === 401 || status === 403
          ? "Configura backend_api_key en la instalación de la app"
          : `Backend ${status || "Error"}: ${body || "Error"}`;
      const err = new Error(message);
      err.status = status;
      err.body = body;
      err.endpoint = path;
      err.request_url = url;
      throw err;
    }
  }

  function formatError(error) {
    return {
      message: (error && error.message) || "Error",
      status: error && Object.prototype.hasOwnProperty.call(error, "status") ? error.status : null,
      body: error && Object.prototype.hasOwnProperty.call(error, "body") ? error.body : null,
      endpoint: error && Object.prototype.hasOwnProperty.call(error, "endpoint") ? error.endpoint : null,
      request_url: error && Object.prototype.hasOwnProperty.call(error, "request_url") ? error.request_url : null,
    };
  }

  function setButtonsEnabled(enabled) {
    const on = Boolean(enabled);
    if (btnEnsureFolder) btnEnsureFolder.disabled = !on;
    if (btnCreateNote) btnCreateNote.disabled = !on;
    // generate/open dependen de status
  }

  function populateTemplates(templates) {
    state.templates = Array.isArray(templates) ? templates : [];

    if (!templateSelect) return;

    templateSelect.innerHTML = "";

    if (!state.templates.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(Sin plantillas)";
      templateSelect.appendChild(opt);
      templateSelect.disabled = true;
      if (btnGenerate) btnGenerate.disabled = true;
      return;
    }

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "(Selecciona plantilla)";
    templateSelect.appendChild(opt0);

    for (const t of state.templates) {
      const opt = document.createElement("option");
      const key = t.key || t.id || "";
      const kind = t.kind || "template";
      opt.value = `${kind}:${key}`;
      opt.textContent = t.name || t.label || t.key || "(sin nombre)";
      templateSelect.appendChild(opt);
    }

    templateSelect.disabled = false;
    if (btnGenerate) btnGenerate.disabled = !state.deal_folder_id;
  }

  function openUrlSafely(url) {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function preopenWindow() {
    try {
      return window.open("about:blank", "_blank", "noopener,noreferrer");
    } catch (_e) {
      return null;
    }
  }

  // --------- resize ---------
  let resizeTimer = null;
  function scheduleResize() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      try {
        const h = Math.max(document.body.scrollHeight, 200);
        client.invoke("resize", { height: h });
      } catch (_e) {
        // ignore
      }
    }, 30);
  }

  // --------- actions ---------
  async function refreshStatus() {
    const debug = {
      action: "status",
      timestamp: new Date().toISOString(),
      request: null,
      response: null,
      error: null,
    };

    try {
      setStatus("Cargando estado...");

      debug.request = { endpoint: API_ROUTES.config, request_url: `${state.settings.backend_base_url}${API_ROUTES.config}`, method: "GET" };
      const res = await requestBackend(API_ROUTES.config, "GET", null, {
        timeoutMs: state.settings.backend_timeout_ms,
      });
      const data = res.body || {};

      debug.response = { status: res.status, body: data };

      const templateEntries = [];
      if (Array.isArray(data.templates)) {
        templateEntries.push(...data.templates.map((item) =>
          typeof item === "string"
            ? { kind: "template", key: item, name: item }
            : { kind: "template", key: item.key || item.template_key, name: item.name || item.key || item.template_key }
        ));
      }
      if (Array.isArray(data.template_keys)) {
        templateEntries.push(...data.template_keys.map((item) => ({ kind: "template", key: String(item), name: String(item) })));
      }
      if (Array.isArray(data.packages)) {
        templateEntries.push(...data.packages.map((item) =>
          typeof item === "string"
            ? { kind: "package", key: item, name: item }
            : { kind: "package", key: item.package_key || item.key, name: item.name || item.package_key || item.key }
        ));
      }
      populateTemplates(templateEntries.filter((item) => item && item.key));

      if (btnOpenFolder) btnOpenFolder.disabled = !(state.deal_folder_url || state.deal_folder_id);
      if (btnCreateNote) btnCreateNote.disabled = false;

      setStatus("Listo ✅");
      setDebug(debug);
    } catch (e) {
      debug.error = formatError(e);
      // No bloqueamos la app si el status no existe; igual se puede asegurar carpeta.
      setStatus("Listo ✅ (sin status)");
      setDebug(debug);

      // permitir acciones manuales
      if (btnCreateNote) btnCreateNote.disabled = false;
    }
  }

  async function onEnsureFolder() {
    const debug = {
      action: "drive_folder_ensure",
      timestamp: new Date().toISOString(),
      payload: null,
      response: null,
      error: null,
    };

    try {
      if (!state.settings.drive_root_folder_id) {
        throw new Error("Falta setting: drive_root_folder_id.");
      }

      setStatus("Creando/asegurando carpeta Drive...");

      const normalizedRootFolderId = normalizeDriveId(state.settings.drive_root_folder_id);

      const payload = {
        deal_id: Number(state.deal.id),
        drive_root_folder_id: normalizedRootFolderId,
      };
      if (state.settings.drive_shared_drive_id) {
        payload.drive_shared_drive_id = state.settings.drive_shared_drive_id;
      }

      debug.request = { endpoint: API_ROUTES.driveFolderEnsure, request_url: `${state.settings.backend_base_url}${API_ROUTES.driveFolderEnsure}`, method: "POST" };
      debug.payload = payload;

      const res = await requestBackend(API_ROUTES.driveFolderEnsure, "POST", payload, {
        timeoutMs: state.settings.backend_timeout_ms,
      });

      debug.response = { status: res.status, body: res.body };
      const data = res.body || {};

      state.deal_folder_url = data.web_view_url || data.drive_folder_url || data.folder_url || state.deal_folder_url;
      state.deal_folder_id = data.folder_id || data.drive_folder_id || state.deal_folder_id;
      if (state.deal) {
        state.deal.folder_id = state.deal_folder_id;
        state.deal.web_view_url = state.deal_folder_url;
      }

      if (btnOpenFolder) btnOpenFolder.disabled = !(state.deal_folder_url || state.deal_folder_id);
      if (btnGenerate) btnGenerate.disabled = !state.deal_folder_id;

      setStatus("Carpeta lista ✅");
      setDebug(debug);

      // refrescar status para cargar templates/links si backend lo soporta
      refreshStatus();
    } catch (e) {
      debug.error = formatError(e);
      setStatus(e && e.message ? e.message : "Error");
      setDebug(debug);
    }
  }

  function onOpenFolder() {
    const fallbackUrl = state.deal_folder_id
      ? `https://drive.google.com/drive/folders/${state.deal_folder_id}`
      : null;
    openUrlSafely(state.deal_folder_url || fallbackUrl || state.last_doc_url);
  }

  function validateRequiredPlaceholders(objectPayload, fecha) {
    const required = [
      ["object.run", objectPayload.run],
      ["object.nombres", objectPayload.nombres],
      ["object.paterno", objectPayload.paterno],
      ["object.prevision", objectPayload.prevision],
      ["object.fecha_nacimiento", objectPayload.fecha_nacimiento],
      ["fecha", fecha],
    ];

    return required.filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
  }

  function validateRequiredPlaceholders(objectPayload, fecha) {
    const required = [
      ["object.run", objectPayload.run],
      ["object.nombres", objectPayload.nombres],
      ["object.paterno", objectPayload.paterno],
      ["object.prevision", objectPayload.prevision],
      ["object.fecha_nacimiento", objectPayload.fecha_nacimiento],
      ["fecha", fecha],
    ];

    return required.filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
  }

  async function onGenerate() {
    const debug = {
      action: "drive_doc_generate",
      timestamp: new Date().toISOString(),
      payload: null,
      response: null,
      error: null,
    };

    let win = null;

    try {
      const selectedTemplate = templateSelect ? String(templateSelect.value || "") : "";
      if (!selectedTemplate) throw new Error("Selecciona una plantilla.");
      const [selectedKind, selectedKey] = selectedTemplate.split(":");
      if (!selectedKey) throw new Error("Plantilla inválida.");
      if (!state.payload) throw new Error("No se pudo construir payload.");
      if (!state.deal_folder_id) throw new Error("Primero debes crear Drive Carpeta.");

      win = preopenWindow();

      setStatus("Generando documento...");

      const objectPayload = Object.assign({}, state.payload, {
        run: state.payload.rut,
        nombres: state.payload.first_name,
        paterno: state.payload.last_name,
        prevision: state.payload.tramo_modalidad || "SIN INFORMACIÓN",
        fecha_nacimiento: state.payload.birth_date,
      });

      const fecha = new Date().toISOString().slice(0, 10);
      const missing = validateRequiredPlaceholders(objectPayload, fecha);
      if (missing.length) {
        throw new Error(`Faltan placeholders requeridos: ${missing.join(", ")}`);
      }

      const payload = {
        fecha,
        object: objectPayload,
        deal: {
          folder_id: state.deal_folder_id,
        },
      };

      if (selectedKind === "package") payload.package_key = selectedKey;
      else payload.template_key = selectedKey;

      debug.request = { endpoint: API_ROUTES.render, request_url: `${state.settings.backend_base_url}${API_ROUTES.render}`, method: "POST" };
      debug.payload = payload;

      const res = await requestBackend(API_ROUTES.render, "POST", payload, {
        timeoutMs: state.settings.backend_timeout_ms,
      });

      debug.response = { status: res.status, body: res.body };
      const data = res.body || {};

      const url = data.pdf_web_view_url || data.doc_url || data.url || data.download_url || data.webViewLink || null;
      state.last_doc_url = url || state.last_doc_url;
      setPdfLink(state.last_doc_url);

      if (url) {
        if (win && !win.closed) {
          try {
            win.location.href = url;
          } catch (_e) {
            openUrlSafely(url);
          }
        } else {
          openUrlSafely(url);
        }
      }

      setStatus("Documento generado ✅");
      setDebug(debug);

      refreshStatus();
    } catch (e) {
      debug.error = formatError(e);
      if (win && !win.closed) {
        try {
          win.close();
        } catch (_e) {
          // ignore
        }
      }
      setStatus(e && e.message ? e.message : "Error");
      setDebug(debug);
    }
  }

  async function onCreateNote() {
    const debug = {
      action: "sell_note_create",
      timestamp: new Date().toISOString(),
      payload: null,
      response: null,
      error: null,
    };

    try {
      if (!state.deal || !state.deal.id) throw new Error("No hay Deal");

      setStatus("Creando nota en Sell...");

      const links = [];
      if (state.deal_folder_url) links.push({ label: "📁 Carpeta Drive", url: state.deal_folder_url });
      if (state.last_doc_url) links.push({ label: "📄 Último documento", url: state.last_doc_url });

      const payload = {
        deal_id: Number(state.deal.id),
        contact_id: state.contact ? Number(state.contact.id) : undefined,
        links,
        source: "zendesk_sell_deal_card_generate_exams",
      };

      debug.payload = payload;

      const res = await requestWithTimeout({
        url: "/v2/notes",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({
          content: links.map((l) => `${l.label}: ${l.url}`).join("\n") || "Sin links disponibles",
          resource_type: "deal",
          resource_id: Number(state.deal.id),
        }),
      }, state.settings.backend_timeout_ms);
      if (!res) throw new Error("No se pudo crear nota");
      debug.response = res;
      setStatus("Nota creada ✅");
      setDebug(debug);
    } catch (e) {
      debug.error = formatError(e);
      setStatus(e && e.message ? e.message : "Error");
      setDebug(debug);
    }
  }

  // --------- boot ---------
  async function boot() {
    setStatus("Cargando...");
    setButtonsEnabled(false);
    setPdfLink(null);

    const debug = {
      action: "boot",
      timestamp: new Date().toISOString(),
      settings: null,
      deal_id: null,
      contact_id: null,
      payload: null,
      warnings: [],
      error: null,
    };

    try {
      state.settings = await getSettings();
      debug.settings = Object.assign({}, state.settings, { backend_api_key: maskSecret(state.settings.backend_api_key) });

      // Validaciones suaves (sin TypeError)
      if (!state.settings.backend_base_url) {
        debug.warnings.push("backend_base_url vacío; usando default");
        state.settings.backend_base_url = DEFAULT_BACKEND_BASE_URL;
      }
      if (!state.settings.drive_root_folder_id) {
        debug.warnings.push("Falta drive_root_folder_id (requerido para Drive)");
      }

      state.deal = await getDealContext();
      debug.deal_id = state.deal.id;

      state.contact = await getContactContext(state.deal);
      debug.contact_id = state.contact.id;

      const tramoModalidad = await resolveTramoModalidadName(state.deal);
      const phones = pickTel1Tel2(state.contact);

      const payload = {
        deal_id: Number(state.deal.id),
        contact_id: Number(state.contact.id),
        rut: toStringValue(getField(state.contact, FIELD_KEYS.rut)),
        first_name: toStringValue(state.contact.first_name),
        last_name: toStringValue(state.contact.last_name),
        birth_date: toStringValue(getField(state.contact, FIELD_KEYS.birthDate)),
        email: selectEmail(state.contact),
        telefono1: phones.tel1,
        telefono2: phones.tel2 || phones.tel1,
        direccion: toStringValue(getField(state.contact, FIELD_KEYS.direccion)) || toStringValue(state.contact.address || {}),
        comuna: toStringValue(getField(state.contact, FIELD_KEYS.comuna)) || toStringValue((state.contact.address || {}).city),
        tramo_modalidad: tramoModalidad,
        source: "zendesk_sell_deal_card_generate_exams",
      };

      state.payload = payload;
      debug.payload = payload;

      // Habilitar acciones base
      setButtonsEnabled(true);
      if (btnGenerate) btnGenerate.disabled = true;
      if (btnOpenFolder) btnOpenFolder.disabled = true;

      // Si falta root folder, deshabilitar acciones Drive que lo requieren
      if (!state.settings.drive_root_folder_id) {
        if (btnEnsureFolder) btnEnsureFolder.disabled = true;
        if (btnGenerate) btnGenerate.disabled = true;
        if (templateSelect) {
          templateSelect.disabled = true;
          templateSelect.innerHTML = "<option value=\"\">(Configura drive_root_folder_id)</option>";
        }
        setStatus("Configura drive_root_folder_id para habilitar Drive.");
      } else {
        // cargar status y templates si existe
        await refreshStatus();
      }

      setDebug(debug);

      scheduleResize();
    } catch (e) {
      debug.error = formatError(e);
      setStatus(e && e.message ? e.message : "Error al iniciar");
      setDebug(debug);
      setButtonsEnabled(false);
    }
  }

  // --------- bindings ---------
  if (btnEnsureFolder) btnEnsureFolder.addEventListener("click", onEnsureFolder);
  if (btnOpenFolder) btnOpenFolder.addEventListener("click", onOpenFolder);
  if (btnGenerate) btnGenerate.addEventListener("click", onGenerate);
  if (btnCreateNote) btnCreateNote.addEventListener("click", onCreateNote);

  if (debugDetails) {
    debugDetails.addEventListener("toggle", scheduleResize);
  }

  window.addEventListener("load", () => {
    boot();
  });
})();
