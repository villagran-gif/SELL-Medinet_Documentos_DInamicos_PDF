/* Portal Pending Patch: Quick Actions + Tampermonkey Export
   - Injects a horizontal action button section between header and first card
   - Adds a bottom section to load deal-context + build/copy JSON for Tampermonkey
*/

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function insertAfter(refNode, newNode) {
    if (!refNode || !refNode.parentNode) return;
    refNode.parentNode.insertBefore(newNode, refNode.nextSibling);
  }

  function getClosestCard(node) {
    if (!node) return null;
    return node.closest && node.closest("section.card") ? node.closest("section.card") : node;
  }

  function pulse(node) {
    const card = getClosestCard(node);
    if (!card) return;
    card.classList.add("qa-pulse");
    setTimeout(() => card.classList.remove("qa-pulse"), 1200);
  }

  function scrollToTarget(target) {
    if (!target) return;
    const card = getClosestCard(target);
    (card || target).scrollIntoView({ behavior: "smooth", block: "start" });
    pulse(card || target);
  }

  function safeSetStatus(elStatus, msg, kind) {
    // Prefer portal's setStatus if it's global
    try {
      if (typeof window.setStatus === "function") {
        window.setStatus(elStatus, msg, kind || "info");
        return;
      }
    } catch (_e) {}

    if (!elStatus) return;
    elStatus.className = "status" + (kind ? " " + kind : "");
    elStatus.textContent = msg || "";
  }

  function readFormField(id) {
    const x = $(id);
    if (!x) return "";
    return String(x.value || "").trim();
  }

  function buildTamperPayload({ dealCtx }) {
    // Base from portal form (consistent con debug payload que ya usas)
    const payload = {
      deal_id: dealCtx && dealCtx.deal && dealCtx.deal.id ? Number(dealCtx.deal.id) : undefined,
      contact_id: dealCtx && dealCtx.contact && dealCtx.contact.id ? Number(dealCtx.contact.id) : undefined,
      rut: readFormField("c_rut"),
      first_name: readFormField("c_nombres"),
      last_name: readFormField("c_apellidos"),
      birth_date: readFormField("c_fecha"),
      email: readFormField("c_email"),
      telefono1: readFormField("c_tel1"),
      telefono2: readFormField("c_tel2"),
      direccion: readFormField("c_direccion"),
      comuna: (function () {
        const c = $("c_comuna");
        return c ? String(c.value || "").trim() : "";
      })(),
      tramo_modalidad: (function () {
        const m = $("c_modalidad");
        return m ? String(m.value || "").trim() : "";
      })(),
      aseguradora: (function () {
        const a = $("c_aseguradora");
        return a ? String(a.value || "").trim() : "";
      })(),
      source: "portal_export_tampermonkey",
      timestamp: new Date().toISOString(),
      sell: dealCtx ? {
        deal: dealCtx.deal || null,
        contact: dealCtx.contact || null,
      } : undefined,
    };

    // Remove empty strings (pero deja rut aunque vacío si usuario no lo cargó)
    for (const k of Object.keys(payload)) {
      if (payload[k] === "") delete payload[k];
    }
    return payload;
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_e) {}

    // Fallback
    try {
      const ta = el("textarea", { style: "position:fixed;left:-9999px;top:-9999px;" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_e) {
      return false;
    }
  }

  async function fetchDealContext(dealId) {
    const res = await fetch(`/api/deal-context?deal_id=${encodeURIComponent(String(dealId))}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json && json.message ? json.message : `Error ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  function renderSellLinks(container, dealCtx) {
    if (!container) return;
    container.innerHTML = "";
    const links = [];
    if (dealCtx && dealCtx.contact) {
      if (dealCtx.contact.desktop_url) links.push({ label: "👤 Contacto (Desktop)", url: dealCtx.contact.desktop_url });
      if (dealCtx.contact.mobile_url) links.push({ label: "📱 Contacto (Mobile)", url: dealCtx.contact.mobile_url });
    }
    if (dealCtx && dealCtx.deal) {
      if (dealCtx.deal.desktop_url) links.push({ label: "💼 Deal (Desktop)", url: dealCtx.deal.desktop_url });
      if (dealCtx.deal.mobile_url) links.push({ label: "📱 Deal (Mobile)", url: dealCtx.deal.mobile_url });
    }

    if (!links.length) {
      container.innerHTML = '<div class="muted small">(sin links)</div>';
      return;
    }

    const list = el("div", { id: "tmLinksList" });
    for (const l of links) {
      list.appendChild(el("a", { href: l.url, target: "_blank", rel: "noreferrer" }, [l.label]));
    }
    container.appendChild(list);
  }

  function prefillFromDealContext(dealCtx) {
    // Prefill only safe/basic fields (rut no viene en endpoint)
    if (!dealCtx || !dealCtx.contact) return;

    const c = dealCtx.contact;
    if ($("c_nombres") && c.first_name) $("c_nombres").value = c.first_name;
    if ($("c_apellidos") && c.last_name) $("c_apellidos").value = c.last_name;
    if ($("c_email") && c.email) $("c_email").value = c.email;

    // phone/mobile -> Tel1/Tel2
    if ($("c_tel1") && (c.phone || c.mobile)) $("c_tel1").value = c.phone || c.mobile;
    if ($("c_tel2") && c.mobile) $("c_tel2").value = c.mobile;

    // address
    const addr = c.address || null;
    if (addr && typeof addr === "object") {
      if ($("c_direccion") && addr.line1) $("c_direccion").value = addr.line1;
      // comuna select: only set if option exists
      if ($("c_comuna") && addr.city) {
        try { $("c_comuna").value = addr.city; } catch (_e) {}
      }
    }
  }

  function installQuickActions(wrap) {
    const header = wrap.querySelector("header.topbar");
    const firstCard = wrap.querySelector("section.card");
    if (!header || !firstCard) return;

    const card = el("section", { class: "card quick-actions-card", id: "quickActions" }, [
      el("h2", null, ["Acciones rápidas"]),
      el("div", { class: "quick-actions" }, [
        el("button", {
          type: "button",
          class: "qa-btn",
          onclick: () => {
            const t = $("contactForm") || $("c_rut") || wrap.querySelector("#contactForm");
            scrollToTarget(t);
            try { if ($("c_rut")) $("c_rut").focus(); } catch (_e) {}
          }
        }, [el("span", { class: "qa-k" }, ["A"]), el("span", { class: "qa-ico" }, ["👤"]), "Crear contacto"]),

        el("button", {
          type: "button",
          class: "qa-btn",
          onclick: () => {
            const t = $("dealForm") || wrap.querySelector("#dealForm");
            scrollToTarget(t);
          }
        }, [el("span", { class: "qa-k" }, ["B"]), el("span", { class: "qa-ico" }, ["💼"]), "Crear trato / deal"]),

        el("button", {
          type: "button",
          class: "qa-btn",
          onclick: () => {
            const t = $("form") || $("rut") || wrap.querySelector("#form");
            scrollToTarget(t);
            try { if ($("rut")) $("rut").focus(); } catch (_e) {}
          }
        }, [el("span", { class: "qa-k" }, ["C"]), el("span", { class: "qa-ico" }, ["🔎"]), "Buscar RUT"]),

        el("button", {
          type: "button",
          class: "qa-btn",
          onclick: () => {
            const t = $("btnCreateDocs") || $("docsTemplatesWrap") || wrap.querySelector("#btnCreateDocs");
            scrollToTarget(t);
          }
        }, [el("span", { class: "qa-k" }, ["E"]), el("span", { class: "qa-ico" }, ["🧾"]), "Crear orden examen"]),
      ]),
      el("div", { class: "qa-hint" }, [
        el("span", { class: "pill" }, ["Tip"]),
        el("span", { class: "muted small" }, ["Estos botones te llevan directo a cada bloque (no ejecutan acciones automáticamente)."]),
      ]),
    ]);

    // Place between header and first card
    insertAfter(header, card);
  }

  function installTampermonkeyExport(wrap) {
    // Insert at the end, before footer if any
    const card = el("section", { class: "card", id: "tmExport" }, [
      el("h2", null, ["Exportar a Medinet (Tampermonkey)"]),
      el("p", { class: "muted" }, [
        "Carga un ", el("b", null, ["deal_id"]), " (opcional) para obtener links Sell, y luego copia el JSON para pegarlo en Medinet (Tampermonkey)."
      ]),

      el("form", { class: "form-grid", id: "tmForm" }, [
        el("label", null, [
          "Deal ID (opcional)",
          el("input", { id: "tmDealId", placeholder: "Ej: 195260421", inputmode: "numeric", autocomplete: "off" }),
          el("div", { class: "muted small" }, ["Si abriste el portal con ?deal_id=..., se carga automáticamente."])
        ]),

        el("div", { class: "row span2" }, [
          el("button", { type: "button", id: "btnTmLoad" }, ["Cargar desde Sell"]),
          el("button", { type: "button", id: "btnTmBuild", class: "secondary" }, ["Armar JSON desde formulario"]),
          el("button", { type: "button", id: "btnTmCopy", class: "secondary", disabled: "true" }, ["Copiar JSON"]),
        ]),
      ]),

      el("section", { id: "tmStatus", class: "status" }),

      el("details", { class: "details", open: "true" }, [
        el("summary", null, ["Payload para Medinet (JSON)"]),
        el("pre", { id: "tmOut", class: "out" }, ["(sin datos)"])
      ]),

      el("details", { class: "details" }, [
        el("summary", null, ["Links Sell encontrados"]),
        el("div", { id: "tmLinks", class: "docs-links" })
      ]),

      el("p", { class: "muted small" }, [
        "Flujo sugerido: ",
        el("b", null, ["1)"]), " llena/extrae datos en IA BOX ",
        el("b", null, ["2)"]), " arma JSON ",
        el("b", null, ["3)"]), " copia ",
        el("b", null, ["4)"]), " pega en Medinet /pacientes/nuevo/ con tu userscript."
      ])
    ]);

    const dealForm = $("dealForm") || wrap.querySelector("#dealForm");
    const dealCard = getClosestCard(dealForm);

    if (dealCard && dealCard.parentNode) {
      insertAfter(dealCard, card);
    } else {
      wrap.appendChild(card);
    }

    const tmDealId = $("tmDealId");
    const btnLoad = $("btnTmLoad");
    const btnBuild = $("btnTmBuild");
    const btnCopy = $("btnTmCopy");
    const tmStatus = $("tmStatus");
    const tmOut = $("tmOut");
    const tmLinks = $("tmLinks");

    let lastCtx = null;

    async function doBuild() {
      const payload = buildTamperPayload({ dealCtx: lastCtx });
      const txt = JSON.stringify(payload, null, 2);
      tmOut.textContent = txt;
      btnCopy.disabled = false;
      safeSetStatus(tmStatus, "JSON listo ✅", "ok");
    }

    async function doLoad() {
      const dealIdRaw = tmDealId ? String(tmDealId.value || "").trim() : "";
      if (!dealIdRaw) {
        safeSetStatus(tmStatus, "Ingresa deal_id o usa 'Armar JSON desde formulario'.", "error");
        return;
      }

      safeSetStatus(tmStatus, `Cargando deal_id=${dealIdRaw}...`, "running");
      tmOut.textContent = "(cargando...)";
      btnCopy.disabled = true;

      try {
        const ctx = await fetchDealContext(dealIdRaw);
        lastCtx = ctx;
        renderSellLinks(tmLinks, ctx);
        prefillFromDealContext(ctx);
        await doBuild();
      } catch (e) {
        lastCtx = null;
        renderSellLinks(tmLinks, null);
        tmOut.textContent = JSON.stringify({ error: true, message: e.message || String(e) }, null, 2);
        safeSetStatus(tmStatus, e.message || String(e), "error");
      }
    }

    btnLoad.addEventListener("click", doLoad);
    btnBuild.addEventListener("click", doBuild);

    btnCopy.addEventListener("click", async () => {
      const txt = tmOut && tmOut.textContent ? tmOut.textContent : "";
      if (!txt || txt === "(sin datos)" || txt === "(cargando...)") {
        safeSetStatus(tmStatus, "No hay JSON para copiar.", "error");
        return;
      }
      safeSetStatus(tmStatus, "Copiando...", "running");
      const ok = await copyToClipboard(txt);
      safeSetStatus(tmStatus, ok ? "Copiado ✅" : "No se pudo copiar (permiso/HTTPS).", ok ? "ok" : "error");
    });

    // Auto-load from URL ?deal_id=...
    try {
      const qs = new URLSearchParams(location.search);
      const dealId = qs.get("deal_id") || qs.get("dealId");
      if (dealId && tmDealId && !tmDealId.value) {
        tmDealId.value = dealId;
        // Don't auto-load if user is offline; but usually OK.
        doLoad();
      }
    } catch (_e) {}
  }

  function boot() {
    const wrap = document.querySelector("main.wrap") || document.querySelector(".wrap");
    if (!wrap) return;

    // avoid double install
    if ($("quickActions") || $("tmExport")) return;

    installQuickActions(wrap);
    installTampermonkeyExport(wrap);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
