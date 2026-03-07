(() => {
  "use strict";

  const COLAB_OPTIONS = [
    "Carolin",
    "Camila",
    "Gabriela",
    "Allison",
    "MariaPaz",
    "Danitza",
    "Giselle",
  ];

  const state = {
    headerPinned: false,
    summaryObserverInstalled: false,
    boundDealButtons: false,
    boundCtaDelegate: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function readValue(id) {
    const el = $(id);
    return el ? String(el.value || "").trim() : "";
  }

  function getContactContext() {
    const firstName = readValue("c_nombres");
    const lastName = readValue("c_apellidos");
    const rut = readValue("c_rut");
    const contactId = Number(window.__lastContactId || 0);
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    return {
      name,
      rut,
      contactId,
      hasContactId: Number.isFinite(contactId) && contactId > 0,
    };
  }

  function getDealCard() {
    const form = $("dealForm");
    return form && form.closest ? form.closest("section.card") : null;
  }

  function ensureDealHeader() {
    const card = getDealCard();
    if (!card) return null;

    let header = $("dealStage1Header");
    if (header) return header;

    const title = card.querySelector("h2");
    header = document.createElement("div");
    header.id = "dealStage1Header";
    header.className = "deal-stage1-header";
    header.hidden = true;

    if (title && title.parentNode === card) {
      title.insertAdjacentElement("afterend", header);
    } else if (card.firstChild) {
      card.insertBefore(header, card.firstChild.nextSibling);
    } else {
      card.appendChild(header);
    }

    return header;
  }

  function renderDealHeader(forceShow) {
    const header = ensureDealHeader();
    if (!header) return;

    const ctx = getContactContext();
    if (!forceShow || !ctx.hasContactId) {
      if (!state.headerPinned) {
        header.hidden = true;
        header.innerHTML = "";
      }
      return;
    }

    const pieces = [
      ctx.name || "CONTACTO SIN NOMBRE",
      ctx.rut || "SIN RUT",
      `CONTACT_ID ${ctx.contactId}`,
    ];

    header.hidden = false;
    header.innerHTML = `
      <span class="deal-stage1-icon" aria-hidden="true">🪛</span>
      <span class="deal-stage1-copy"><b>Creando DEAL/TRATO de ${escapeHtml(pieces.join(" · "))}</b></span>
      <span class="deal-stage1-icon" aria-hidden="true">🔧</span>
    `;
  }

  function scrollToDealForm() {
    const header = $("dealStage1Header");
    const target = (header && !header.hidden ? header : null) || $("dealForm") || ensureDealHeader();
    if (!target) return;

    const card = getDealCard() || target;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    card.classList.add("deal-stage1-pulse");
    window.setTimeout(() => card.classList.remove("deal-stage1-pulse"), 1200);

    window.setTimeout(() => {
      const focusTarget = $("dealPipelineId") || $("dealOwnerId") || $("dealPeso");
      try { focusTarget?.focus({ preventScroll: true }); } catch (_err) {}
    }, 260);
  }

  function setDealStatus(message, kind) {
    const statusEl = $("d_status");
    if (typeof window.setStatus === "function") {
      window.setStatus(statusEl, message, kind || "info");
      return;
    }
    if (!statusEl) return;
    statusEl.className = `status ${kind || "info"}`.trim();
    statusEl.textContent = message || "";
  }

  function activatePostContactDealCta() {
    state.headerPinned = true;
    renderDealHeader(true);
    scrollToDealForm();
  }


  function ensureSummaryCta() {
    const summary = $("c_summary");
    if (!summary) return;

    let wrap = $("postContactDealCtaWrap");
    const ctx = getContactContext();
    const hasSummaryContent = !!String(summary.textContent || "").trim();

    if (!ctx.hasContactId || !hasSummaryContent) {
      if (wrap) wrap.remove();
      return;
    }

    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "postContactDealCtaWrap";
      wrap.className = "post-contact-deal-cta";
      summary.appendChild(wrap);
    }

    const safeName = escapeHtml(ctx.name || "CONTACTO SIN NOMBRE");
    wrap.innerHTML = `
      <button type="button" id="postContactDealCta" class="qa-btn qa-btn-post-contact">
        <span class="qa-k">B</span>
        <span class="qa-ico">💼</span>
        CREAR TRATO para CONTACTO ${safeName} · CONTACT_ID ${escapeHtml(String(ctx.contactId))}
      </button>
    `;

  }

  function replaceColab1Input() {
    const current = $("dealColab1");
    if (!current) return null;
    if (current.tagName === "SELECT") return current;

    const label = current.closest("label");
    if (!label) return current;

    const select = document.createElement("select");
    select.id = "dealColab1";
    select.className = current.className || "";
    select.setAttribute("data-stage1-strict", "1");
    select.innerHTML = `<option value="">Selecciona colaboradora...</option>` +
      COLAB_OPTIONS.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");

    current.replaceWith(select);

    let hint = label.querySelector(".deal-colab1-help");
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "muted small deal-colab1-help";
      hint.textContent = "Obligatorio. Solo permite opciones existentes de la lista.";
      label.appendChild(hint);
    }

    if (window.TomSelect && !select.tomselect) {
      try {
        new TomSelect(select, {
          create: false,
          persist: false,
          maxOptions: 50,
          placeholder: "Selecciona colaboradora...",
          sortField: { field: "text", direction: "asc" },
        });
      } catch (_err) {
      }
    }

    return select;
  }

  function readColab1StrictValue() {
    const el = replaceColab1Input();
    if (!el) return "";
    return String(el.value || "").trim();
  }

  function validateColab1BeforeDeal(ev) {
    const label = $("dealColab1") ? $("dealColab1").closest("label") : null;
    const value = readColab1StrictValue();
    const isValid = COLAB_OPTIONS.includes(value);

    if (label) label.classList.toggle("deal-colab1-invalid", !isValid);

    if (isValid) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    setDealStatus("Debes seleccionar Colaborador1 desde la lista estricta antes de crear el trato.", "error");

    const dealColab = $("dealColab1");
    if (dealColab && typeof dealColab.focus === "function") {
      dealColab.focus();
    }

    const card = getDealCard();
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function bindDealButtons() {
    if (state.boundDealButtons) return;
    ["btnDealPreview", "btnDealCreate"].forEach((id) => {
      const btn = $(id);
      if (!btn) return;
      btn.addEventListener("click", validateColab1BeforeDeal, true);
    });
    state.boundDealButtons = true;
  }

  function installSummaryObserver() {
    if (state.summaryObserverInstalled) return;
    const summary = $("c_summary");
    if (!summary) return;

    const observer = new MutationObserver(() => {
      window.requestAnimationFrame(() => {
        ensureSummaryCta();
        if (state.headerPinned) renderDealHeader(true);
      });
    });

    observer.observe(summary, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    state.summaryObserverInstalled = true;
  }

  function bindContactFieldRefresh() {
    ["c_nombres", "c_apellidos", "c_rut"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => {
        ensureSummaryCta();
        if (state.headerPinned) renderDealHeader(true);
      });
    });
  }

  function bindDelegatedClicks() {
    if (state.boundCtaDelegate) return;
    document.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("#postContactDealCta") : null;
      if (!btn) return;
      ev.preventDefault();
      activatePostContactDealCta();
    }, true);
    state.boundCtaDelegate = true;
  }

  function boot() {
    replaceColab1Input();
    ensureDealHeader();
    ensureSummaryCta();
    bindDealButtons();
    bindDelegatedClicks();
    installSummaryObserver();
    bindContactFieldRefresh();

    if (state.headerPinned) {
      renderDealHeader(true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
