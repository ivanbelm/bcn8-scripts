// ==UserScript==
// @name         BCN8 Cargas + Pre-asignación Camiones + Parkings
// @namespace    amazon-bcn8
// @version      2.9.3
// @updateURL    https://raw.githubusercontent.com/ivanbelm/bcn8-scripts/main/bcn8-unified.user.js
// @downloadURL  https://raw.githubusercontent.com/ivanbelm/bcn8-scripts/main/bcn8-unified.user.js
// @description  Dashboard cargas + parkings + pre-asignacion con AUTO-REFRESH (STEM, Yard, Sesame). Configurable por panel.
// @match        https://stem-eu.corp.amazon.com/node/BCN8/*
// @match        https://stem-eu.corp.amazon.com/*/BCN8/*
// @match        https://trans-logistics-eu.amazon.com/yms/sesameGateConsole*
// @match        https://trans-logistics-eu.amazon.com/yms/shipclerk*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const host = window.location.hostname;
    const path = window.location.pathname;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ============================================================
    //   ANTI-THROTTLE: evita que el navegador ralentice la pestana
    //   cuando esta en segundo plano (al cambiar a Excel, Word, etc.)
    //   Usa un AudioContext silencioso (sin sonido audible) que mantiene
    //   la pestana en estado "activo" para el navegador.
    // ============================================================
    const antiThrottle = {
        ctx: null,
        oscillator: null,
        gain: null,
        active: false,
        start() {
            if (this.active) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                this.ctx = new Ctx();
                this.oscillator = this.ctx.createOscillator();
                this.gain = this.ctx.createGain();
                // Volumen 0 -> totalmente silencioso
                this.gain.gain.value = 0;
                this.oscillator.connect(this.gain);
                this.gain.connect(this.ctx.destination);
                this.oscillator.start();
                this.active = true;
                console.log('[BCN8] Anti-throttle activado');
            } catch (e) {
                console.warn('[BCN8] No se pudo activar anti-throttle:', e);
            }
        },
        stop() {
            if (!this.active) return;
            try {
                this.oscillator?.stop();
                this.oscillator?.disconnect();
                this.gain?.disconnect();
                this.ctx?.close();
            } catch (e) {}
            this.ctx = null;
            this.oscillator = null;
            this.gain = null;
            this.active = false;
            console.log('[BCN8] Anti-throttle desactivado');
        }
    };
    // Lo exponemos para que ambos modulos (yard y arrivals) lo usen
    window.__bcn8AntiThrottle = antiThrottle;

    // ============================================================
    //   AUTO-REFRESH HELPER
    //   Utilidad para programar la ejecucion periodica de una accion.
    //   - Se basa en setInterval con backoff defensivo: si la pagina lleva
    //     mucho tiempo en segundo plano y los timers se han ralentizado,
    //     comprueba la hora real cada vez que se dispare.
    //   - Persistencia: lee/guarda config en GM_setValue con la clave dada.
    //   - UI: crea un bloque <div> con casilla "auto-refresh", input numerico
    //     "cada X minutos" y un texto de estado ("proximo refresh: ...").
    //
    //   Uso:
    //     attachAutoRefresh({
    //       container,                     // donde inyectar la UI
    //       storageKey: 'stem-auto',       // clave para persistir config
    //       label: 'Auto-refrescar',
    //       defaultMinutes: 30,
    //       minMinutes: 1, maxMinutes: 720,
    //       action: () => myRefreshFn(),   // que ejecutar
    //       cssPrefix: 'bcn8',             // prefijo de clases
    //       activateAntiThrottle: true,    // si activar audio anti-throttle
    //     });
    // ============================================================
    function attachAutoRefresh(opts) {
        const {
            container, storageKey, label = 'Auto-refrescar',
            defaultMinutes = 30, minMinutes = 1, maxMinutes = 720,
            action, cssPrefix = 'bcn8', activateAntiThrottle = false,
        } = opts;

        // UI
        const wrap = document.createElement('div');
        wrap.className = `${cssPrefix}-auto`;
        wrap.innerHTML = `
            <label class="${cssPrefix}-auto-label">
                <input type="checkbox" class="${cssPrefix}-auto-chk"/>
                <span>${label}</span>
                <span>cada</span>
                <input type="number" class="${cssPrefix}-auto-min" min="${minMinutes}" max="${maxMinutes}" step="1"/>
                <span>min</span>
            </label>
            <div class="${cssPrefix}-auto-status"></div>
        `;
        container.appendChild(wrap);

        const chk = wrap.querySelector(`.${cssPrefix}-auto-chk`);
        const minInput = wrap.querySelector(`.${cssPrefix}-auto-min`);
        const statusEl = wrap.querySelector(`.${cssPrefix}-auto-status`);

        // Cargar persistencia
        let cfg = { enabled: false, minutes: defaultMinutes };
        try {
            const raw = GM_getValue(storageKey, null);
            if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
        } catch (e) {}
        chk.checked = !!cfg.enabled;
        minInput.value = cfg.minutes;

        let nextRunAt = null;
        let intervalId = null;
        let lastCheck = 0;
        let isExecuting = false;

        const save = () => {
            try {
                GM_setValue(storageKey, JSON.stringify({
                    enabled: chk.checked,
                    minutes: parseInt(minInput.value, 10) || defaultMinutes,
                }));
            } catch (e) {}
        };

        const fmt = (ts) => {
            if (!ts) return '—';
            const d = new Date(ts);
            return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        };

        const updateStatus = () => {
            if (!chk.checked) {
                statusEl.textContent = 'Desactivado';
                statusEl.className = `${cssPrefix}-auto-status off`;
                return;
            }
            if (isExecuting) {
                statusEl.textContent = 'Ejecutando ahora...';
                statusEl.className = `${cssPrefix}-auto-status running`;
                return;
            }
            if (nextRunAt) {
                const remainMs = nextRunAt - Date.now();
                if (remainMs <= 0) {
                    statusEl.textContent = 'Ejecutando...';
                } else {
                    const mins = Math.ceil(remainMs / 60000);
                    statusEl.textContent = `Próximo refresh: ${fmt(nextRunAt)} (en ${mins} min)`;
                }
            } else {
                statusEl.textContent = 'Activo · esperando primera ejecución...';
            }
            statusEl.className = `${cssPrefix}-auto-status on`;
        };

        const scheduleNext = () => {
            const m = Math.max(minMinutes, Math.min(maxMinutes, parseInt(minInput.value, 10) || defaultMinutes));
            nextRunAt = Date.now() + m * 60000;
            updateStatus();
        };

        const executeNow = async () => {
            if (isExecuting) return;
            isExecuting = true;
            updateStatus();
            try {
                if (activateAntiThrottle) {
                    window.__bcn8AntiThrottle?.start();
                }
                await action();
            } catch (e) {
                console.error('[BCN8 auto] error:', e);
            } finally {
                if (activateAntiThrottle) {
                    // Dejamos el anti-throttle activo si auto-refresh sigue ON,
                    // para que la pestana no se ralentice esperando al siguiente.
                    if (!chk.checked) {
                        window.__bcn8AntiThrottle?.stop();
                    }
                }
                isExecuting = false;
                if (chk.checked) scheduleNext();
                else updateStatus();
            }
        };

        const tick = () => {
            updateStatus();
            if (!chk.checked) return;
            if (!nextRunAt) return;
            // Comprobar reloj real, defensivo contra throttle de timers
            if (Date.now() >= nextRunAt && !isExecuting) {
                executeNow();
            }
        };

        const start = () => {
            if (intervalId) clearInterval(intervalId);
            // Tick cada 15s (granularidad fina, contra throttle)
            intervalId = setInterval(tick, 15000);
            scheduleNext();
            if (activateAntiThrottle) {
                window.__bcn8AntiThrottle?.start();
            }
        };
        const stop = () => {
            if (intervalId) { clearInterval(intervalId); intervalId = null; }
            nextRunAt = null;
            updateStatus();
            if (activateAntiThrottle) {
                window.__bcn8AntiThrottle?.stop();
            }
        };

        chk.addEventListener('change', () => {
            save();
            if (chk.checked) start();
            else stop();
        });
        minInput.addEventListener('change', () => {
            save();
            if (chk.checked) scheduleNext();
        });

        // Si estaba activado en sesion previa, arrancar
        if (chk.checked) start();
        else updateStatus();

        return { triggerNow: executeNow, scheduleNext, isEnabled: () => chk.checked };
    }

    // CSS comun para auto-refresh blocks
    const autoRefreshCSS = `
        .bcn8-auto {
            padding: 8px 12px; background: #fafafa; border-bottom: 1px solid #eee;
            font-size: 11px;
        }
        .bcn8-auto-label {
            display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
            color: #555; font-weight: 600; cursor: pointer;
        }
        .bcn8-auto-chk { margin: 0; }
        .bcn8-auto-min {
            width: 50px; padding: 2px 4px; border: 1px solid #d5d9d9;
            border-radius: 3px; font-size: 11px; font-family: inherit;
        }
        .bcn8-auto-status {
            margin-top: 3px; font-size: 10px;
        }
        .bcn8-auto-status.off { color: #888; }
        .bcn8-auto-status.on { color: #0a7f28; font-weight: 600; }
        .bcn8-auto-status.running { color: #b26100; font-weight: 600; }
    `;
    if (!document.getElementById('bcn8-auto-css')) {
        const s = document.createElement('style');
        s.id = 'bcn8-auto-css';
        s.textContent = autoRefreshCSS;
        document.head.appendChild(s);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, m => (
            { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]
        ));
    }

    function findAncestor(el, pred) {
        let cur = el;
        while (cur && cur !== document.body) {
            if (pred(cur)) return cur;
            cur = cur.parentElement;
        }
        return null;
    }
    function findRowAncestor(el) {
        return findAncestor(el, n =>
            (n.getAttribute && n.getAttribute('role') === 'row') || n.tagName === 'TR'
        );
    }
    function getRowCells(row) {
        return Array.from(row.children).filter(c => {
            const r = c.getAttribute && c.getAttribute('role');
            return r === 'cell' || r === 'gridcell' || r === 'columnheader'
                || c.tagName === 'TD' || c.tagName === 'TH';
        });
    }
    function findScrollable(el) {
        let cur = el;
        while (cur && cur !== document.body) {
            const cs = window.getComputedStyle(cur);
            if (/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 2) return cur;
            cur = cur.parentElement;
        }
        return null;
    }
    function findHeaderByText(text) {
        const all = document.querySelectorAll('*');
        for (const el of all) {
            if (el.children.length > 0) continue;
            if ((el.textContent || '').trim() === text) return el;
        }
        return null;
    }
    function findDataRow(el) {
        let cur = el;
        while (cur && cur !== document.body) {
            if (cur.tagName === 'TR') return cur;
            if (cur.getAttribute && cur.getAttribute('role') === 'row') return cur;
            cur = cur.parentElement;
        }
        cur = el;
        for (let depth = 0; depth < 12 && cur && cur !== document.body; depth++) {
            const parent = cur.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                if (sameTag.length >= 5) return cur;
            }
            cur = parent;
        }
        return null;
    }

    if (host.includes('stem-eu')) {
        if (window.__bcn8StemLoaded) return;
        window.__bcn8StemLoaded = true;
        initStem();
    } else if (host.includes('trans-logistics-eu')) {
        if (path.includes('shipclerk')) {
            if (window.__bcn8YardLoaded) return;
            window.__bcn8YardLoaded = true;
            initYard();
        } else if (path.includes('sesameGateConsole')) {
            if (window.__bcn8ArrLoaded) return;
            window.__bcn8ArrLoaded = true;
            initArrivals();
        }
    }

    // ============================================================
    //                  STEM-EU: DASHBOARD DE CARGAS
    // ============================================================
    function initStem() {
        const style = document.createElement('style');
        style.textContent = `
            #bcn8-dashboard {
                position: fixed; top: 80px; right: 20px;
                width: 400px; max-height: 80vh;
                background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                z-index: 2147483000;
                font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                font-size: 13px; color: #111;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #bcn8-dashboard.bcn8-min { max-height: 42px; width: 260px; }
            #bcn8-dashboard.bcn8-min .bcn8-body,
            #bcn8-dashboard.bcn8-min .bcn8-toolbar,
            #bcn8-dashboard.bcn8-min .bcn8-status { display: none; }
            .bcn8-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(180deg,#232f3e 0%,#1b2532 100%);
                color: #fff; cursor: move; user-select: none;
            }
            .bcn8-title { font-weight: 600; font-size: 13px; }
            .bcn8-actions { display: flex; gap: 4px; }
            .bcn8-btn {
                background: rgba(255,255,255,0.14); border: none; color: #fff;
                min-width: 26px; height: 26px; padding: 0 8px;
                border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .bcn8-btn:hover { background: rgba(255,255,255,0.28); }
            .bcn8-btn.loading { animation: bcn8-spin 1s linear infinite; }
            @keyframes bcn8-spin { from {transform:rotate(0)} to {transform:rotate(360deg)} }
            .bcn8-toolbar {
                padding: 8px 10px; border-bottom: 1px solid #eee;
                display: flex; gap: 6px; align-items: center; background: #fafafa;
            }
            .bcn8-search {
                flex: 1; padding: 5px 8px; border: 1px solid #d5d9d9;
                border-radius: 4px; font-size: 12px; outline: none;
            }
            .bcn8-search:focus { border-color: #0073bb; box-shadow: 0 0 0 2px rgba(0,115,187,0.15); }
            .bcn8-status {
                font-size: 11px; color: #555; padding: 6px 12px;
                background: #f7f8f8; border-bottom: 1px solid #eee;
            }
            .bcn8-status .saved { color: #0a7f28; font-weight: 600; }
            .bcn8-body { padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; }
            .bcn8-destination {
                border: 1px solid #e7e7e7; border-radius: 6px; padding: 8px 10px;
                margin-bottom: 7px; background: #fafafa;
            }
            .bcn8-dest-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
            .bcn8-dest-name { font-weight: 600; color: #0f4a8a; font-size: 13px; word-break: break-word; }
            .bcn8-dest-count {
                background: #232f3e; color: #fff; border-radius: 10px;
                padding: 1px 8px; font-size: 11px; font-weight: 500; margin-left: 6px; flex-shrink: 0;
            }
            .bcn8-sl-list { display: flex; flex-wrap: wrap; gap: 4px; }
            .bcn8-sl-tag {
                background: #fff; border: 1px solid #d5d9d9; border-radius: 3px;
                padding: 2px 6px; font-size: 11px;
                font-family: 'Consolas','Monaco',monospace; color: #222;
            }
            .bcn8-empty { text-align: center; color: #777; padding: 20px 10px; font-size: 12px; }
            .bcn8-error {
                color: #8b2020; background: #fdecec; border: 1px solid #f5c0c0;
                padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 4px 0;
            }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'bcn8-dashboard';
        panel.innerHTML = `
            <div class="bcn8-header" id="bcn8-drag">
                <span class="bcn8-title">📦 Cargas por destino</span>
                <div class="bcn8-actions">
                    <button class="bcn8-btn" id="bcn8-refresh" title="Actualizar">⟳</button>
                    <button class="bcn8-btn" id="bcn8-toggle" title="Minimizar / Maximizar">−</button>
                </div>
            </div>
            <div class="bcn8-toolbar">
                <input type="text" class="bcn8-search" id="bcn8-search" placeholder="Filtrar destino o SL..."/>
            </div>
            <div class="bcn8-status" id="bcn8-status">Pulsa ⟳ para cargar los datos.</div>
            <div class="bcn8-body" id="bcn8-body">
                <div class="bcn8-empty">Ve al "Área de almacenamiento temporal" / "Staging Area" y pulsa actualizar.</div>
            </div>
        `;
        document.body.appendChild(panel);

        const refreshBtn = panel.querySelector('#bcn8-refresh');
        const toggleBtn  = panel.querySelector('#bcn8-toggle');
        const searchInp  = panel.querySelector('#bcn8-search');
        const statusEl   = panel.querySelector('#bcn8-status');
        const bodyEl     = panel.querySelector('#bcn8-body');
        const header     = panel.querySelector('#bcn8-drag');

        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('bcn8-min');
            toggleBtn.textContent = panel.classList.contains('bcn8-min') ? '+' : '−';
        });
        let drag = null;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            drag = { x: e.clientX - r.left, y: e.clientY - r.top };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!drag) return;
            panel.style.left = (e.clientX - drag.x) + 'px';
            panel.style.top  = (e.clientY - drag.y) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => drag = null);

        let lastData = null;
        searchInp.addEventListener('input', () => render(lastData));

        function findAsigEtq() {
            const all = document.querySelectorAll('span, th, div');
            let asig = null, etq = null;
            for (const el of all) {
                if (el.children.length > 0) continue;
                const t = (el.textContent || '').trim();
                // ES: "Asignaciones" / "Etiqueta"
                // EN: "Allocations" / "Label"
                if (!asig && (t === 'Asignaciones' || t === 'Allocations')) asig = el;
                else if (!etq && (t === 'Etiqueta' || t === 'Label')) etq = el;
                if (asig && etq) break;
            }
            return { asig, etq };
        }

        function collectRows(scope, asigIdx, etqIdx, bucket) {
            const rows = scope.querySelectorAll('[role="row"], tr');
            for (const row of rows) {
                const cells = getRowCells(row);
                if (cells.length === 0) continue;
                if (cells.length <= Math.max(asigIdx, etqIdx)) continue;
                const firstTxt = (cells[asigIdx]?.textContent || '').trim();
                if (firstTxt === 'Asignaciones' || firstTxt === 'Allocations') continue;
                const dest  = (cells[asigIdx].textContent || '').trim();
                const label = (cells[etqIdx].textContent || '').trim();
                if (!dest || !label) continue;
                if (!label.toUpperCase().startsWith('SL')) continue;
                bucket.set(label, { dest, label });
            }
        }

        async function extractAll() {
            const { asig, etq } = findAsigEtq();
            if (!asig || !etq) return { error: 'No encuentro las columnas "Asignaciones/Allocations" y "Etiqueta/Label". Abre el Área de almacenamiento temporal / Staging Area antes de actualizar.' };
            const asigRow = findRowAncestor(asig);
            const etqRow  = findRowAncestor(etq);
            if (!asigRow || asigRow !== etqRow) return { error: 'No consigo identificar la fila de cabecera.' };
            const headerCells = getRowCells(asigRow);
            const asigIdx = headerCells.findIndex(c => c.contains(asig));
            const etqIdx  = headerCells.findIndex(c => c.contains(etq));
            if (asigIdx < 0 || etqIdx < 0) return { error: 'No puedo determinar indices de columna.' };
            const scope = findAncestor(asigRow, n =>
                (n.getAttribute && ['table','grid'].includes(n.getAttribute('role'))) || n.tagName === 'TABLE'
            ) || asigRow.parentElement?.parentElement || document.body;

            const bucket = new Map();
            collectRows(scope, asigIdx, etqIdx, bucket);

            const scrollable = findScrollable(asigRow);
            if (scrollable) {
                const origScroll = scrollable.scrollTop;
                scrollable.scrollTop = 0;
                await sleep(250);
                let last = -1;
                for (let i = 0; i < 60; i++) {
                    collectRows(scope, asigIdx, etqIdx, bucket);
                    if (scrollable.scrollTop === last) break;
                    last = scrollable.scrollTop;
                    scrollable.scrollTop += scrollable.clientHeight * 0.85;
                    await sleep(180);
                    if (scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 2) {
                        await sleep(180);
                        collectRows(scope, asigIdx, etqIdx, bucket);
                        break;
                    }
                }
                scrollable.scrollTop = origScroll;
            }

            const byDest = {};
            for (const { dest, label } of bucket.values()) {
                (byDest[dest] = byDest[dest] || []).push(label);
            }
            for (const k of Object.keys(byDest)) byDest[k] = [...new Set(byDest[k])].sort();
            return { data: byDest, total: bucket.size };
        }

        function render(result) {
            if (!result) return;
            if (result.error) { bodyEl.innerHTML = `<div class="bcn8-error">${escapeHtml(result.error)}</div>`; return; }
            const { data } = result;
            const filter = (searchInp.value || '').trim().toLowerCase();
            let destinations = Object.keys(data).sort((a,b) => a.localeCompare(b));
            if (filter) {
                destinations = destinations.filter(d =>
                    d.toLowerCase().includes(filter) ||
                    data[d].some(sl => sl.toLowerCase().includes(filter)));
            }
            if (destinations.length === 0) {
                bodyEl.innerHTML = `<div class="bcn8-empty">${filter ? 'Sin resultados.' : 'No hay datos.'}</div>`;
                return;
            }
            bodyEl.innerHTML = destinations.map(d => {
                const sls = data[d];
                const shown = filter
                    ? sls.filter(sl => sl.toLowerCase().includes(filter) || d.toLowerCase().includes(filter))
                    : sls;
                return `
                    <div class="bcn8-destination">
                        <div class="bcn8-dest-head">
                            <div class="bcn8-dest-name">${escapeHtml(d)}</div>
                            <div class="bcn8-dest-count">${sls.length}</div>
                        </div>
                        <div class="bcn8-sl-list">
                            ${shown.map(sl => `<span class="bcn8-sl-tag">${escapeHtml(sl)}</span>`).join('')}
                        </div>
                    </div>`;
            }).join('');
        }

        async function refresh() {
            refreshBtn.classList.add('loading');
            statusEl.textContent = 'Leyendo tabla...';
            try {
                const result = await extractAll();
                lastData = result;
                if (result.error) statusEl.textContent = 'Error';
                else {
                    const now = Date.now();
                    const nowStr = new Date(now).toLocaleTimeString('es-ES');
                    try {
                        GM_setValue('destToSLs', JSON.stringify({
                            data: result.data, total: result.total, updatedAt: now
                        }));
                        statusEl.innerHTML = `${Object.keys(result.data).length} destinos · ${result.total} ubicaciones · ${nowStr} <span class="saved">✓ guardado</span>`;
                    } catch (e) {
                        statusEl.textContent = `${Object.keys(result.data).length} destinos · ${result.total} ubicaciones · ${nowStr} (no se pudo guardar)`;
                    }
                }
                render(result);
            } catch (e) {
                console.error('[BCN8]', e);
                lastData = { error: 'Error inesperado: ' + (e?.message || e) };
                statusEl.textContent = 'Error';
                render(lastData);
            } finally {
                refreshBtn.classList.remove('loading');
            }
        }
        refreshBtn.addEventListener('click', refresh);
        setTimeout(() => {
            const { asig, etq } = findAsigEtq();
            if (asig && etq) refresh();
        }, 1500);

        // Auto-refresh: anadimos el bloque al final del panel
        attachAutoRefresh({
            container: panel,
            storageKey: 'bcn8-stem-auto',
            label: 'Auto-refrescar STEM',
            defaultMinutes: 30,
            minMinutes: 5,
            maxMinutes: 720,
            action: refresh,
            cssPrefix: 'bcn8',
            activateAntiThrottle: true,
        });
    }


    // ============================================================
    //                  YARD: PARKINGS LIBRES
    // ============================================================
    function initYard() {
        const style = document.createElement('style');
        style.textContent = `
            #bcn8-yard {
                position: fixed; top: 80px; right: 20px;
                width: 380px; max-height: 80vh;
                background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                z-index: 2147483000;
                font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                font-size: 13px; color: #111;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #bcn8-yard.bcn8-min { max-height: 42px; width: 240px; }
            #bcn8-yard.bcn8-min .bcn8-y-body, #bcn8-yard.bcn8-min .bcn8-y-status { display: none; }
            .bcn8-y-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(180deg,#232f3e 0%,#1b2532 100%);
                color: #fff; cursor: move; user-select: none;
            }
            .bcn8-y-title { font-weight: 600; font-size: 13px; }
            .bcn8-y-actions { display: flex; gap: 4px; }
            .bcn8-y-btn {
                background: rgba(255,255,255,0.14); border: none; color: #fff;
                min-width: 26px; height: 26px; padding: 0 8px;
                border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .bcn8-y-btn:hover { background: rgba(255,255,255,0.28); }
            .bcn8-y-btn.loading { animation: bcn8-spin 1s linear infinite; }
            @keyframes bcn8-spin { from {transform:rotate(0)} to {transform:rotate(360deg)} }
            .bcn8-y-status {
                font-size: 11px; color: #555; padding: 6px 12px;
                background: #f7f8f8; border-bottom: 1px solid #eee;
            }
            .bcn8-y-status .saved { color: #0a7f28; font-weight: 600; }
            .bcn8-y-body { padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; }
            .bcn8-y-list { display: flex; flex-wrap: wrap; gap: 4px; }
            .bcn8-y-tag {
                background: #e6f4ea; border: 1px solid #b7dfc2; border-radius: 3px;
                padding: 2px 6px; font-size: 11px;
                font-family: 'Consolas','Monaco',monospace; color: #1f5a2e;
            }
            .bcn8-y-empty { text-align: center; color: #777; padding: 20px 10px; font-size: 12px; }
            .bcn8-y-error {
                color: #8b2020; background: #fdecec; border: 1px solid #f5c0c0;
                padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 4px 0;
            }
            .bcn8-y-summary {
                display: flex; gap: 10px; font-size: 11px; color: #555;
                padding: 4px 0; margin-bottom: 8px;
                border-bottom: 1px solid #eee;
            }
            .bcn8-y-summary b { color: #111; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'bcn8-yard';
        panel.innerHTML = `
            <div class="bcn8-y-header" id="bcn8-y-drag">
                <span class="bcn8-y-title">🅿️ Parkings libres</span>
                <div class="bcn8-y-actions">
                    <button class="bcn8-y-btn" id="bcn8-y-refresh" title="Actualizar">⟳</button>
                    <button class="bcn8-y-btn" id="bcn8-y-toggle" title="Minimizar / Maximizar">−</button>
                </div>
            </div>
            <div class="bcn8-y-status" id="bcn8-y-status">Pulsa ⟳ para buscar parkings libres.</div>
            <div class="bcn8-y-body" id="bcn8-y-body">
                <div class="bcn8-y-empty">Asegurate de que la tabla del yard esta cargada y pulsa actualizar.</div>
            </div>
        `;
        document.body.appendChild(panel);

        const refreshBtn = panel.querySelector('#bcn8-y-refresh');
        const toggleBtn  = panel.querySelector('#bcn8-y-toggle');
        const statusEl   = panel.querySelector('#bcn8-y-status');
        const bodyEl     = panel.querySelector('#bcn8-y-body');
        const header     = panel.querySelector('#bcn8-y-drag');

        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('bcn8-min');
            toggleBtn.textContent = panel.classList.contains('bcn8-min') ? '+' : '−';
        });
        let drag = null;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            drag = { x: e.clientX - r.left, y: e.clientY - r.top };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!drag) return;
            panel.style.left = (e.clientX - drag.x) + 'px';
            panel.style.top  = (e.clientY - drag.y) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => drag = null);

        const PS_REGEX = /^PS\s*[-–]?\s*\d+\s*$/i;

        // Deteccion basada en la estructura real de la tabla del yard:
        //  - Cada fila es un <tr>
        //  - td.col1 = columna Location (donde esta el link "PS - 165")
        //  - td.col2 = columna Vehicle (donde aparece el icono .yard-asset-icon si esta ocupado)
        //  - Un PS esta OCUPADO si td.col2 contiene un .yard-asset-icon. LIBRE en caso contrario.
        function scanYardRows() {
            const all = new Map();   // canon -> display
            const free = new Map();  // canon -> display
            const trs = document.querySelectorAll('tr');
            for (const tr of trs) {
                if (tr.querySelector('th')) continue;
                const c1 = tr.querySelector('td.col1');
                const c2 = tr.querySelector('td.col2');
                if (!c1 || !c2) continue;
                const loc = (c1.textContent || '').trim().replace(/\s+/g, ' ');
                if (!loc) continue;
                if (!PS_REGEX.test(loc)) continue;

                const canon = loc.toUpperCase().replace(/\s+/g, '');
                const numMatch = loc.match(/\d+/);
                const display = numMatch ? `PS-${numMatch[0]}` : loc;

                all.set(canon, display);

                // OCUPADO si hay .yard-asset-icon en la columna Vehicle
                const hasTrailer = !!c2.querySelector('.yard-asset-icon');
                if (!hasTrailer) {
                    free.set(canon, display);
                }
            }
            return { all, free };
        }

        async function extractFree() {
            // Primera pasada
            let { all: allBucket, free: freeBucket } = scanYardRows();

            // Si esta virtualizado, puede que la primera pasada solo tenga parte de la tabla.
            // Scrollear para ir recogiendo el resto.
            if (allBucket.size > 0) {
                // Localizar la primera fila de datos con td.col1 tipo PS para encontrar su scroll
                let refRow = null;
                const trs = document.querySelectorAll('tr');
                for (const tr of trs) {
                    const c1 = tr.querySelector('td.col1');
                    if (c1 && PS_REGEX.test((c1.textContent||'').trim())) { refRow = tr; break; }
                }

                let scrollable = refRow ? findScrollable(refRow) : null;
                let useWindow = false;
                if (!scrollable) {
                    if (document.documentElement.scrollHeight > window.innerHeight + 10) useWindow = true;
                }

                if (scrollable || useWindow) {
                    const getScroll = () => useWindow ? window.scrollY : scrollable.scrollTop;
                    const setScroll = (v) => useWindow ? window.scrollTo(0, v) : (scrollable.scrollTop = v);
                    const getClientH = () => useWindow ? window.innerHeight : scrollable.clientHeight;
                    const getScrollH = () => useWindow ? document.documentElement.scrollHeight : scrollable.scrollHeight;

                    const origScroll = getScroll();
                    setScroll(0);
                    await sleep(300);

                    let last = -1;
                    for (let i = 0; i < 120; i++) {
                        const { all: a2, free: f2 } = scanYardRows();
                        for (const [k, v] of a2) allBucket.set(k, v);
                        // Para freeBucket hay que tener cuidado: un PS puede aparecer LIBRE
                        // en una posicion de scroll y OCUPADO en otra? no deberia, pero por seguridad
                        // solo marcamos como libre si se vio como libre (a2 lo dijo libre).
                        for (const [k, v] of f2) freeBucket.set(k, v);
                        // Y si un PS visto ahora como OCUPADO estaba en freeBucket, quitarlo
                        for (const [k] of a2) {
                            if (!f2.has(k) && freeBucket.has(k)) freeBucket.delete(k);
                        }
                        const cur = getScroll();
                        if (cur === last) break;
                        last = cur;
                        setScroll(cur + getClientH() * 0.85);
                        await sleep(200);
                        if (getScroll() + getClientH() >= getScrollH() - 2) {
                            await sleep(250);
                            const { all: a3, free: f3 } = scanYardRows();
                            for (const [k, v] of a3) allBucket.set(k, v);
                            for (const [k, v] of f3) freeBucket.set(k, v);
                            for (const [k] of a3) {
                                if (!f3.has(k) && freeBucket.has(k)) freeBucket.delete(k);
                            }
                            break;
                        }
                    }
                    setScroll(origScroll);
                }
            }

            if (allBucket.size === 0) {
                return { error: 'No encuentro ningún parking (PS) en la tabla. Asegurate de estar en Yard Management.' };
            }

            const freeEntries = [...freeBucket.entries()];
            freeEntries.sort((a, b) => {
                const na = parseInt((a[0].match(/\d+/) || ['0'])[0], 10);
                const nb = parseInt((b[0].match(/\d+/) || ['0'])[0], 10);
                return na - nb;
            });

            return {
                list: freeEntries.map(([, display]) => display),
                canonical: freeEntries.map(([k]) => k),
                totalPS: allBucket.size
            };
        }

        function render(result) {
            if (!result) return;
            if (result.error) { bodyEl.innerHTML = `<div class="bcn8-y-error">${escapeHtml(result.error)}</div>`; return; }

            const summary = `<div class="bcn8-y-summary">
                <span><b>${result.list.length}</b> libres</span>
                <span><b>${result.totalPS}</b> totales</span>
                <span><b>${result.totalPS - result.list.length}</b> ocupados</span>
            </div>`;

            if (!result.list || result.list.length === 0) {
                bodyEl.innerHTML = summary + `<div class="bcn8-y-empty">No hay parkings libres en este momento.</div>`;
                return;
            }
            bodyEl.innerHTML = summary + `<div class="bcn8-y-list">${
                result.list.map(ps => `<span class="bcn8-y-tag">${escapeHtml(ps)}</span>`).join('')
            }</div>`;
        }

        async function refresh() {
            refreshBtn.classList.add('loading');
            statusEl.textContent = 'Escaneando yard...';
            try {
                const result = await extractFree();
                if (result.error) {
                    statusEl.textContent = 'Error';
                    render(result);
                } else {
                    const now = Date.now();
                    const nowStr = new Date(now).toLocaleTimeString('es-ES');
                    try {
                        GM_setValue('freePS', JSON.stringify({
                            list: result.list,
                            canonical: result.canonical,
                            total: result.list.length,
                            totalPS: result.totalPS,
                            updatedAt: now
                        }));
                        statusEl.innerHTML = `${result.list.length} libres / ${result.totalPS} totales · ${nowStr} <span class="saved">✓ guardado</span>`;
                    } catch (e) {
                        statusEl.textContent = `${result.list.length} libres · ${nowStr} (no se pudo guardar)`;
                    }
                    render(result);
                }
            } catch (e) {
                console.error('[BCN8 Yard]', e);
                statusEl.textContent = 'Error';
                render({ error: 'Error inesperado: ' + (e?.message || e) });
            } finally {
                refreshBtn.classList.remove('loading');
            }
        }

        refreshBtn.addEventListener('click', refresh);
        // Autoarranque cuando detectamos la tabla del yard cargada
        setTimeout(() => {
            const { all } = scanYardRows();
            if (all.size > 0) refresh();
        }, 2500);

        // Auto-refresh
        attachAutoRefresh({
            container: panel,
            storageKey: 'bcn8-yard-auto',
            label: 'Auto-refrescar Yard',
            defaultMinutes: 15,
            minMinutes: 2,
            maxMinutes: 240,
            action: refresh,
            cssPrefix: 'bcn8',
            activateAntiThrottle: true,
        });
    }


    // ============================================================
    //              ARRIVALS: PRE-ASIGNACION DE CAMIONES
    // ============================================================
    function initArrivals() {

        // Normaliza un Account para comparar de forma robusta:
        //  - quita espacios al inicio/final, multiples espacios internos, nbsp
        //  - quita caracteres no alfanumericos (separadores raros)
        //  - case-insensitive
        function normalizeAccount(s) {
            if (!s) return '';
            return String(s)
                .replace(/[\u00A0\s]+/g, '')
                .replace(/[^A-Za-z0-9]/g, '')
                .toLowerCase();
        }
        function matchAccountInSet(account, accountSet) {
            const normAcc = normalizeAccount(account);
            if (!normAcc) return false;
            for (const candidate of accountSet) {
                if (normalizeAccount(candidate) === normAcc) return true;
            }
            return false;
        }
        function matchAccountInDocks(account, docksObj) {
            const normAcc = normalizeAccount(account);
            if (!normAcc) return null;
            for (const key of Object.keys(docksObj)) {
                if (normalizeAccount(key) === normAcc) return docksObj[key];
            }
            return null;
        }

        // Accounts que SIEMPRE van a PS vacio (prioridad sobre cualquier match en STEM).
        const SPECIAL_ACCOUNTS = new Set([
            'FleetManagementEquipmentRepositioning',
            'TrailerWash',
            'StemLegBobTail',
            'TransfersTote',
            'BobtailMovementAnnotation',
            'TransfersInitialPlacement',
            'TransfersNonInventory',
            'TransfersDamagedCarts',
            'RailTrailerPoolAdjustment',
            'TrailerPoolAdjustment',
        ]);

        // Accounts con muelles FIJOS (siempre se asignan a estos DDs
        // sin importar lo que diga Stem ni la paginacion de PS).
        const FIXED_ACCOUNT_DOCKS = {
            'ATSReturns': ['DD-138', 'DD-139', 'DD-137']
        };

        const SL_TABLE = `
SL-N-100-L	DD-101	DD-102	DD-103
SL-N-100-R	DD-101	DD-102	DD-103
SL-N-101-L	DD-101	DD-102	DD-103
SL-N-101-R	DD-101	DD-102	DD-103
SL-N-102-L	DD-101	DD-102	DD-103
SL-N-102-R	DD-101	DD-102	DD-103
SL-N-103-L	DD-102	DD-103	DD-104
SL-N-103-R	DD-102	DD-103	DD-104
SL-N-104-L	DD-102	DD-103	DD-104
SL-N-104-R	DD-102	DD-103	DD-104
SL-N-105-L	DD-103	DD-104	DD-105
SL-N-105-R	DD-103	DD-104	DD-105
SL-N-106-L	DD-106	DD-104	DD-105
SL-N-106-R	DD-106	DD-104	DD-105
SL-N-107	DD-106	DD-105	DD-108
SL-N-108-L	DD-106	DD-109	DD-108
SL-N-108-R	DD-106	DD-109	DD-108
SL-N-109-L	DD-108	DD-109	DD-110
SL-N-109-R	DD-108	DD-109	DD-110
SL-N-110-L	DD-108	DD-109	DD-110
SL-N-110-R	DD-108	DD-109	DD-110
SL-N-111-L	DD-110	DD-111	DD-112
SL-N-111-R	DD-110	DD-111	DD-112
SL-N-112-L	DD-111	DD-112	DD-113
SL-N-112-R	DD-111	DD-112	DD-113
SL-N-113	DD-111	DD-112	DD-113
SL-N-113-L	DD-111	DD-112	DD-113
SL-N-113-R	DD-111	DD-112	DD-113
SL-N-114-L	DD-113	DD-114	DD-115
SL-N-114-R	DD-113	DD-114	DD-115
SL-N-115-L	DD-114	DD-115	DD-116
SL-N-115-R	DD-114	DD-115	DD-116
SL-N-116-L	DD-115	DD-116	DD-117
SL-N-116-R	DD-115	DD-116	DD-117
SL-N-117-L	DD-116	DD-117	DD-118
SL-N-117-R	DD-116	DD-117	DD-118
SL-N-118-L	DD-117	DD-118	DD-119
SL-N-118-R	DD-117	DD-118	DD-119
SL-N-119-L	DD-118	DD-119	DD-120
SL-N-119-R	DD-118	DD-119	DD-120
SL-N-120-L	DD-119	DD-120	DD-121
SL-N-120-R	DD-119	DD-120	DD-121
SL-N-121-L	DD-120	DD-121	DD-118
SL-N-121-R	DD-120	DD-121	DD-118
SL-N-124-L	DD-124	DD-125	DD-126
SL-N-124-R	DD-124	DD-125	DD-126
SL-N-125-L	DD-124	DD-125	DD-126
SL-N-125-R	DD-124	DD-125	DD-126
SL-N-126-L	DD-125	DD-126	DD-127
SL-N-126-R	DD-125	DD-126	DD-127
SL-N-127-L	DD-126	DD-127	DD-128
SL-N-127-R	DD-126	DD-127	DD-128
SL-N-128-L	DD-127	DD-128	DD-129
SL-N-128-R	DD-127	DD-128	DD-129
SL-N-129-L	DD-128	DD-129	DD-131
SL-N-129-R	DD-128	DD-129	DD-131
SL-N-131-L	DD-129	DD-131	DD-132
SL-N-131-R	DD-129	DD-131	DD-132
SL-N-132-L	DD-131	DD-132	DD-133
SL-N-132-R	DD-131	DD-132	DD-133
SL-N-133-L	DD-132	DD-133	DD-134
SL-N-133-R	DD-132	DD-133	DD-134
SL-N-134-L	DD-133	DD-134	DD-135
SL-N-134-R	DD-133	DD-134	DD-135
SL-N-135-L	DD-134	DD-135	DD-136
SL-N-135-R	DD-134	DD-135	DD-136
SL-N-136-L	DD-135	DD-136	DD-137
SL-N-136-R	DD-135	DD-136	DD-137
SL-N-137-L	DD-136	DD-137	DD-138
SL-N-137-R	DD-136	DD-137	DD-138
SL-XJ-01	DD-101	DD-102	DD-103
SL-XJ-02	DD-101	DD-102	DD-103
SL-XJ-03	DD-102	DD-103	DD-104
SL-XJ-04	DD-102	DD-103	DD-104
SL-XJ-05	DD-103	DD-104	DD-105
SL-XJ-06	DD-103	DD-104	DD-105
SL-XJ-07	DD-103	DD-104	DD-105
SL-XJ-08	DD-106	DD-104	DD-105
SL-XJ-09	DD-106	DD-104	DD-105
SL-XJ-10	DD-106	DD-104	DD-105
SL-XJ-11	DD-106	DD-105	DD-104
SL-XJ-12	DD-106	DD-109	DD-108
SL-XJ-13	DD-106	DD-109	DD-108
SL-XJ-14	DD-108	DD-109	DD-110
SL-XJ-15	DD-108	DD-109	DD-110
SL-XJ-16	DD-108	DD-109	DD-110
SL-XJ-17	DD-108	DD-109	DD-110
SL-XJ-18	DD-111	DD-109	DD-110
SL-XJ-19	DD-111	DD-109	DD-110
SL-XJ-20	DD-111	DD-112	DD-110
SL-XJ-21	DD-111	DD-112	DD-110
SL-XJ-22	DD-111	DD-112	DD-113
SL-XJ-23	DD-112	DD-113	DD-114
SL-XJ-24	DD-112	DD-113	DD-114
SL-XR-01	DD-113	DD-114	DD-115
SL-XR-02	DD-113	DD-114	DD-115
SL-XR-03	DD-113	DD-114	DD-115
SL-XR-04	DD-116	DD-114	DD-115
SL-XR-05	DD-114	DD-115	DD-116
SL-XR-06	DD-114	DD-115	DD-116
SL-XR-07	DD-115	DD-116	DD-117
SL-XR-08	DD-116	DD-117	DD-118
SL-XR-09	DD-116	DD-117	DD-118
SL-XR-10	DD-116	DD-117	DD-118
SL-XR-11	DD-117	DD-119	DD-118
SL-XR-12	DD-117	DD-119	DD-118
SL-XR-13	DD-118	DD-119	DD-120
SL-XR-14	DD-118	DD-119	DD-120
SL-XR-15	DD-118	DD-119	DD-120
SL-XR-16	DD-119	DD-120	DD-121
SL-XR-17	DD-119	DD-120	DD-121
SL-XR-18	DD-119	DD-120	DD-121
SL-XO-01	DD-124	DD-125	DD-126
SL-XO-02	DD-124	DD-125	DD-126
SL-XO-03	DD-124	DD-125	DD-126
SL-XO-04	DD-125	DD-126	DD-127
SL-XO-05	DD-125	DD-126	DD-127
SL-XO-06	DD-126	DD-127	DD-128
SL-XO-07	DD-126	DD-127	DD-128
SL-XO-08	DD-126	DD-127	DD-128
SL-XO-09	DD-126	DD-127	DD-128
SL-XO-10	DD-131	DD-132	DD-133
SL-XO-11	DD-131	DD-132	DD-133
SL-XO-12	DD-132	DD-133	DD-134
SL-XO-13	DD-132	DD-133	DD-134
SL-XO-14	DD-132	DD-133	DD-134
SL-XO-15	DD-133	DD-134	DD-135
SL-XB-01	DD-214	DD-206	DD-205
SL-XB-02	DD-214	DD-206	DD-205
SL-XB-03	DD-214	DD-206	DD-205
SL-XB-04	DD-214	DD-206	DD-205
SL-XB-05	DD-214	DD-206	DD-205
SL-XB-06	DD-214	DD-206	DD-205
SL-XC-01	DD-201	DD-202	DD-203
SL-XC-02	DD-201	DD-202	DD-203
SL-XC-03	DD-201	DD-202	DD-203
SL-XC-04	DD-202	DD-203	DD-204
SL-XC-05	DD-202	DD-203	DD-204
SL-XC-06	DD-202	DD-203	DD-204
SL-XC-08	DD-202	DD-203	DD-204
SL-XC-09	DD-202	DD-203	DD-204
SL-XG-01	DD-201	DD-202	DD-203
SL-XG-02	DD-201	DD-202	DD-203
SL-XG-04	DD-202	DD-203	DD-204
SL-S-201	DD-201	DD-202	DD-203
SL-S-204	DD-202	DD-203	DD-204
SL-S-206	DD-203	DD-204	DD-206
SL-S-210	DD-214	DD-206	DD-205
SL-S-213	DD-214	DD-206	DD-205
SL-S-219	DD-214	DD-221	DD-206
SL-S-220	DD-214	DD-221	DD-206
SL-S-221	DD-214	DD-221	DD-206
`;
        const SL_TO_DOCKS = {};
        SL_TABLE.trim().split('\n').forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const [sl, d1, d2, d3] = parts;
                SL_TO_DOCKS[sl.toUpperCase()] = [d1, d2, d3];
            }
        });

        const style = document.createElement('style');
        style.textContent = `
            #bcn8-arrivals {
                position: fixed; top: 80px; right: 20px;
                width: 400px; max-height: 84vh;
                background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                z-index: 2147483000;
                font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                font-size: 13px; color: #111;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #bcn8-arrivals.bcn8-min { max-height: 42px; width: 280px; }
            #bcn8-arrivals.bcn8-min .bcn8-a-body,
            #bcn8-arrivals.bcn8-min .bcn8-a-action,
            #bcn8-arrivals.bcn8-min .bcn8-a-meta { display: none; }
            .bcn8-a-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(180deg,#232f3e 0%,#1b2532 100%);
                color: #fff; cursor: move; user-select: none;
            }
            .bcn8-a-title { font-weight: 600; font-size: 13px; }
            .bcn8-a-actions { display: flex; gap: 4px; }
            .bcn8-a-btn {
                background: rgba(255,255,255,0.14); border: none; color: #fff;
                min-width: 26px; height: 26px; padding: 0 8px;
                border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .bcn8-a-btn:hover { background: rgba(255,255,255,0.28); }
            .bcn8-a-btn.loading { animation: bcn8-spin 1s linear infinite; }
            @keyframes bcn8-spin { from {transform:rotate(0)} to {transform:rotate(360deg)} }
            .bcn8-a-meta {
                padding: 8px 12px; background: #f7f8f8; border-bottom: 1px solid #eee;
                font-size: 11px; color: #555;
                display: flex; flex-direction: column; gap: 2px;
            }
            .bcn8-a-meta .stale { color: #b26100; font-weight: 600; }
            .bcn8-a-meta .ok { color: #0a7f28; font-weight: 600; }
            .bcn8-a-meta .err { color: #b71c1c; font-weight: 600; }
            .bcn8-a-filter {
                padding: 8px 12px; background: #fafafa; border-bottom: 1px solid #eee;
                font-size: 11px;
            }
            .bcn8-a-filter-label {
                font-weight: 600; color: #555; display: block; margin-bottom: 4px;
            }
            .bcn8-a-filter-row {
                display: flex; align-items: center; gap: 4px; flex-wrap: nowrap;
            }
            .bcn8-a-filter-row span { color: #666; font-size: 11px; }
            .bcn8-a-filter-input {
                flex: 1; min-width: 0; padding: 4px 6px;
                border: 1px solid #d5d9d9; border-radius: 3px;
                font-size: 12px; outline: none;
                font-family: inherit;
            }
            .bcn8-a-filter-input:focus {
                border-color: #0073bb;
                box-shadow: 0 0 0 2px rgba(0,115,187,0.15);
            }
            .bcn8-a-filter-clear {
                background: #eee; border: 1px solid #ccc; border-radius: 3px;
                width: 22px; height: 22px; padding: 0; cursor: pointer; font-size: 11px;
                color: #666;
            }
            .bcn8-a-filter-clear:hover { background: #ddd; }
            .bcn8-a-filter-hint {
                color: #888; font-size: 10px; margin-top: 3px;
            }
            .bcn8-a-filter-hint.active { color: #0073bb; font-weight: 600; }
            .bcn8-a-filter-quick {
                display: flex; align-items: center; gap: 4px; margin-top: 5px;
            }
            .bcn8-a-qbtn {
                background: #e3f2fd; border: 1px solid #90caf9; border-radius: 4px;
                padding: 3px 10px; font-size: 11px; font-weight: 600; color: #0d47a1;
                cursor: pointer; transition: background .15s;
            }
            .bcn8-a-qbtn:hover { background: #bbdefb; }
            .bcn8-a-qbtn.active { background: #0d47a1; color: #fff; border-color: #0d47a1; }
            .bcn8-a-action {
                padding: 10px 12px; background: #fff; border-bottom: 1px solid #eee;
                display: flex; flex-direction: column; gap: 6px;
            }
            .bcn8-a-run {
                background: #0073bb; color: #fff; border: none;
                padding: 8px 12px; border-radius: 4px; font-weight: 600;
                cursor: pointer; font-size: 13px;
            }
            .bcn8-a-run:hover { background: #005a94; }
            .bcn8-a-run:disabled { background: #ccc; cursor: not-allowed; }
            .bcn8-a-stop {
                background: #c14545; color: #fff; border: none;
                padding: 8px 12px; border-radius: 4px; font-weight: 600;
                cursor: pointer; font-size: 13px;
            }
            .bcn8-a-stop:hover { background: #9b2f2f; }
            .bcn8-a-stop:disabled { background: #ccc; cursor: not-allowed; }
            .bcn8-a-resume {
                background: #2e7d32; color: #fff; border: none;
                padding: 8px 12px; border-radius: 4px; font-weight: 600;
                cursor: pointer; font-size: 13px;
            }
            .bcn8-a-resume:hover { background: #205024; }
            .bcn8-a-progress {
                font-size: 11px; color: #0073bb; font-weight: 600; margin-top: 4px;
            }
            .bcn8-a-body { padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; }
            .bcn8-a-section { margin-bottom: 8px; }
            .bcn8-a-section-title {
                font-size: 11px; text-transform: uppercase;
                font-weight: 600; color: #555;
                padding: 4px 2px; margin-bottom: 4px;
                border-bottom: 1px solid #eee;
            }
            .bcn8-a-item {
                display: flex; align-items: center; justify-content: space-between;
                padding: 6px 8px; border-radius: 4px; margin-bottom: 4px;
                background: #fafafa; border: 1px solid #e7e7e7;
                gap: 6px;
            }
            .bcn8-a-item.unmatched { background: #fff4e5; border-color: #f0c070; }
            .bcn8-a-item.skipped { background: #eee; border-color: #ccc; opacity: 0.85; }
            .bcn8-a-item.ok { background: #e6f4ea; border-color: #b7dfc2; }
            .bcn8-a-item.ok-ps { background: #e3f2fd; border-color: #8bb8e8; }
            .bcn8-a-item-name { font-weight: 600; font-size: 12px; word-break: break-word; }
            .bcn8-a-item-docks {
                font-family: 'Consolas','Monaco',monospace;
                font-size: 11px; color: #333; margin-top: 2px;
            }
            .bcn8-a-badge {
                display: inline-block; font-size: 10px; font-weight: 700;
                padding: 1px 5px; border-radius: 3px; margin-right: 4px;
            }
            .bcn8-a-badge.dd { background: #c8e6c9; color: #1b5e20; }
            .bcn8-a-badge.ps { background: #bbdefb; color: #0d47a1; }
            .bcn8-a-badge.pg { background: #ddd; color: #333; }
            .bcn8-a-badge.hr { background: #f0f0f0; color: #555; font-family: 'Consolas', monospace; }
            .bcn8-a-badge.skip { background: #e0e0e0; color: #666; }
            .bcn8-a-goto {
                background: #232f3e; color: #fff; border: none;
                padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;
                flex-shrink: 0;
            }
            .bcn8-a-goto:hover { background: #0f1924; }
            .bcn8-a-empty { padding: 14px; text-align: center; color: #888; font-size: 12px; }
            .bcn8-a-error {
                background: #fdecec; border: 1px solid #f5c0c0; color: #8b2020;
                padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 4px 0;
            }
            @keyframes bcn8-flash {
                0%,100% { background: transparent; }
                20%,60% { background: #fff59d; }
            }
            .bcn8-flash { animation: bcn8-flash 1.6s ease 2; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'bcn8-arrivals';
        panel.innerHTML = `
            <div class="bcn8-a-header" id="bcn8-a-drag">
                <span class="bcn8-a-title">🚛 Pre-asignación camiones</span>
                <div class="bcn8-a-actions">
                    <button class="bcn8-a-btn" id="bcn8-a-reload" title="Recargar datos">⟳</button>
                    <button class="bcn8-a-btn" id="bcn8-a-toggle" title="Minimizar / Maximizar">−</button>
                </div>
            </div>
            <div class="bcn8-a-meta" id="bcn8-a-meta">Cargando datos...</div>
            <div class="bcn8-a-filter">
                <label class="bcn8-a-filter-label">Filtro de hora (Sesame "Time"):</label>
                <div class="bcn8-a-filter-row">
                    <span>Desde</span>
                    <input type="time" class="bcn8-a-filter-input" id="bcn8-a-from" placeholder="HH:MM"/>
                    <span>Hasta</span>
                    <input type="time" class="bcn8-a-filter-input" id="bcn8-a-to" placeholder="HH:MM"/>
                    <button class="bcn8-a-filter-clear" id="bcn8-a-filter-clear" title="Limpiar">✕</button>
                </div>
                <div class="bcn8-a-filter-quick" id="bcn8-a-filter-quick">
                    <span style="font-size:10px;color:#666;">Rápido:</span>
                    <button class="bcn8-a-qbtn" data-hours="2">2h</button>
                    <button class="bcn8-a-qbtn" data-hours="4">4h</button>
                    <button class="bcn8-a-qbtn" data-hours="6">6h</button>
                    <button class="bcn8-a-qbtn" data-hours="8">8h</button>
                    <button class="bcn8-a-qbtn" data-hours="12">12h</button>
                </div>
                <div class="bcn8-a-filter-hint" id="bcn8-a-filter-hint">Vacio = sin filtro (procesa todos)</div>
            </div>
            <div class="bcn8-a-action">
                <button class="bcn8-a-run" id="bcn8-a-run">Asignar muelles a camiones</button>
                <button class="bcn8-a-stop" id="bcn8-a-stop" style="display:none;">⏸ Detener</button>
                <button class="bcn8-a-resume" id="bcn8-a-resume" style="display:none;">▶ Reanudar</button>
                <div class="bcn8-a-progress" id="bcn8-a-progress" style="display:none;"></div>
            </div>
            <div class="bcn8-a-body" id="bcn8-a-body">
                <div class="bcn8-a-empty">Pulsa "Asignar muelles a camiones" para empezar.</div>
            </div>
        `;
        document.body.appendChild(panel);

        const metaEl    = panel.querySelector('#bcn8-a-meta');
        const runBtn    = panel.querySelector('#bcn8-a-run');
        const stopBtn   = panel.querySelector('#bcn8-a-stop');
        const resumeBtn = panel.querySelector('#bcn8-a-resume');
        const reloadBtn = panel.querySelector('#bcn8-a-reload');
        const toggleBtn = panel.querySelector('#bcn8-a-toggle');
        const bodyEl    = panel.querySelector('#bcn8-a-body');
        const progEl   = panel.querySelector('#bcn8-a-progress');
        const header    = panel.querySelector('#bcn8-a-drag');
        const fromInp  = panel.querySelector('#bcn8-a-from');
        const toInp    = panel.querySelector('#bcn8-a-to');
        const filterClearBtn = panel.querySelector('#bcn8-a-filter-clear');
        const filterHint = panel.querySelector('#bcn8-a-filter-hint');

        // ====== Filtro de horas ======
        // Cargar valores guardados
        try {
            const savedFrom = GM_getValue('arrFilterFrom', '');
            const savedTo   = GM_getValue('arrFilterTo', '');
            if (savedFrom) fromInp.value = savedFrom;
            if (savedTo)   toInp.value = savedTo;
        } catch (e) {}

        function updateFilterHint() {
            const f = fromInp.value, t = toInp.value;
            // Intentar leer la hora de la primera fila de la tabla para mostrarla como referencia
            let sampleStr = '';
            try {
                const ctx = findTableContext();
                if (!ctx.error && ctx.timeIdx >= 0) {
                    const rows = getDataRows(ctx);
                    if (rows.length > 0) {
                        const firstTime = (rows[0].cells[ctx.timeIdx]?.textContent || '')
                            .split(/[\n\r]+/)[0].trim();
                        if (firstTime) {
                            const parsed = parseTimeToMinutes(firstTime);
                            if (parsed !== null) {
                                const h = Math.floor(parsed / 60);
                                const m = parsed % 60;
                                const hhmm = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                                sampleStr = ` · Sesame: "${firstTime}" → ${hhmm}`;
                            }
                        }
                    }
                }
            } catch (e) {}

            if (!f && !t) {
                filterHint.textContent = 'Vacio = sin filtro (procesa todos)' + sampleStr;
                filterHint.classList.remove('active');
            } else if (f && t) {
                filterHint.textContent = `Filtro: ${f} – ${t}` + sampleStr;
                filterHint.classList.add('active');
            } else if (f) {
                filterHint.textContent = `Filtro: desde ${f} en adelante` + sampleStr;
                filterHint.classList.add('active');
            } else {
                filterHint.textContent = `Filtro: hasta ${t}` + sampleStr;
                filterHint.classList.add('active');
            }
        }
        fromInp.addEventListener('change', () => {
            try { GM_setValue('arrFilterFrom', fromInp.value); } catch (e) {}
            updateFilterHint();
        });
        toInp.addEventListener('change', () => {
            try { GM_setValue('arrFilterTo', toInp.value); } catch (e) {}
            updateFilterHint();
        });
        filterClearBtn.addEventListener('click', () => {
            fromInp.value = '';
            toInp.value = '';
            try { GM_setValue('arrFilterFrom', ''); GM_setValue('arrFilterTo', ''); } catch (e) {}
            updateFilterHint();
        });
        updateFilterHint();
        // Refrescar el hint cuando la tabla termine de cargar para mostrar la hora real
        setTimeout(updateFilterHint, 1500);
        setTimeout(updateFilterHint, 4000);

        // ====== Botones rapidos (2h, 4h, 6h, 8h, 12h) ======
        function pad2(n) { return String(n).padStart(2, '0'); }
        function setQuickFilter(hours) {
            const now = new Date();
            const fromH = pad2(now.getHours()), fromM = pad2(now.getMinutes());
            const end = new Date(now.getTime() + hours * 3600000);
            const toH = pad2(end.getHours()), toM = pad2(end.getMinutes());
            fromInp.value = `${fromH}:${fromM}`;
            toInp.value = `${toH}:${toM}`;
            try { GM_setValue('arrFilterFrom', fromInp.value); GM_setValue('arrFilterTo', toInp.value); } catch (e) {}
            updateFilterHint();
            // Marcar boton activo
            panel.querySelectorAll('.bcn8-a-qbtn').forEach(b => b.classList.remove('active'));
            const activeBtn = panel.querySelector(`.bcn8-a-qbtn[data-hours="${hours}"]`);
            if (activeBtn) activeBtn.classList.add('active');
            // Programar alerta 15 min antes
            scheduleFilterAlert(end);
        }
        panel.querySelectorAll('.bcn8-a-qbtn').forEach(btn => {
            btn.addEventListener('click', () => setQuickFilter(parseInt(btn.getAttribute('data-hours'))));
        });

        // ====== Alerta 15 min antes de fin de rango ======
        let filterAlertTimer = null;
        function scheduleFilterAlert(endDate) {
            if (filterAlertTimer) { clearTimeout(filterAlertTimer); filterAlertTimer = null; }
            const msUntilAlert = endDate.getTime() - 15 * 60000 - Date.now();
            if (msUntilAlert <= 0) return; // ya pasó
            filterAlertTimer = setTimeout(() => {
                // Crear popup visual (no alert() para no bloquear)
                const popup = document.createElement('div');
                popup.style.cssText = `
                    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
                    background:#fff;border:3px solid #f57c00;border-radius:12px;padding:28px 36px;
                    box-shadow:0 8px 32px rgba(0,0,0,0.35);font-family:'Segoe UI',Arial,sans-serif;
                    text-align:center;max-width:420px;animation:bcn8-pulse 1s ease-in-out 3;
                `;
                popup.innerHTML = `
                    <div style="font-size:36px;margin-bottom:10px;">⏰</div>
                    <div style="font-size:16px;font-weight:700;color:#e65100;margin-bottom:8px;">
                        ¡Quedan 15 minutos!
                    </div>
                    <div style="font-size:13px;color:#555;line-height:1.5;">
                        El rango de pre-asignación termina a las <strong>${toInp.value}</strong>.<br>
                        Revisa los camiones pre-asignados y valida el resultado.
                    </div>
                    <button id="bcn8-alert-ok" style="
                        margin-top:16px;padding:10px 28px;background:#f57c00;color:#fff;
                        border:none;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;
                    ">Entendido</button>
                `;
                // Pulso CSS
                if (!document.getElementById('bcn8-pulse-css')) {
                    const s = document.createElement('style'); s.id = 'bcn8-pulse-css';
                    s.textContent = `@keyframes bcn8-pulse{0%,100%{box-shadow:0 8px 32px rgba(0,0,0,0.35)}50%{box-shadow:0 8px 32px rgba(245,124,0,0.6)}}`;
                    document.head.appendChild(s);
                }
                document.body.appendChild(popup);
                popup.querySelector('#bcn8-alert-ok').addEventListener('click', () => popup.remove());
                // Auto-cerrar en 60s
                setTimeout(() => { if (document.body.contains(popup)) popup.remove(); }, 60000);
            }, msUntilAlert);
        }

        // Parsea hora de la celda Time. Acepta:
        //  - "2:45:00 PM" / "10:00 AM" (12h con AM/PM)
        //  - "14:45:00" / "14:45"      (24h)
        //  - Texto multinivel (ej "2:45:00 PM \n 2026-04-22") usando solo la primera linea
        // Devuelve minutos desde medianoche (0..1439) o null si no se puede parsear.
        function parseTimeToMinutes(text) {
            if (!text) return null;
            // Tomar la primera linea con datos
            const firstLine = String(text).split(/[\n\r]+/).map(s => s.trim()).filter(Boolean)[0] || '';
            // 12h con AM/PM
            let m = firstLine.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm|a\.?m\.?|p\.?m\.?)/i);
            if (m) {
                let h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                const isPM = /p/i.test(m[3]);
                if (h === 12) h = 0;
                if (isPM) h += 12;
                return h * 60 + min;
            }
            // 24h
            m = firstLine.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
            if (m) {
                const h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                if (h <= 23 && min <= 59) return h * 60 + min;
            }
            // Buscar HH:MM en cualquier parte de la primera linea como ultimo recurso
            m = firstLine.match(/(\d{1,2}):(\d{2})/);
            if (m) {
                const h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                if (h <= 23 && min <= 59) return h * 60 + min;
            }
            return null;
        }
        // "HH:MM" -> minutos. Devuelve null si vacio o invalido.
        function parseFilterValue(v) {
            if (!v) return null;
            const m = v.match(/^(\d{1,2}):(\d{2})$/);
            if (!m) return null;
            const h = parseInt(m[1], 10);
            const min = parseInt(m[2], 10);
            if (h > 23 || min > 59) return null;
            return h * 60 + min;
        }
        function getFilterRange() {
            return {
                from: parseFilterValue(fromInp.value),
                to:   parseFilterValue(toInp.value),
            };
        }
        // Devuelve true si la hora esta DENTRO del filtro.
        // Si el filtro esta vacio, todas las horas estan dentro.
        function isInFilter(timeMin, range) {
            if (range.from === null && range.to === null) return true;
            if (range.from !== null && timeMin < range.from) return false;
            if (range.to   !== null && timeMin > range.to)   return false;
            return true;
        }

        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('bcn8-min');
            toggleBtn.textContent = panel.classList.contains('bcn8-min') ? '+' : '−';
        });
        let drag = null;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            drag = { x: e.clientX - r.left, y: e.clientY - r.top };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!drag) return;
            panel.style.left = (e.clientX - drag.x) + 'px';
            panel.style.top  = (e.clientY - drag.y) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => drag = null);

        function loadStem() {
            try { const raw = GM_getValue('destToSLs', null); return raw ? JSON.parse(raw) : null; }
            catch (e) { return null; }
        }
        function loadYard() {
            try { const raw = GM_getValue('freePS', null); return raw ? JSON.parse(raw) : null; }
            catch (e) { return null; }
        }
        function ageText(u) {
            const m = Math.round((Date.now() - u) / 60000);
            return m < 1 ? 'ahora' : (m + ' min');
        }
        function ageCls(u) {
            const m = Math.round((Date.now() - u) / 60000);
            return m > 30 ? 'stale' : 'ok';
        }

        function updateMeta() {
            const stem = loadStem();
            const yard = loadYard();
            const lines = [];
            if (stem) lines.push(`<span class="${ageCls(stem.updatedAt)}">Cargas: ${Object.keys(stem.data).length} destinos · hace ${ageText(stem.updatedAt)}</span>`);
            else lines.push(`<span class="err">⚠ Sin datos de cargas (abre stem-eu).</span>`);
            if (yard) lines.push(`<span class="${ageCls(yard.updatedAt)}">Parkings: ${yard.total} libres · hace ${ageText(yard.updatedAt)}</span>`);
            else lines.push(`<span class="err">⚠ Sin datos de parkings (abre la pagina Yard).</span>`);
            metaEl.innerHTML = lines.join('');
            runBtn.disabled = !stem && !yard;
            return { stem, yard };
        }
        reloadBtn.addEventListener('click', updateMeta);

        function laneCandidates(lane) {
            const out = [];
            const add = (s) => {
                if (!s) return;
                const clean = s.trim();
                if (clean && !out.includes(clean)) out.push(clean);
            };
            const raw = (lane || '').trim();
            add(raw);

            // Partes separadas por '->'
            const arrowParts = raw.split('->').map(s => s.trim()).filter(Boolean);
            if (arrowParts.length >= 2) {
                add(arrowParts.slice(1).join('->'));        // todo despues del primer ->
                add(arrowParts[arrowParts.length - 1]);     // ultimo tramo
                add(arrowParts[0]);                          // primer tramo
                // Intermedios
                for (let i = 1; i < arrowParts.length - 1; i++) add(arrowParts[i]);
            }

            // Si el ultimo tramo tiene guiones, generar candidatos progresivos
            // Ej: "SEA-AMZL-DQM5-ND" -> "AMZL-DQM5-ND", "DQM5-ND", "ND"
            //     y tambien  "SEA-AMZL-DQM5", "SEA-AMZL", "SEA"
            //     y los tokens individuales: "SEA", "AMZL", "DQM5", "ND"
            const lastPart = arrowParts[arrowParts.length - 1] || raw;
            if (lastPart.includes('-')) {
                const tokens = lastPart.split('-').filter(Boolean);
                // Progresivos por la izquierda (sin primero, sin dos primeros, etc.)
                for (let i = 1; i < tokens.length; i++) {
                    add(tokens.slice(i).join('-'));
                }
                // Progresivos por la derecha (sin ultimo, etc.)
                for (let i = tokens.length - 1; i >= 1; i--) {
                    add(tokens.slice(0, i).join('-'));
                }
                // Tokens individuales
                for (const t of tokens) add(t);
            }
            return out;
        }
        function findMatchInStem(lane, destToSLs) {
            const cands = laneCandidates(lane);
            // 1) Match exacto
            for (const c of cands) if (destToSLs[c]) return { key: c, sls: destToSLs[c] };
            // 2) Match case-insensitive exacto
            const lower = {};
            for (const k of Object.keys(destToSLs)) lower[k.toLowerCase()] = k;
            for (const c of cands) {
                const realKey = lower[c.toLowerCase()];
                if (realKey) return { key: realKey, sls: destToSLs[realKey] };
            }
            // 3) Match por contencion (la clave de stem contiene el candidato o viceversa).
            //    Solo aceptamos candidatos "utiles" (mas de 2 caracteres y con al menos un guion
            //    o tres caracteres) para evitar falsos positivos con tokens cortos como "BCN8".
            const keys = Object.keys(destToSLs);
            for (const c of cands) {
                if (c.length < 3) continue;
                const cl = c.toLowerCase();
                // preferir candidatos con guion (mas especificos)
                for (const k of keys) {
                    const kl = k.toLowerCase();
                    if (kl === cl) return { key: k, sls: destToSLs[k] };
                    // la clave de stem esta dentro del lane
                    if (cl.includes(kl) && kl.length >= 4) return { key: k, sls: destToSLs[k] };
                    // el lane-candidato esta dentro de la clave
                    if (kl.includes(cl) && cl.length >= 4) return { key: k, sls: destToSLs[k] };
                }
            }
            return null;
        }
        function computeDocks(lane, destToSLs) {
            const match = findMatchInStem(lane, destToSLs);
            if (!match) return { found: false, sls: [], docks: [] };
            const sls = match.sls;
            const docks = [];
            const seen = new Set();
            for (let level = 0; level < 3 && docks.length < 3; level++) {
                for (const sl of sls) {
                    if (docks.length >= 3) break;
                    const slDocks = SL_TO_DOCKS[sl.toUpperCase()];
                    if (!slDocks) continue;
                    const d = slDocks[level];
                    if (d && !seen.has(d)) { seen.add(d); docks.push(d); }
                }
            }
            return { found: true, sls, docks, matchedKey: match.key };
        }

        function findTableContext() {
            const laneH = findHeaderByText('Lane');
            const planH = findHeaderByText('Planned location');
            const accH  = findHeaderByText('Account');
            const timeH = findHeaderByText('Time');
            if (!laneH || !planH) return { error: 'No encuentro las columnas "Lane" y "Planned location".' };
            const laneRow = findRowAncestor(laneH);
            const planRow = findRowAncestor(planH);
            if (!laneRow || laneRow !== planRow) return { error: 'No consigo localizar la fila de cabecera.' };
            const cells = getRowCells(laneRow);
            const laneIdx = cells.findIndex(c => c.contains(laneH));
            const planIdx = cells.findIndex(c => c.contains(planH));
            const accIdx  = accH && laneRow.contains(accH) ? cells.findIndex(c => c.contains(accH)) : -1;
            const timeIdx = timeH && laneRow.contains(timeH) ? cells.findIndex(c => c.contains(timeH)) : -1;
            if (laneIdx < 0 || planIdx < 0) return { error: 'No puedo determinar indices de columna.' };
            const scope = findAncestor(laneRow, n =>
                (n.getAttribute && ['table','grid'].includes(n.getAttribute('role'))) || n.tagName === 'TABLE'
            ) || laneRow.parentElement?.parentElement || document.body;
            return { scope, laneIdx, accIdx, timeIdx, planIdx, headerRow: laneRow };
        }

        function getDataRows(ctx) {
            const allRows = ctx.scope.querySelectorAll('[role="row"], tr');
            const data = [];
            for (const row of allRows) {
                if (row === ctx.headerRow) continue;
                const cells = getRowCells(row);
                if (cells.length <= Math.max(ctx.laneIdx, ctx.planIdx)) continue;
                if ((cells[ctx.laneIdx]?.textContent || '').trim() === 'Lane') continue;
                data.push({ row, cells });
            }
            return data;
        }

        function extractVRID(row) {
            const text = row.textContent || '';
            const m = text.match(/VRID\s+([A-Z0-9]+)/i);
            return m ? m[1] : null;
        }

        // ====== PAGINACION (v2: sin flechas, salto directo por numero) ======
        function isVisible(el) {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const cs = window.getComputedStyle(el);
            return cs.visibility !== 'hidden' && cs.display !== 'none';
        }

        function isClickableElement(el) {
            const tag = el.tagName;
            if (tag === 'BUTTON' || tag === 'A') return true;
            const role = el.getAttribute('role');
            if (role === 'button' || role === 'link') return true;
            if (el.hasAttribute('ng-click') || el.hasAttribute('ui-sref')) return true;
            if (tag === 'LI' || tag === 'SPAN' || tag === 'DIV') {
                const cs = window.getComputedStyle(el);
                if (cs.cursor === 'pointer') return true;
            }
            return false;
        }

        // Devuelve elementos cuyo texto es solo un numero (1-3 digitos) y son clickables.
        function findAllPageElements() {
            const raw = [];
            const candidates = document.querySelectorAll('button, a, li, span, div, [role="button"], [role="link"]');
            for (const el of candidates) {
                const txt = (el.textContent || '').trim();
                const m = txt.match(/^(\d{1,3})$/);
                if (!m) continue;
                if (!isVisible(el)) continue;
                if (!isClickableElement(el)) continue;
                // Excluir si contiene otro clickable con el mismo numero (evitar anidados)
                const inner = el.querySelector('button, a, [role="button"], [role="link"]');
                if (inner && (inner.textContent || '').trim() === txt) continue;
                raw.push({ el, page: parseInt(m[1], 10) });
            }
            raw.sort((a, b) => a.page - b.page);
            // Dedup por numero: quedarse con el primero visible (usualmente el real)
            const byPage = new Map();
            for (const item of raw) {
                if (!byPage.has(item.page)) byPage.set(item.page, item);
            }
            return [...byPage.values()];
        }

        function isElActive(el) {
            if (!el) return false;
            if (el.getAttribute('aria-current')) return true;
            const cls = (el.className || '') + '';
            if (/\b(active|selected|current)\b/i.test(cls)) return true;
            const li = el.closest('li');
            if (li) {
                const lcls = (li.className || '') + '';
                if (/\b(active|selected|current)\b/i.test(lcls)) return true;
            }
            const p = el.parentElement;
            if (p) {
                const pcls = (p.className || '') + '';
                if (/\b(active|selected|current)\b/i.test(pcls)) return true;
            }
            return false;
        }

        function getActivePage() {
            const all = findAllPageElements();
            for (const { el, page } of all) {
                if (isElActive(el)) return page;
            }
            return null;
        }

        function getTotalPages() {
            const all = findAllPageElements();
            if (all.length === 0) return null;
            // Solo aceptamos una secuencia contigua desde 1
            const pages = [...new Set(all.map(b => b.page))].sort((a,b) => a-b);
            if (pages[0] !== 1) return null;
            let last = 0;
            for (const p of pages) {
                if (p !== last + 1) break;
                last = p;
            }
            return last || null;
        }

        function findPageButton(n) {
            const all = findAllPageElements();
            const m = all.find(b => b.page === n);
            return m ? m.el : null;
        }

        function getFirstRowFingerprint() {
            const ctx = findTableContext();
            if (ctx.error) return null;
            const rows = getDataRows(ctx);
            if (rows.length === 0) return '0||';
            const first = (rows[0].row.textContent || '').slice(0, 200);
            const last  = (rows[rows.length - 1].row.textContent || '').slice(0, 200);
            return `${rows.length}|${first}|${last}`;
        }

        async function waitForPageChange(prevPage, prevFp, timeoutMs = 12000) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                await sleep(200);
                const curPage = getActivePage();
                const curFp = getFirstRowFingerprint();
                const pageChanged = (prevPage !== null && curPage !== null && curPage !== prevPage);
                const fpChanged   = (prevFp !== null && curFp !== null && curFp !== prevFp);
                if (pageChanged && fpChanged) return true;
                if (pageChanged || fpChanged) {
                    // Esperar a que estabilicen los dos criterios (hasta 1.5s mas)
                    await sleep(500);
                    return true;
                }
            }
            return false;
        }

        // Click robusto: dispara mousedown/mouseup/click nativos ademas de .click()
        function robustClick(el) {
            try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
            const opts = { bubbles: true, cancelable: true, view: window };
            try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch(e) {}
            try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch(e) {}
            try { el.click(); } catch(e) {}
            try { el.dispatchEvent(new MouseEvent('click', opts)); } catch(e) {}
        }

        async function goToPage(n) {
            const current = getActivePage();
            if (current === n) return true;
            const btn = findPageButton(n);
            if (!btn) return false;
            const prevPage = current;
            const prevFp = getFirstRowFingerprint();
            robustClick(btn);
            return await waitForPageChange(prevPage, prevFp);
        }

        // Buscar el boton ">" (siguiente) como respaldo cuando el numero destino
        // todavia no aparece en la barra (tipicamente SESAME muestra "1 2 3 4 5 >"
        // y hay que avanzar varias veces para ver las paginas 6-11).
        function findNextArrowButton() {
            // 1) aria-label explicito (ingles/espanol)
            for (const el of document.querySelectorAll('[aria-label]')) {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                if (/\b(next|siguiente|next page|pagina siguiente)\b/.test(label)
                    && !/prev|previous|anterior|first|last|primera|ultima/.test(label)) {
                    if (isVisible(el) && isClickableElement(el)) return el;
                }
            }
            // 2) Por simbolo: >, ›, »
            const candidates = document.querySelectorAll('button, a, li, span, div, [role="button"]');
            const symbols = ['>', '›', '»', '❯', '→'];
            for (const el of candidates) {
                const txt = (el.textContent || '').trim();
                if (!symbols.includes(txt)) continue;
                if (!isVisible(el)) continue;
                if (!isClickableElement(el)) continue;
                // Evitar el "<" anterior que a veces esta cerca
                // Evitar flecha ">>" (ultimo) si tiene class o aria que lo indique
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                if (/last|ultima|ultimo/.test(label)) continue;
                // Evitar si contiene otro clickable dentro con el mismo simbolo
                const inner = el.querySelector('button, a, [role="button"]');
                if (inner && symbols.includes((inner.textContent || '').trim())) continue;
                return el;
            }
            return null;
        }

        function isElDisabled(el) {
            if (!el) return true;
            if (el.disabled) return true;
            if (el.getAttribute('aria-disabled') === 'true') return true;
            const cls = (el.className || '') + '';
            if (/\bdisabled\b/i.test(cls)) return true;
            const li = el.closest('li');
            if (li && /\bdisabled\b/i.test((li.className || '') + '')) return true;
            const p = el.parentElement;
            if (p && /\bdisabled\b/i.test((p.className || '') + '')) return true;
            return false;
        }

        async function goToNextPageByArrow() {
            const btn = findNextArrowButton();
            if (!btn || isElDisabled(btn)) return false;
            const prevPage = getActivePage();
            const prevFp = getFirstRowFingerprint();
            robustClick(btn);
            const moved = await waitForPageChange(prevPage, prevFp);
            if (!moved) return false;
            // Verificar que efectivamente hemos avanzado
            const newPage = getActivePage();
            if (prevPage !== null && newPage !== null && newPage <= prevPage) return false;
            return true;
        }

        // Intenta ir a N con 2 estrategias: por numero o, si no existe, con la flecha ">"
        async function advanceToPage(targetPage) {
            // Estrategia 1: clic directo en el numero
            const btn = findPageButton(targetPage);
            if (btn) return await goToPage(targetPage);
            // Estrategia 2: flecha ">" repetida hasta llegar
            const current = getActivePage();
            if (current === null) return false;
            let tries = 0;
            while (getActivePage() !== targetPage && tries < (targetPage - current + 3)) {
                const ok = await goToNextPageByArrow();
                if (!ok) return false;
                await sleep(400);
                // Si ahora si aparece el numero, ir directo
                const b2 = findPageButton(targetPage);
                if (b2 && getActivePage() !== targetPage) {
                    await goToPage(targetPage);
                    break;
                }
                tries++;
            }
            return getActivePage() === targetPage;
        }

        // ====== Dropdowns ======
        function normalize(s) { return (s || '').replace(/\s+/g, '').toUpperCase(); }
        function matchesOption(optText, optDataValue, value) {
            const nTxt = normalize(optText);
            const nDv  = normalize(optDataValue);
            const nVal = normalize(value);
            if (!nVal) return false;
            if (nTxt === nVal || nDv === nVal) return true;
            const tokens = nTxt.split(/[^A-Z0-9-]+/).filter(Boolean);
            if (tokens.includes(nVal)) return true;
            if (nTxt.endsWith(nVal) || nTxt.startsWith(nVal)) return true;
            return false;
        }
        function setNativeSelect(select, value) {
            const target = Array.from(select.options).find(o =>
                matchesOption(o.textContent || '', o.value || '', value));
            if (!target) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(select, target.value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input',  { bubbles: true }));
            return true;
        }
        async function setReactDropdown(triggerEl, value) {
            const clickable = triggerEl.matches('button, [role="button"], [role="combobox"], input')
                ? triggerEl
                : (triggerEl.querySelector('button, [role="button"], [role="combobox"], input') || triggerEl);
            clickable.focus?.();
            clickable.click();
            await sleep(250);
            for (let attempt = 0; attempt < 4; attempt++) {
                const options = document.querySelectorAll(
                    '[role="option"], [role="menuitem"], li[role="option"], li.dropdown-item, [data-value]'
                );
                for (const opt of options) {
                    if (!isVisible(opt)) continue;
                    const txt = (opt.textContent || '').trim();
                    const dv  = (opt.getAttribute && opt.getAttribute('data-value') || '').trim();
                    if (matchesOption(txt, dv, value)) {
                        opt.click();
                        await sleep(150);
                        return true;
                    }
                }
                await sleep(180);
            }
            document.body.click();
            await sleep(100);
            return false;
        }
        async function setDropdown(el, value) {
            if (el.tagName === 'SELECT') return setNativeSelect(el, value);
            const nativeSel = el.querySelector && el.querySelector('select');
            if (nativeSel) return setNativeSelect(nativeSel, value);
            return await setReactDropdown(el, value);
        }
        function findDropdownsIn(cell) {
            const candidates = cell.querySelectorAll(
                'select, [role="combobox"], [role="button"][aria-haspopup], button[aria-haspopup], .dropdown-toggle'
            );
            const list = [];
            for (const c of candidates) {
                if (list.some(x => x.contains(c) || c.contains(x))) continue;
                list.push(c);
            }
            return list.slice(0, 3);
        }

        function flashRow(row) {
            row.classList.add('bcn8-flash');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => row.classList.remove('bcn8-flash'), 3500);
        }

        async function gotoEntry(item) {
            // Si la fila sigue en DOM y en la pagina actual, basta con resaltar
            if (item.row && document.body.contains(item.row)) {
                flashRow(item.row);
                return;
            }
            // Navegar a la pagina del item
            if (item.page) {
                progEl.style.display = 'block';
                progEl.textContent = `Navegando a pagina ${item.page}...`;
                await goToPage(item.page);
                await sleep(500);
                progEl.style.display = 'none';
                // Buscar la fila por VRID
                if (item.vrid) {
                    const ctx = findTableContext();
                    if (!ctx.error) {
                        const rows = getDataRows(ctx);
                        for (const { row } of rows) {
                            if ((row.textContent || '').includes(item.vrid)) {
                                flashRow(row);
                                return;
                            }
                        }
                    }
                }
            }
        }

        // ====== ESTADO PERSISTENTE (stop/resume) ======
        // Guardamos en window para persistir durante la sesion del tab.
        // Si el tab se refresca se pierde (lo cual es aceptable).
        const state = window.__bcn8ArrState = window.__bcn8ArrState || {
            running: false,
            stopRequested: false,
            assigned: [],
            assignedPS: [],
            partials: [],
            unmatched: [],
            skipped: [],
            psPool: null,
            psPtr: 0,
            psRecycled: 0,
            processedPages: [],
        };

        function resetState() {
            state.assigned = [];
            state.assignedPS = [];
            state.partials = [];
            state.unmatched = [];
            state.skipped = [];
            state.psPool = null;
            state.psPtr = 0;
            state.psRecycled = 0;
            state.processedPages = [];
        }

        function hasProgress() {
            return state.assigned.length + state.assignedPS.length
                 + state.partials.length + state.unmatched.length
                 + state.skipped.length > 0
                 || state.processedPages.length > 0;
        }

        function updateActionButtons() {
            if (state.running) {
                runBtn.style.display = 'none';
                resumeBtn.style.display = 'none';
                stopBtn.style.display = 'block';
                return;
            }
            stopBtn.style.display = 'none';
            if (hasProgress()) {
                runBtn.textContent = 'Empezar de nuevo';
                runBtn.style.display = 'block';
                resumeBtn.style.display = 'block';
                const lastPage = state.processedPages.length > 0
                    ? Math.max(...state.processedPages) + 1
                    : 1;
                resumeBtn.textContent = `▶ Reanudar (desde pag. ${lastPage})`;
            } else {
                runBtn.textContent = 'Asignar muelles a camiones';
                runBtn.style.display = 'block';
                resumeBtn.style.display = 'none';
            }
        }

        // ====== RUN principal ======
        // mode: 'start' = empieza de cero (limpia estado); 'resume' = continua
        async function run(mode = 'start') {
            if (state.running) return;
            state.running = true;
            state.stopRequested = false;

            // Anti-throttle: mantener la pestana activa aunque este en segundo plano
            window.__bcn8AntiThrottle?.start();

            if (mode === 'start') {
                resetState();
            }

            updateActionButtons();
            const { stem, yard } = updateMeta();
            runBtn.classList.add('loading');
            progEl.style.display = 'block';

            // Inicializar pool de parkings la primera vez
            if (state.psPool === null) {
                state.psPool = (yard?.list || []).slice();
                state.psPtr = 0;
            }

            // Determinar desde que pagina empezar
            const processedSet = new Set(state.processedPages);
            let startPage;
            if (mode === 'resume' && state.processedPages.length > 0) {
                startPage = Math.max(...state.processedPages) + 1;
            } else {
                startPage = 1;
            }

            // Ir a la pagina de inicio si no estamos ya ahi
            const currentlyAt = getActivePage();
            if (currentlyAt !== null && currentlyAt !== startPage) {
                progEl.textContent = `Yendo a pagina ${startPage}...`;
                bodyEl.innerHTML = `<div class="bcn8-a-empty">Yendo a pagina ${startPage}...</div>`;
                const ok = await advanceToPage(startPage);
                if (!ok) {
                    // Intento con clic directo por si acaso
                    const btn = findPageButton(startPage);
                    if (btn) await goToPage(startPage);
                }
                await sleep(700);
            }

            let currentPage = getActivePage() || startPage;
            let iterations = 0;
            const MAX_ITERATIONS = 80;

            // Filtro de horas (calculado una vez al inicio de run)
            const filterRange = getFilterRange();
            const filterActive = filterRange.from !== null || filterRange.to !== null;

            mainLoop: while (iterations < MAX_ITERATIONS) {
                iterations++;

                if (state.stopRequested) break mainLoop;

                // Si ya procesamos esta pagina (resume), intentar avanzar
                if (processedSet.has(currentPage)) {
                    const next = currentPage + 1;
                    const advanced = await advanceToPage(next);
                    if (!advanced) break mainLoop;
                    await sleep(700);
                    currentPage = getActivePage() || next;
                    continue;
                }

                const ctx = findTableContext();
                if (ctx.error) {
                    state.unmatched.push({ dest: `Error en pagina ${currentPage}`, account: '', row: null, vrid: null, reason: ctx.error, page: currentPage });
                    break;
                }
                const rows = getDataRows(ctx);
                const totStr = (() => {
                    const t = getTotalPages();
                    return t ? `/ ${t}+` : '';
                })();
                bodyEl.innerHTML = `<div class="bcn8-a-empty">Procesando pagina ${currentPage} ${totStr} · ${rows.length} filas...</div>`;
                progEl.textContent = `Pagina ${currentPage} ${totStr} · ${rows.length} filas`;

                // Deteccion de orden ascendente: leer todas las horas de la pagina
                // y comprobar si forman secuencia no-decreciente. Si si, podemos usarlo
                // para terminar el bucle pronto cuando todas las filas excedan filterRange.to.
                let pageTimes = [];
                if (ctx.timeIdx >= 0) {
                    for (const { cells } of rows) {
                        const tcell = cells[ctx.timeIdx];
                        const tmin = tcell ? parseTimeToMinutes(tcell.textContent || '') : null;
                        pageTimes.push(tmin);
                    }
                }
                const validTimes = pageTimes.filter(x => x !== null);
                let pageIsAscending = false;
                if (validTimes.length >= 2) {
                    pageIsAscending = true;
                    for (let i = 1; i < validTimes.length; i++) {
                        if (validTimes[i] < validTimes[i - 1]) { pageIsAscending = false; break; }
                    }
                }
                // Si filtro activo y la pagina entera esta por encima de "to", podemos parar
                if (filterActive && filterRange.to !== null && pageIsAscending && validTimes.length > 0) {
                    const minOnPage = validTimes[0];
                    if (minOnPage > filterRange.to) {
                        // Todos los camiones de esta pagina estan despues del rango -> terminar
                        progEl.textContent = `Pagina ${currentPage}: toda fuera de rango · termino aqui`;
                        // Marcamos esta pagina como procesada para no volver
                        state.processedPages.push(currentPage);
                        processedSet.add(currentPage);
                        break;
                    }
                }

                for (let idx = 0; idx < rows.length; idx++) {
                    if (state.stopRequested) break mainLoop;

                    const { row, cells } = rows[idx];
                    const lane = (cells[ctx.laneIdx]?.textContent || '').trim();
                    const account = ctx.accIdx >= 0 && cells[ctx.accIdx]
                        ? (cells[ctx.accIdx].textContent || '').trim()
                        : '';
                    if (!lane) continue;

                    const vrid = extractVRID(row);

                    // Filtro de horas
                    let timeMin = null;
                    let timeStr = '';
                    if (ctx.timeIdx >= 0 && cells[ctx.timeIdx]) {
                        timeStr = (cells[ctx.timeIdx].textContent || '').trim().split(/[\n\r]+/)[0].trim();
                        timeMin = parseTimeToMinutes(timeStr);
                    }
                    if (filterActive) {
                        if (timeMin === null) {
                            // Hora no parseable: lo ponemos en skipped con esa razon
                            state.skipped.push({ dest: lane, account, row, vrid, reason: 'Hora no parseable', page: currentPage, time: timeStr });
                            continue;
                        }
                        if (!isInFilter(timeMin, filterRange)) {
                            state.skipped.push({ dest: lane, account, row, vrid, reason: 'Fuera del rango', page: currentPage, time: timeStr });
                            continue;
                        }
                    }

                    const planCell = cells[ctx.planIdx];
                    const dropdowns = findDropdownsIn(planCell);
                    if (dropdowns.length === 0) {
                        state.unmatched.push({ dest: lane, account, row, vrid, reason: 'Sin desplegables', page: currentPage, time: timeStr });
                        continue;
                    }

                    // ===== ORDEN DE PRIORIDAD =====
                    //  1) FIXED_ACCOUNT_DOCKS (accounts con muelles fijos, ej. ATSReturns)
                    //  2) SPECIAL_ACCOUNTS (siempre van a PS vacio, incluso si hay match en STEM)
                    //  3) Match en STEM (Lane -> destino -> SLs -> DDs)
                    //  4) Destino no encontrado -> unmatched

                    // ----- 1) Accounts con muelles fijos -----
                    const fixed = matchAccountInDocks(account, FIXED_ACCOUNT_DOCKS);
                    if (fixed && fixed.length > 0) {
                        const toSet = fixed.slice(0, dropdowns.length);
                        let okCount = 0;
                        for (let i = 0; i < toSet.length; i++) {
                            const ok = await setDropdown(dropdowns[i], toSet[i]);
                            if (ok) okCount++;
                            await sleep(120);
                        }
                        const entry = { dest: lane, account, row, vrid, values: toSet, okCount, source: 'DD', page: currentPage };
                        if (okCount === 0) state.unmatched.push({ dest: lane, account, row, vrid, reason: `Sin match en desplegable (${account})`, page: currentPage });
                        else if (okCount < toSet.length) state.partials.push(entry);
                        else state.assigned.push(entry);
                        continue;
                    }

                    // ----- 2) Accounts que SIEMPRE van a PS vacio (prioridad sobre STEM) -----
                    if (matchAccountInSet(account, SPECIAL_ACCOUNTS)) {
                        if (!yard || state.psPool.length === 0) {
                            state.unmatched.push({ dest: lane, account, row, vrid, reason: 'Sin datos de parkings libres', page: currentPage });
                            continue;
                        }
                        const needed = dropdowns.length;
                        const picks = [];
                        const picksFromRecycle = [];
                        while (picks.length < needed) {
                            if (state.psPtr >= state.psPool.length) {
                                state.psPtr = 0;
                                state.psRecycled = (state.psRecycled || 0) + 1;
                            }
                            picks.push(state.psPool[state.psPtr]);
                            picksFromRecycle.push(state.psRecycled > 0);
                            state.psPtr++;
                        }
                        let okCount = 0;
                        for (let i = 0; i < picks.length; i++) {
                            const ok = await setDropdown(dropdowns[i], picks[i]);
                            if (ok) okCount++;
                            await sleep(120);
                        }
                        const recycled = picksFromRecycle.some(Boolean);
                        const entry = { dest: lane, account, row, vrid, values: picks, okCount, source: 'PS', page: currentPage, recycled };
                        if (okCount === 0) {
                            state.psPtr -= picks.length;
                            if (state.psPtr < 0) state.psPtr = 0;
                            state.unmatched.push({ dest: lane, account, row, vrid, reason: 'Sin match en desplegable (PS)', page: currentPage });
                        } else if (okCount < picks.length) state.partials.push(entry);
                        else state.assignedPS.push(entry);
                        continue;
                    }

                    // ----- 3) Match en STEM por Lane -----
                    const res = stem ? computeDocks(lane, stem.data) : { found: false, docks: [] };
                    if (res.found && res.docks.length > 0) {
                        let okCount = 0;
                        const toSet = res.docks.slice(0, dropdowns.length);
                        for (let i = 0; i < toSet.length; i++) {
                            const ok = await setDropdown(dropdowns[i], toSet[i]);
                            if (ok) okCount++;
                            await sleep(120);
                        }
                        const entry = { dest: lane, account, row, vrid, values: toSet, okCount, source: 'DD', page: currentPage };
                        if (okCount === 0) state.unmatched.push({ dest: lane, account, row, vrid, reason: 'Sin match en desplegable (DD)', page: currentPage });
                        else if (okCount < toSet.length) state.partials.push(entry);
                        else state.assigned.push(entry);
                        continue;
                    }

                    // ----- 4) Ni Account especial ni match en STEM -----
                    state.unmatched.push({
                        dest: lane, account, row, vrid,
                        reason: account ? 'Destino no encontrado' : 'Destino no encontrado (sin Account)',
                        page: currentPage
                    });
                }

                // Marcar pagina como procesada
                state.processedPages.push(currentPage);
                processedSet.add(currentPage);

                if (state.stopRequested) break mainLoop;

                // Ir a la siguiente: N -> N+1, usando salto por numero o flecha >
                const nextPage = currentPage + 1;
                progEl.textContent = `Cambiando a pagina ${nextPage}...`;
                const advanced = await advanceToPage(nextPage);
                if (!advanced) {
                    // No hay mas paginas disponibles
                    break;
                }
                await sleep(800);
                currentPage = getActivePage() || nextPage;
            }

            state.running = false;
            runBtn.classList.remove('loading');
            progEl.style.display = 'none';
            updateActionButtons();

            // Anti-throttle: ya no lo necesitamos
            window.__bcn8AntiThrottle?.stop();

            renderResults();
        }

        function renderResults() {
            const { assigned, assignedPS, partials, unmatched, skipped } = state;

            const renderItem = (item, kind, i) => {
                let badgeSrc = '';
                if (item.source === 'DD') badgeSrc = `<span class="bcn8-a-badge dd">DD</span>`;
                else if (item.source === 'PS') badgeSrc = `<span class="bcn8-a-badge ps">PS${item.recycled ? ' ♻' : ''}</span>`;
                else if (kind === 'sk') badgeSrc = `<span class="bcn8-a-badge skip">⏭</span>`;
                const badgePg = item.page ? `<span class="bcn8-a-badge pg">P${item.page}</span>` : '';
                const badgeHr = item.time ? `<span class="bcn8-a-badge hr">${escapeHtml(item.time)}</span>` : '';
                const subline = (() => {
                    if (kind === 'un') {
                        return `${item.account ? 'Account: ' + escapeHtml(item.account) + ' · ' : ''}${item.reason ? escapeHtml(item.reason) : ''}`;
                    }
                    if (kind === 'pa') {
                        return `${item.okCount}/${item.values.length} · ${item.values.map(escapeHtml).join(', ')}`;
                    }
                    if (kind === 'ps') {
                        return `${escapeHtml(item.account)} · ${item.values.map(escapeHtml).join(', ')}`;
                    }
                    if (kind === 'sk') {
                        return `${item.account ? 'Account: ' + escapeHtml(item.account) + ' · ' : ''}${escapeHtml(item.reason || '')}`;
                    }
                    return item.values.map(escapeHtml).join(', ');
                })();
                const cls = kind === 'un' ? 'unmatched'
                          : kind === 'sk' ? 'skipped'
                          : kind === 'ps' ? 'ok-ps'
                          : kind === 'ok' ? 'ok' : '';
                return `
                    <div class="bcn8-a-item ${cls}">
                        <div>
                            <div class="bcn8-a-item-name">${badgePg}${badgeHr}${badgeSrc}${escapeHtml(item.dest)}</div>
                            <div class="bcn8-a-item-docks">${subline}</div>
                        </div>
                        <button class="bcn8-a-goto" data-kind="${kind}" data-idx="${i}">Ir</button>
                    </div>`;
            };

            const parts = [];
            if (state.processedPages.length > 0) {
                const pgs = [...state.processedPages].sort((a,b) => a-b).join(', ');
                parts.push(`<div class="bcn8-a-section" style="font-size:11px;color:#555;">Paginas procesadas: ${pgs}</div>`);
            }
            if (unmatched.length > 0) {
                parts.push(`<div class="bcn8-a-section"><div class="bcn8-a-section-title">⚠ No encontrados (${unmatched.length})</div>${unmatched.map((u,i) => renderItem(u,'un',i)).join('')}</div>`);
            }
            if (partials.length > 0) {
                parts.push(`<div class="bcn8-a-section"><div class="bcn8-a-section-title">Parciales (${partials.length})</div>${partials.map((p,i) => renderItem(p,'pa',i)).join('')}</div>`);
            }
            if (assignedPS.length > 0) {
                parts.push(`<div class="bcn8-a-section"><div class="bcn8-a-section-title">✓ Parking asignado (${assignedPS.length})</div>${assignedPS.map((a,i) => renderItem(a,'ps',i)).join('')}</div>`);
            }
            parts.push(`<div class="bcn8-a-section"><div class="bcn8-a-section-title">✓ Muelle asignado (${assigned.length})</div>${assigned.length === 0 ? `<div class="bcn8-a-empty">-</div>` : assigned.map((a,i) => renderItem(a,'ok',i)).join('')}</div>`);
            if (skipped.length > 0) {
                parts.push(`<div class="bcn8-a-section"><div class="bcn8-a-section-title">⏭ Fuera de horario (${skipped.length})</div>${skipped.map((s,i) => renderItem(s,'sk',i)).join('')}</div>`);
            }

            bodyEl.innerHTML = parts.join('');

            bodyEl.querySelectorAll('.bcn8-a-goto').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const kind = btn.getAttribute('data-kind');
                    const i = parseInt(btn.getAttribute('data-idx'), 10);
                    const src = kind === 'un' ? state.unmatched
                              : kind === 'pa' ? state.partials
                              : kind === 'ps' ? state.assignedPS
                              : kind === 'sk' ? state.skipped
                              : state.assigned;
                    const item = src[i];
                    if (item) await gotoEntry(item);
                });
            });
        }

        runBtn.addEventListener('click', () => run('start'));
        resumeBtn.addEventListener('click', () => run('resume'));
        stopBtn.addEventListener('click', () => {
            state.stopRequested = true;
            progEl.textContent = 'Deteniendo...';
            stopBtn.disabled = true;
            setTimeout(() => { stopBtn.disabled = false; }, 1500);
        });
        setTimeout(() => { updateMeta(); updateActionButtons(); }, 500);
        setInterval(updateMeta, 30000);

        // Auto-asignacion: ejecuta run('start') cada N minutos.
        // Antes de ejecutar, valida que los datos de STEM y Yard sean recientes.
        // Si no lo son, salta el ciclo y reintenta en 5 minutos.
        const MAX_DATA_AGE_HOURS_DEFAULT = 2;
        function dataIsFreshEnough() {
            const stem = loadStem();
            const yard = loadYard();
            const issues = [];
            const ageHours = (ts) => ts ? (Date.now() - ts) / 3600000 : Infinity;
            if (!stem) issues.push('STEM sin datos');
            else if (ageHours(stem.updatedAt) > MAX_DATA_AGE_HOURS_DEFAULT) issues.push(`STEM (${ageHours(stem.updatedAt).toFixed(1)}h)`);
            if (!yard) issues.push('Yard sin datos');
            else if (ageHours(yard.updatedAt) > MAX_DATA_AGE_HOURS_DEFAULT) issues.push(`Yard (${ageHours(yard.updatedAt).toFixed(1)}h)`);
            return { ok: issues.length === 0, issues };
        }

        const arrAuto = attachAutoRefresh({
            container: panel,
            storageKey: 'bcn8-arr-auto',
            label: 'Auto-asignar Outbound',
            defaultMinutes: 180, // 3 horas por defecto
            minMinutes: 30,
            maxMinutes: 720,
            action: async () => {
                if (state.running) {
                    console.warn('[BCN8 Auto Arr] Otra ejecucion en curso, salto');
                    return;
                }
                const fresh = dataIsFreshEnough();
                if (!fresh.ok) {
                    console.warn('[BCN8 Auto Arr] Datos no frescos:', fresh.issues.join(', '), '· reintenta en 5 min');
                    // Programar reintento en 5 minutos
                    setTimeout(() => {
                        if (arrAuto.isEnabled() && !state.running) {
                            const f2 = dataIsFreshEnough();
                            if (f2.ok) {
                                console.log('[BCN8 Auto Arr] Reintento: datos OK, ejecutando');
                                arrAuto.triggerNow();
                            } else {
                                console.warn('[BCN8 Auto Arr] Reintento: aun no hay datos frescos');
                            }
                        }
                    }, 5 * 60000);
                    return;
                }
                console.log('[BCN8 Auto Arr] Datos OK, ejecutando run(start)');
                await run('start');
            },
            cssPrefix: 'bcn8',
            activateAntiThrottle: true,
        });
    }
})();
