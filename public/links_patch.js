(() => {
  'use strict';

  // ---- Helpers ----
  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const normUrl = (u) => {
    const s = String(u || '').trim();
    if (!s) return '';
    return s;
  };

  const deskContactUrl = (id) => `https://clinyco.zendesk.com/sales/contacts/${id}`;
  const deskDealUrl = (id) => `https://clinyco.zendesk.com/sales/deals/${id}`;

  const pickContainer = () => {
    const ids = ['search_links', 'c_rut_lookup', 'rut_lookup', 'links', 'results_links'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }

    // Fallback: insert right above the JSON output if present
    const out = document.getElementById('out') || document.getElementById('c_out');
    if (out) {
      const host = out.closest('details')?.parentElement || out.parentElement;
      if (host) {
        const div = document.createElement('div');
        div.id = 'search_links';
        div.className = 'summary';
        host.insertBefore(div, host.querySelector('details') || out);
        return div;
      }
    }

    return null;
  };

  const extractContacts = (json) => {
    const arr = [];
    if (Array.isArray(json?.contacts)) arr.push(...json.contacts);
    else if (json?.contact) arr.push(json.contact);

    return arr
      .filter(Boolean)
      .map((c) => {
        const id = c.id ?? c.contact_id;
        if (!id) return null;
        const name = c.display_name || c.name || c.full_name || `Contacto ${id}`;
        return {
          id,
          name,
          desktop_url: normUrl(c.desktop_url) || deskContactUrl(id),
          mobile_url: normUrl(c.mobile_url) || ''
        };
      })
      .filter(Boolean);
  };

  const extractDeals = (json) => {
    // Prefer flat list
    const flat = [];
    if (Array.isArray(json?.deals)) flat.push(...json.deals);
    else if (json?.deal) flat.push(json.deal);

    // Some responses return grouped by pipeline
    if (flat.length === 0 && Array.isArray(json?.deals_by_pipeline)) {
      for (const g of json.deals_by_pipeline) {
        if (Array.isArray(g?.deals)) flat.push(...g.deals.map((d) => ({ ...d, pipeline_id: g.pipeline_id, pipeline_name: g.pipeline_name })));
      }
    }

    return flat
      .filter(Boolean)
      .map((d) => {
        const id = d.id ?? d.deal_id;
        if (!id) return null;
        const name = d.name || `Deal ${id}`;
        return {
          id,
          name,
          pipeline_id: d.pipeline_id ?? null,
          pipeline_name: d.pipeline_name ?? null,
          stage_name: d.stage_name ?? null,
          desktop_url: normUrl(d.desktop_url) || deskDealUrl(id),
          mobile_url: normUrl(d.mobile_url) || ''
        };
      })
      .filter(Boolean);
  };

  const groupDealsByPipeline = (deals) => {
    const map = new Map();
    for (const d of deals) {
      const key = d.pipeline_id == null ? `null:${d.pipeline_name || ''}` : String(d.pipeline_id);
      if (!map.has(key)) map.set(key, { pipeline_id: d.pipeline_id, pipeline_name: d.pipeline_name, deals: [] });
      map.get(key).deals.push(d);
    }
    return Array.from(map.values()).sort((a, b) => String(a.pipeline_name || '').localeCompare(String(b.pipeline_name || ''), 'es'));
  };

  function renderSearchLinks(json) {
    const el = pickContainer();
    if (!el) return;

    const contacts = extractContacts(json);
    const deals = extractDeals(json);

    // If nothing found, don't spam UI.
    if (contacts.length === 0 && deals.length === 0) {
      // Only clear if the response is explicitly about /api/search-rut
      el.innerHTML = '';
      return;
    }

    const contactItems = contacts.map((c) => {
      const d = esc(c.desktop_url);
      const m = c.mobile_url ? `<a class="rl-link secondary" href="${esc(c.mobile_url)}" target="_blank" rel="noopener noreferrer">Mobile</a>` : '';
      return `<li><a class="rl-link" href="${d}" target="_blank" rel="noopener noreferrer">${esc(c.name)}</a>${m ? ` <span class="rl-sep">·</span> ${m}` : ''}</li>`;
    }).join('');

    const dealGroups = groupDealsByPipeline(deals);
    const dealHtml = dealGroups.map((g) => {
      const title = g.pipeline_name ? `${esc(g.pipeline_name)}${g.pipeline_id ? ` (ID ${esc(g.pipeline_id)})` : ''}` : 'Sin pipeline';
      const items = g.deals.map((d) => {
        const url = esc(d.desktop_url);
        const meta = [d.stage_name ? esc(d.stage_name) : ''].filter(Boolean).join(' · ');
        const metaHtml = meta ? ` <span class="rl-meta">(${meta})</span>` : '';
        return `<li><a class="rl-link" href="${url}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a>${metaHtml}</li>`;
      }).join('');
      return `<div class="rl-group"><div class="rl-group-title">${title}</div><ul class="rl-list">${items}</ul></div>`;
    }).join('');

    const title = 'Registros encontrados';

    el.innerHTML = `
      <div class="rl-wrap">
        <div class="rl-title">${title}</div>
        ${contacts.length ? `
          <div class="rl-block">
            <div class="rl-block-title">Contactos (${contacts.length})</div>
            <ul class="rl-list">${contactItems}</ul>
          </div>
        ` : ''}
        ${deals.length ? `
          <div class="rl-block">
            <div class="rl-block-title">Deals / Tratos (${deals.length})</div>
            ${dealHtml}
          </div>
        ` : ''}
      </div>
    `;
  }

  // Expose for debugging
  window.__renderSearchLinks = renderSearchLinks;

  // ---- Hook fetch so ANY search-rut call triggers link rendering ----
  const originalFetch = window.fetch?.bind(window);
  if (!originalFetch) return;

  window.fetch = async function(input, init) {
    const res = await originalFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && url.includes('/api/search-rut')) {
        // Parse in background, don't block the original consumer.
        res.clone().json().then(renderSearchLinks).catch(() => {});
      }
    } catch (_) {}
    return res;
  };
})();
