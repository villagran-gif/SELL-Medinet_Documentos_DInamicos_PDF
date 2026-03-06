import express from "express";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

const IDENTIFIER_TYPES = { DNI: "DNI", RUN: "RUN" };

app.use(express.json({ limit: "1mb" }));

// ======================
// In-memory store con TTL
// ======================
const TTL_MINUTES = Number(process.env.TTL_MINUTES || 60);
const TTL_MS = Math.max(1, TTL_MINUTES) * 60 * 1000;

const store = new Map(); // key -> { payload, expiresAt }

function cleanupStore() {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (!v || v.expiresAt <= now) store.delete(k);
  }
}
setInterval(cleanupStore, 60 * 1000).unref();

// ======================
// Helpers RUN / DNI
// ======================
const normalizeDni = (value = "") => value.replace(/\D/g, "");

const computeRunVerifier = (digits) => {
  let sum = 0;
  let multiplier = 2;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  if (remainder === 11) return "0";
  if (remainder === 10) return "K";
  return String(remainder);
};

const normalizeAndValidateRun = (value = "") => {
  const normalizedInput = String(value).toUpperCase().trim();
  const compactValue = normalizedInput.replace(/[.\s-]+/g, "");

  if (!compactValue) return { isValid: false, error: "RUN vacío" };

  if (!/^\d{1,8}[0-9K]$/.test(compactValue)) {
    return { isValid: false, error: "RUN inválido. Usa un RUN chileno válido con DV (0-9 o K)" };
  }

  const body = compactValue.slice(0, -1);
  const verifier = compactValue.slice(-1);
  const expectedVerifier = computeRunVerifier(body);

  if (verifier !== expectedVerifier) {
    return { isValid: false, error: "RUN inválido. Dígito verificador incorrecto" };
  }

  return { isValid: true, normalized: `${body}-${verifier}` };
};

const formatRunWithDots = (normalizedRun = "") => {
  const [body, verifier] = normalizedRun.split("-");
  const bodyWithDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${bodyWithDots}-${verifier}`;
};

// ======================
// API Key (modo estricto si API_KEY esta seteada)
// ======================
const validateApiKey = (req, res) => {
  const apiKey = (process.env.API_KEY || "").trim();

  // Compat: si no hay API_KEY configurada, NO bloqueamos (para evitar caidas).
  // Recomendado: setear API_KEY en Render y en los clientes.
  if (!apiKey) return true;

  const requestApiKey = (req.header("X-API-Key") || "").trim();
  if (requestApiKey !== apiKey) {
    res.status(401).json({ status: "error", message: "API key inválida" });
    return false;
  }
  return true;
};

// ======================
// CORS
// ======================
// 1) Medinet (Tampermonkey) SOLO necesita GET /medinet/payload/:key
const MEDINET_ORIGIN = "https://clinyco.medinetapp.com";
function setMedinetCors(res) {
  res.setHeader("Access-Control-Allow-Origin", MEDINET_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// 2) ZAF + Portal (navegador) necesitan POST + preflight para /medinet/import y /medinet/search
// Configurable via env CORS_ALLOW_ORIGINS (coma-separado). Ej:
// CORS_ALLOW_ORIGINS=https://clinyco.zendesk.com,https://app.futuresimple.com
const DEFAULT_CORS_ORIGINS = [
  "https://clinyco.zendesk.com",
  "https://app.futuresimple.com",
];
const ALLOW_ORIGINS = String(process.env.CORS_ALLOW_ORIGINS || DEFAULT_CORS_ORIGINS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function setFrontendCors(req, res) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return;

  const allowAny = ALLOW_ORIGINS.includes("*");
  const allowed = allowAny || ALLOW_ORIGINS.includes(origin);
  if (!allowed) return;

  res.setHeader("Access-Control-Allow-Origin", allowAny ? "*" : origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
}

// Preflight for POST endpoints
app.options(["/medinet/import", "/medinet/search"], (req, res) => {
  setFrontendCors(req, res);
  return res.status(204).send("");
});

// Existing preflight for payload
app.options("/medinet/payload/:key", (_req, res) => {
  setMedinetCors(res);
  return res.status(204).send("");
});

// ======================
// Routes
// ======================
app.get("/", (_req, res) => res.send("OK - sell-medinet-backend"));

app.post("/medinet/import", (req, res) => {
  setFrontendCors(req, res);
  if (!validateApiKey(req, res)) return;

  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ status: "error", message: "Body JSON requerido" });
  }

  const key = `mf_${randomUUID()}`;
  store.set(key, { payload, expiresAt: Date.now() + TTL_MS });

  const baseMedinetNew = String(process.env.MEDINET_NEW_URL || "https://clinyco.medinetapp.com/pacientes/nuevo/")
    .trim()
    .replace(/\/?$/, "/");

  const download_url = `${baseMedinetNew}?mf_key=${encodeURIComponent(key)}`;

  return res.status(200).json({
    status: "ok",
    message: "Listo ✅ (payload guardado)",
    key,
    download_url,
  });
});

app.get("/medinet/payload/:key", (req, res) => {
  setMedinetCors(res);

  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ status: "error", message: "key requerido" });

  const entry = store.get(key);
  if (!entry) return res.status(404).json({ status: "error", message: "key no encontrada/expirada" });

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return res.status(404).json({ status: "error", message: "key expirada" });
  }

  return res.status(200).json(entry.payload);
});

app.post("/medinet/search", (req, res) => {
  setFrontendCors(req, res);
  if (!validateApiKey(req, res)) return;

  const identifierType = String(req.body?.identifierType || "").toUpperCase();
  const identifierValue = String(req.body?.identifierValue || "");

  if (!Object.values(IDENTIFIER_TYPES).includes(identifierType)) {
    return res.status(400).json({ status: "error", message: "identifierType inválido. Usa DNI o RUN" });
  }

  if (!identifierValue.trim()) {
    return res.status(400).json({ status: "error", message: "identifierValue es requerido" });
  }

  let normalizedIdentifierValue;
  let responseIdentifierValue;

  if (identifierType === IDENTIFIER_TYPES.DNI) {
    normalizedIdentifierValue = normalizeDni(identifierValue);
    if (!normalizedIdentifierValue) {
      return res.status(400).json({ status: "error", message: "DNI inválido. Debe contener solo dígitos" });
    }
    responseIdentifierValue = normalizedIdentifierValue;
  }

  if (identifierType === IDENTIFIER_TYPES.RUN) {
    const runResult = normalizeAndValidateRun(identifierValue);
    if (!runResult.isValid) {
      return res.status(400).json({ status: "error", message: runResult.error });
    }
    normalizedIdentifierValue = runResult.normalized;
    responseIdentifierValue = formatRunWithDots(normalizedIdentifierValue);
  }

  return res.status(200).json({
    status: "ok",
    message: "Búsqueda preparada",
    search: {
      identifierType,
      identifierValue: responseIdentifierValue,
      identifierValueNormalized: normalizedIdentifierValue,
      backendFieldMap: {
        type: identifierType === IDENTIFIER_TYPES.RUN ? "run" : "dni",
        value: normalizedIdentifierValue,
      },
    },
  });
});

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ status: "error", message: "JSON inválido en el body" });
  }
  return next(error);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
