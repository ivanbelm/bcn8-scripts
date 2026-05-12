// ==UserScript==
// @name         BCN8 Inbound Pre-asignación (Sesame + Socrates)
// @namespace    amazon-bcn8-inbound
// @version      1.8.1
// @description  Auto-refresh Yard/Socrates + auto-ejecucion Sesame Inbound con sincronizacion + filtro horas + todas las funciones anteriores.
// @match        https://trans-logistics-eu.amazon.com/yms/sesameGateConsole*
// @match        https://trans-logistics-eu.amazon.com/yms/shipclerk*
// @match        https://sclogistics.ats.amazon.dev/socrates/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const host = window.location.hostname;
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
                this.gain.gain.value = 0;
                this.oscillator.connect(this.gain);
                this.gain.connect(this.ctx.destination);
                this.oscillator.start();
                this.active = true;
                console.log('[BCN8 Inb] Anti-throttle activado');
            } catch (e) {
                console.warn('[BCN8 Inb] No se pudo activar anti-throttle:', e);
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
            console.log('[BCN8 Inb] Anti-throttle desactivado');
        }
    };
    window.__bcn8InbAntiThrottle = antiThrottle;

    // ============================================================
    //   AUTO-REFRESH GENERICO (reusable para Yard, Socrates, Sesame)
    //
    //   attachAutoRefresh({
    //     container,        // elemento donde insertar el bloque UI
    //     storageKey,       // clave GM para persistencia (un nombre unico)
    //     label,            // texto del checkbox
    //     defaultMinutes,   // intervalo por defecto en minutos
    //     minMinutes, maxMinutes,
    //     action,           // funcion async a ejecutar
    //     activateAntiThrottle: bool,  // mantener anti-throttle activo mientras dure
    //     antiThrottleHandle: () => antiThrottle  // helper opcional
    //   })
    // ============================================================
    function attachAutoRefresh(opts) {
        const {
            container, storageKey, label = 'Auto-refrescar',
            defaultMinutes = 30, minMinutes = 1, maxMinutes = 720,
            action, cssPrefix = 'bcn8i',
            activateAntiThrottle = false,
        } = opts;

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

        let cfg = { enabled: false, minutes: defaultMinutes };
        try {
            const raw = GM_getValue(storageKey, null);
            if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
        } catch (e) {}
        chk.checked = !!cfg.enabled;
        minInput.value = cfg.minutes;

        let nextRunAt = null;
        let intervalId = null;
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
                    statusEl.textContent = `Próximo: ${fmt(nextRunAt)} (en ${mins} min)`;
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
                    window.__bcn8InbAntiThrottle?.start();
                }
                await action();
            } catch (e) {
                console.error('[BCN8 Inb auto] error:', e);
            } finally {
                if (activateAntiThrottle) {
                    if (!chk.checked) {
                        window.__bcn8InbAntiThrottle?.stop();
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
            if (Date.now() >= nextRunAt && !isExecuting) {
                executeNow();
            }
        };

        const start = () => {
            if (intervalId) clearInterval(intervalId);
            intervalId = setInterval(tick, 15000);
            scheduleNext();
            if (activateAntiThrottle) {
                window.__bcn8InbAntiThrottle?.start();
            }
        };
        const stop = () => {
            if (intervalId) { clearInterval(intervalId); intervalId = null; }
            nextRunAt = null;
            updateStatus();
            if (activateAntiThrottle) {
                window.__bcn8InbAntiThrottle?.stop();
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

        if (chk.checked) start();
        else updateStatus();

        return { triggerNow: executeNow, scheduleNext, isEnabled: () => chk.checked };
    }
    window.__bcn8InbAttachAutoRefresh = attachAutoRefresh;

    // CSS comun
    if (!document.getElementById('bcn8i-auto-css')) {
        const s = document.createElement('style');
        s.id = 'bcn8i-auto-css';
        s.textContent = `
            .bcn8i-auto {
                padding: 8px 12px; background: #fafafa; border-bottom: 1px solid #eee;
                font-size: 11px;
            }
            .bcn8i-auto-label {
                display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
                color: #555; font-weight: 600; cursor: pointer;
            }
            .bcn8i-auto-chk { margin: 0; }
            .bcn8i-auto-min {
                width: 50px; padding: 2px 4px; border: 1px solid #d5d9d9;
                border-radius: 3px; font-size: 11px; font-family: inherit;
            }
            .bcn8i-auto-status { margin-top: 3px; font-size: 10px; }
            .bcn8i-auto-status.off { color: #888; }
            .bcn8i-auto-status.on { color: #1d5d9b; font-weight: 600; }
            .bcn8i-auto-status.running { color: #b26100; font-weight: 600; }
        `;
        document.head.appendChild(s);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, m => (
            { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]
        ));
    }

    // ==================== TABLA DE GRUPOS -> DDs ====================
    const GROUP_DOCKS = {
        '300a':   ['DD-309', 'DD-308', 'DD-307'],
        '300b':   ['DD-306', 'DD-305', 'DD-304'],
        '300c':   ['DD-303', 'DD-302', 'DD-301'],
        '200a':   ['DD-239', 'DD-238', 'DD-237'],
        '200b':   ['DD-236', 'DD-235', 'DD-234'],
        'fluidsA':['DD-233', 'DD-232', 'DD-231'],
        'fluidsB':['DD-229', 'DD-228', 'DD-227'],
        'fluidsC':['DD-227', 'DD-226', 'DD-225'],
        '100x':   ['DD-134', 'DD-135', 'DD-136'],
    };

    // ==================== FALLBACK POR ACCOUNT ====================
    // PS_FORCED_ACCOUNTS: siempre van a PS vacio, incluso si el VRID aparece en Socrates.
    //                    Prioridad MAXIMA, antes de ISA y de Socrates.
    const PS_FORCED_ACCOUNTS = new Set([
        'TrailerWash',
        'TrailerServices',
        'TransfersInitialPlacement',
        'FleetManagementEquipmentRepositioning',
        'BobtailMovementAnnotation',
    ]);

    // ACCOUNT_RULES: se aplica SOLO si el VRID no aparece en Socrates.
    // type:
    //   'docks' -> asignamos los DDs fijos en values
    //   'group' -> asignamos los DDs del grupo indicado en values
    //   'ps'    -> asignamos 3 PS libres del pool
    //   'mixed' -> asigna primero los DDs de 'values' y rellena los huecos restantes con PS libres
    const ACCOUNT_RULES = {
        'TransfersCarts':          { type: 'mixed', values: ['DD-221', 'DD-224'] }, // 2 DDs + 1 PS libre
        'ATSAMZLMissorts':         { type: 'group', values: '200b' },
        'TransferShipSuCrossDock': { type: 'docks', values: ['DD-240', 'DD-241', 'DD-242'] },
    };

    // ==================== LOGICA DE ASIGNACION ====================
    // volumen = { xss, m, l, xl, nc, ncp, xdock, fluid, total }
    function decideGroup(v) {
        const total = v.total || 0;
        const pct = (x) => total > 0 ? (x / total) : 0;

        const ncAll = (v.nc || 0) + (v.ncp || 0);
        const pctNc = pct(ncAll);

        // 1) NC gigante > 80%
        if (pctNc > 0.80) return { group: '100x', reason: 'NC+NC_Plus > 80%' };

        // 2) Fluid
        const fluid = v.fluid || 0;
        if (fluid > 0) {
            if (fluid < 200) return { group: 'fluidsA', reason: `Fluid bajo (${fluid})` };
            if (fluid <= 600) return { group: 'fluidsB', reason: `Fluid medio (${fluid})` };
            return { group: 'fluidsC', reason: `Fluid alto (${fluid})` };
        }

        const xdock = v.xdock || 0;
        const pctXsM = pct((v.xss || 0) + (v.m || 0));

        // 3) 300c: >10 xdock y mayoria XS+M (>65%)
        if (xdock > 10 && pctXsM > 0.65) {
            return { group: '300c', reason: `XD ${xdock} + XS+M ${(pctXsM*100).toFixed(0)}%` };
        }

        // 4) 200a/200b: paquete grande (M+L+XL+NC+NCP > 65%, NC no supera 80%, sin fluid)
        const pctBig = pct((v.m || 0) + (v.l || 0) + (v.xl || 0) + ncAll);
        if (pctBig > 0.65 && pctNc <= 0.80) {
            if (xdock > 8) return { group: '200a', reason: `Grande ${(pctBig*100).toFixed(0)}% + XD ${xdock}` };
            return { group: '200b', reason: `Grande ${(pctBig*100).toFixed(0)}%` };
        }

        // 5) 300a/300b: mayoria pequeno (XS+M > 60%)
        if (pctXsM > 0.60) {
            if (total >= 3000) return { group: '300a', reason: `Pequeno + alto volumen (${total})` };
            return { group: '300b', reason: `Pequeno (${total})` };
        }

        // 6) Fallback: mix equilibrado -> 200a
        return { group: '200a', reason: 'Mix equilibrado' };
    }

    // Normaliza un Account para comparar de forma robusta:
    //  - quita espacios al inicio/final, multiples espacios internos
    //  - case-insensitive
    //  - quita caracteres no alfanumericos (por si vienen separadores raros)
    function normalizeAccount(s) {
        if (!s) return '';
        return String(s)
            .replace(/[\u00A0\s]+/g, '')      // todos los espacios (incluido nbsp)
            .replace(/[^A-Za-z0-9]/g, '')     // todo lo no alfanumerico
            .toLowerCase();
    }

    // Devuelve la regla coincidente para un Account (busqueda case-insensitive y limpia)
    function matchAccountInSet(account, accountSet) {
        const normAcc = normalizeAccount(account);
        if (!normAcc) return false;
        for (const candidate of accountSet) {
            if (normalizeAccount(candidate) === normAcc) return true;
        }
        return false;
    }

    function matchAccountInRules(account, rulesObj) {
        const normAcc = normalizeAccount(account);
        if (!normAcc) return null;
        for (const key of Object.keys(rulesObj)) {
            if (normalizeAccount(key) === normAcc) return { key, rule: rulesObj[key] };
        }
        return null;
    }
    //  - un string textContent (fallback), o
    //  - un HTMLElement (preferido), del que extraemos cada nodo de texto por separado
    //    para no perder el espacio entre "Scheduled" y "VRID 112M37GHX".
    function extractTextLines(el) {
        if (!el) return [];
        // Recogemos textos de cada nodo-leaf visible (span, p, a, div, text nodes)
        // separados por salto de linea para que los tokens no se peguen.
        const parts = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = walker.nextNode())) {
            const t = (n.nodeValue || '').trim();
            if (t) parts.push(t);
        }
        return parts;
    }

    // Devuelve la referencia (codigo limpio) o '' si no se encuentra
    function normalizeRef(input) {
        if (!input) return '';
        // Si es un elemento, extraemos sus lineas de texto separadas
        let lines;
        if (typeof input === 'string') {
            lines = [input];
        } else if (input && input.nodeType === 1) {
            lines = extractTextLines(input);
            if (lines.length === 0) lines = [(input.textContent || '')];
        } else {
            return '';
        }
        // Unimos con espacio para no pegar tokens adyacentes
        let s = lines.join(' ').toUpperCase();
        // Quitar palabras de metainformacion
        s = s.replace(/\bSCHEDULED\b|\bARRIVED\b|\bCHECKED[\s-]*IN\b|\bVRID\b|\bISA\b/g, ' ');
        s = s.replace(/[^A-Z0-9\s]/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        // Coger el primer token alfanumerico de al menos 5 caracteres
        const tokens = s.split(/\s+/).filter(Boolean);
        for (const t of tokens) {
            if (/^[A-Z0-9]{5,}$/.test(t)) return t;
        }
        // Si ninguno cumple 5 chars, devolver el mas largo (ultimo recurso)
        tokens.sort((a, b) => b.length - a.length);
        return tokens[0] || '';
    }

    function isISA(input) {
        if (!input) return false;
        let lines;
        if (typeof input === 'string') lines = [input];
        else if (input && input.nodeType === 1) lines = extractTextLines(input);
        else return false;
        const joined = lines.join(' ');
        return /\bISA\b/i.test(joined);
    }

    // DOM helpers
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
    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const cs = window.getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }
    function findHeaderByText(text) {
        const all = document.querySelectorAll('*');
        for (const el of all) {
            if (el.children.length > 0) continue;
            if ((el.textContent || '').trim() === text) return el;
        }
        return null;
    }

    // Routing
    if (host.includes('sclogistics.ats.amazon.dev')) {
        if (window.__bcn8InbSocLoaded) return;
        window.__bcn8InbSocLoaded = true;
        initSocrates();
    } else if (host.includes('trans-logistics-eu.amazon.com')) {
        if (window.location.pathname.includes('shipclerk')) {
            if (window.__bcn8InbYardLoaded) return;
            window.__bcn8InbYardLoaded = true;
            initYard();
        } else {
            if (window.__bcn8InbSesLoaded) return;
            window.__bcn8InbSesLoaded = true;
            initSesameInbound();
        }
    }


    // ============================================================
    //              YARD: PARKINGS LIBRES (copia propia)
    // ============================================================
    function initYard() {
        const style = document.createElement('style');
        style.textContent = `
            #bcn8-iyard {
                position: fixed; top: 80px; left: 20px;
                width: 380px; max-height: 80vh;
                background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                z-index: 2147482990;
                font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                font-size: 13px; color: #111;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #bcn8-iyard.bcn8-min { max-height: 42px; width: 260px; }
            #bcn8-iyard.bcn8-min .bcn8-iy-body, #bcn8-iyard.bcn8-min .bcn8-iy-status { display: none; }
            .bcn8-iy-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(180deg,#1d5d9b 0%,#16456f 100%);
                color: #fff; cursor: move; user-select: none;
            }
            .bcn8-iy-title { font-weight: 600; font-size: 13px; }
            .bcn8-iy-actions { display: flex; gap: 4px; }
            .bcn8-iy-btn {
                background: rgba(255,255,255,0.14); border: none; color: #fff;
                min-width: 26px; height: 26px; padding: 0 8px;
                border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .bcn8-iy-btn:hover { background: rgba(255,255,255,0.28); }
            .bcn8-iy-btn.loading { animation: bcn8-spin 1s linear infinite; }
            @keyframes bcn8-spin { from {transform:rotate(0)} to {transform:rotate(360deg)} }
            .bcn8-iy-status {
                font-size: 11px; color: #555; padding: 6px 12px;
                background: #f7f8f8; border-bottom: 1px solid #eee;
            }
            .bcn8-iy-status .saved { color: #0a7f28; font-weight: 600; }
            .bcn8-iy-body { padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; }
            .bcn8-iy-list { display: flex; flex-wrap: wrap; gap: 4px; }
            .bcn8-iy-tag {
                background: #e6f4ea; border: 1px solid #b7dfc2; border-radius: 3px;
                padding: 2px 6px; font-size: 11px;
                font-family: 'Consolas','Monaco',monospace; color: #1f5a2e;
            }
            .bcn8-iy-empty { text-align: center; color: #777; padding: 20px 10px; font-size: 12px; }
            .bcn8-iy-error {
                color: #8b2020; background: #fdecec; border: 1px solid #f5c0c0;
                padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 4px 0;
            }
            .bcn8-iy-summary {
                display: flex; gap: 10px; font-size: 11px; color: #555;
                padding: 4px 0; margin-bottom: 8px;
                border-bottom: 1px solid #eee;
            }
            .bcn8-iy-summary b { color: #111; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'bcn8-iyard';
        panel.innerHTML = `
            <div class="bcn8-iy-header" id="bcn8-iy-drag">
                <span class="bcn8-iy-title">🅿️ Parkings libres (Inbound)</span>
                <div class="bcn8-iy-actions">
                    <button class="bcn8-iy-btn" id="bcn8-iy-refresh" title="Actualizar">⟳</button>
                    <button class="bcn8-iy-btn" id="bcn8-iy-toggle" title="Minimizar / Maximizar">−</button>
                </div>
            </div>
            <div class="bcn8-iy-status" id="bcn8-iy-status">Pulsa ⟳ para escanear el yard.</div>
            <div class="bcn8-iy-body" id="bcn8-iy-body">
                <div class="bcn8-iy-empty">Asegurate de tener cargado Yard Management y pulsa actualizar.</div>
            </div>
        `;
        document.body.appendChild(panel);

        const refreshBtn = panel.querySelector('#bcn8-iy-refresh');
        const toggleBtn  = panel.querySelector('#bcn8-iy-toggle');
        const statusEl   = panel.querySelector('#bcn8-iy-status');
        const bodyEl     = panel.querySelector('#bcn8-iy-body');
        const header     = panel.querySelector('#bcn8-iy-drag');

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
        });
        document.addEventListener('mouseup', () => drag = null);

        const PS_REGEX = /^PS\s*[-–]?\s*\d+\s*$/i;

        // Misma logica que el script de Outbound:
        //  - cada fila es un <tr>
        //  - td.col1 = Location, td.col2 = Vehicle
        //  - un PS esta ocupado si td.col2 contiene .yard-asset-icon
        function scanYardRows() {
            const all = new Map();
            const free = new Map();
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
                const hasTrailer = !!c2.querySelector('.yard-asset-icon');
                if (!hasTrailer) free.set(canon, display);
            }
            return { all, free };
        }

        async function extractFree() {
            let { all: allBucket, free: freeBucket } = scanYardRows();

            if (allBucket.size > 0) {
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
                        for (const [k, v] of f2) freeBucket.set(k, v);
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
            if (result.error) { bodyEl.innerHTML = `<div class="bcn8-iy-error">${escapeHtml(result.error)}</div>`; return; }

            const summary = `<div class="bcn8-iy-summary">
                <span><b>${result.list.length}</b> libres</span>
                <span><b>${result.totalPS}</b> totales</span>
                <span><b>${result.totalPS - result.list.length}</b> ocupados</span>
            </div>`;

            if (!result.list || result.list.length === 0) {
                bodyEl.innerHTML = summary + `<div class="bcn8-iy-empty">No hay parkings libres.</div>`;
                return;
            }
            bodyEl.innerHTML = summary + `<div class="bcn8-iy-list">${
                result.list.map(ps => `<span class="bcn8-iy-tag">${escapeHtml(ps)}</span>`).join('')
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
                        // Clave PROPIA del script Inbound (independiente del Outbound)
                        GM_setValue('inbFreePS', JSON.stringify({
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
                console.error('[BCN8 Inb Yard]', e);
                statusEl.textContent = 'Error';
                render({ error: 'Error inesperado: ' + (e?.message || e) });
            } finally {
                refreshBtn.classList.remove('loading');
            }
        }

        refreshBtn.addEventListener('click', refresh);
        setTimeout(() => {
            const { all } = scanYardRows();
            if (all.size > 0) refresh();
        }, 2500);

        // Auto-refresh
        attachAutoRefresh({
            container: panel,
            storageKey: 'bcn8inb-yard-auto',
            label: 'Auto-refrescar Yard',
            defaultMinutes: 20,
            minMinutes: 2,
            maxMinutes: 240,
            action: refresh,
            cssPrefix: 'bcn8i',
            activateAntiThrottle: true,
        });
    }


    // ============================================================
    //              SOCRATES: ESCANER DE VOLUMEN
    // ============================================================
    function initSocrates() {
        const style = document.createElement('style');
        style.textContent = `
            #bcn8-soc {
                position: fixed; top: 80px; right: 20px;
                width: 400px; max-height: 80vh;
                background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                z-index: 2147483000;
                font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                font-size: 13px; color: #111;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #bcn8-soc.bcn8-min { max-height: 42px; width: 260px; }
            #bcn8-soc.bcn8-min .bcn8-s-body, #bcn8-soc.bcn8-min .bcn8-s-status { display: none; }
            .bcn8-s-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(180deg,#1d5d9b 0%,#16456f 100%);
                color: #fff; cursor: move; user-select: none;
            }
            .bcn8-s-title { font-weight: 600; font-size: 13px; }
            .bcn8-s-actions { display: flex; gap: 4px; }
            .bcn8-s-btn {
                background: rgba(255,255,255,0.14); border: none; color: #fff;
                min-width: 26px; height: 26px; padding: 0 8px;
                border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .bcn8-s-btn:hover { background: rgba(255,255,255,0.28); }
            .bcn8-s-btn.loading { animation: bcn8-spin 1s linear infinite; }
            @keyframes bcn8-spin { from {transform:rotate(0)} to {transform:rotate(360deg)} }
            .bcn8-s-status {
                font-size: 11px; color: #555; padding: 6px 12px;
                background: #f7f8f8; border-bottom: 1px solid #eee;
            }
            .bcn8-s-status .saved { color: #0a7f28; font-weight: 600; }
            .bcn8-s-status .warn { color: #b26100; font-weight: 600; }
            .bcn8-s-body { padding: 10px 12px; overflow-y: auto; flex: 1 1 auto; }
            .bcn8-s-summary { font-size: 12px; color: #333; margin-bottom: 8px; }
            .bcn8-s-summary b { color: #1d5d9b; }
            .bcn8-s-error {
                color: #8b2020; background: #fdecec; border: 1px solid #f5c0c0;
                padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 4px 0;
            }
            .bcn8-s-missing {
                color: #8a5a00; background: #fff6e0; border: 1px solid #f0c070;
                padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 4px 0;
            }
            .bcn8-s-row {
                border: 1px solid #eee; border-radius: 5px; padding: 6px 8px;
                margin-bottom: 4px; background: #fafafa; font-size: 11px;
            }
            .bcn8-s-row b { color: #1d5d9b; font-family: 'Consolas', monospace; }
            .bcn8-s-tag {
                display: inline-block; margin-right: 4px;
                padding: 0 5px; border-radius: 2px; font-size: 10px;
                font-family: 'Consolas', monospace;
                background: #eef; color: #334;
            }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'bcn8-soc';
        panel.innerHTML = `
            <div class="bcn8-s-header" id="bcn8-s-drag">
                <span class="bcn8-s-title">📊 Volumen Inbound</span>
                <div class="bcn8-s-actions">
                    <button class="bcn8-s-btn" id="bcn8-s-refresh" title="Escanear">⟳</button>
                    <button class="bcn8-s-btn" id="bcn8-s-toggle" title="Minimizar/Maximizar">−</button>
                </div>
            </div>
            <div class="bcn8-s-status" id="bcn8-s-status">Pulsa ⟳ para escanear el volumen.</div>
            <div class="bcn8-s-body" id="bcn8-s-body">
                <div style="text-align:center;color:#888;font-size:12px;padding:14px;">
                    Asegurate de estar en Inbound Profile y tener visibles las columnas de volumen.
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const refreshBtn = panel.querySelector('#bcn8-s-refresh');
        const toggleBtn  = panel.querySelector('#bcn8-s-toggle');
        const statusEl   = panel.querySelector('#bcn8-s-status');
        const bodyEl     = panel.querySelector('#bcn8-s-body');
        const header     = panel.querySelector('#bcn8-s-drag');

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

        // ===== COLUMNAS REQUERIDAS =====
        // Socrates usa para cada columna un <p> con el texto del nombre de columna
        // dentro de un contenedor que tambien contiene los iconos de ordenacion.
        const REQUIRED_COLS = [
            { key: 'vrid',   label: 'VRId' },
            { key: 'total',  label: 'Total Packages' },
            { key: 'xdock',  label: 'Pending XDock Containers' },
            { key: 'xss',    label: 'XS+S' },
            { key: 'm',      label: 'M' },
            { key: 'l',      label: 'L' },
            { key: 'xl',     label: 'XL' },
            { key: 'nc',     label: 'NC' },
            { key: 'ncp',    label: 'NC Plus' },
            { key: 'fluid',  label: 'Pending FLUID Packages' },
        ];

        // Columnas candidatas como respaldo si alguna etiqueta es distinta
        const COLUMN_ALIASES = {
            total: ['Total Packages', 'Total Pkgs'],
            xdock: ['Pending XDock Containers', 'XD Containers', 'XDock Containers', 'Total XDock Containers'],
            xss:   ['XS+S', 'XSS'],
            fluid: ['Pending FLUID Packages', 'Pending Fluid Packages', 'Pending Fluid', 'pendingFLUID'],
        };

        // Busca todos los <p> de cabecera de columna y devuelve [{label, colIndex}]
        function findHeaderLabels() {
            // Las cabeceras de columna en Socrates son <p class="...css-lq1n66">Label</p>.
            // Esa clase la comparten TODAS las cabeceras. Ademas algunas tambien tienen
            // botones IconButton con arrows (orden) al lado.
            const headers = [];
            const seenEls = new Set();

            // Estrategia 1 (principal): <p> con class que contenga "css-lq1n66"
            const byClass = document.querySelectorAll('p[class*="css-lq1n66"]');
            for (const p of byClass) {
                const txt = (p.textContent || '').trim();
                if (!txt) continue;
                if (txt.length > 50) continue;
                if (seenEls.has(p)) continue;
                seenEls.add(p);
                headers.push({ label: txt, el: p });
            }

            // Estrategia 2 (respaldo): <p> cuyo padre contiene los IconButton de ordenacion
            if (headers.length === 0) {
                const pTags = document.querySelectorAll('p');
                for (const p of pTags) {
                    const txt = (p.textContent || '').trim();
                    if (!txt) continue;
                    if (txt.length > 40) continue;
                    if (seenEls.has(p)) continue;
                    const parent = p.parentElement;
                    if (!parent) continue;
                    const hasUp = parent.querySelector('[data-testid="ArrowDropUpIcon"]');
                    const hasDown = parent.querySelector('[data-testid="ArrowDropDownIcon"]');
                    if (!hasUp || !hasDown) continue;
                    seenEls.add(p);
                    headers.push({ label: txt, el: p });
                }
            }

            // Estrategia 3 (respaldo adicional): cabeceras dentro de th/role="columnheader"
            const colHeaders = document.querySelectorAll('[role="columnheader"], th');
            for (const ch of colHeaders) {
                const ps = ch.querySelectorAll('p');
                for (const p of ps) {
                    if (seenEls.has(p)) continue;
                    const txt = (p.textContent || '').trim();
                    if (!txt) continue;
                    if (txt.length > 50) continue;
                    seenEls.add(p);
                    headers.push({ label: txt, el: p });
                }
            }

            return headers;
        }

        // Construye un mapa label -> colIndex basado en la posicion X de cada cabecera
        function mapColumns() {
            const headers = findHeaderLabels();
            // Agrupar headers unicos por label (quedarse con el mas visible)
            const byLabel = new Map();
            for (const h of headers) {
                if (!isVisible(h.el)) continue;
                if (!byLabel.has(h.label)) byLabel.set(h.label, h.el);
            }
            // Ordenar por posicion X
            const ordered = [...byLabel.entries()].map(([label, el]) => ({
                label, el, x: el.getBoundingClientRect().left
            })).sort((a,b) => a.x - b.x);

            // Ahora detectar que labels necesitamos
            const resolved = {};
            const missing = [];
            for (const col of REQUIRED_COLS) {
                const aliases = [col.label, ...(COLUMN_ALIASES[col.key] || [])];
                const found = ordered.find(o => aliases.includes(o.label));
                if (found) resolved[col.key] = found;
                else missing.push(col.label);
            }
            return { resolved, missing, ordered };
        }

        function missingColsMessage(missing) {
            const urlParams = 'arrivalStatus;dataSource;vrid;origin;arrivalTime;earliestCPT;pendingSortableInEarliestCPT;pendingSortableInSelectedCPT;pendingPackages;pendingXDockContainer;pendingBags;totalXDock;sortableNonConPackages;inductTime;modify;trailerLocation;pendingNonConPackages;averagePendingCubeExcludingNC;pendingFLUID;firstScanPendingPackages;totalPackages';
            const fullUrl = `https://sclogistics.ats.amazon.dev/socrates/inbound_profile/?node=BCN8&selectedColumns=${encodeURIComponent(urlParams)}`;
            return `
                <div class="bcn8-s-missing">
                    <b>Faltan columnas:</b> ${missing.map(escapeHtml).join(', ')}<br/>
                    Abre en su lugar:<br/>
                    <a href="${fullUrl}" target="_self" style="color:#1d5d9b;word-break:break-all;">Inbound Profile con todas las columnas</a>
                </div>
            `;
        }

        // Localizar la fila de cada camion por posicion X (columna vrid) y agrupar celdas por fila
        // Estrategia:
        //   1) Obtener el scroll container principal (el que tiene la tabla virtualizada).
        //   2) Scrollear de izquierda a derecha para que las columnas requeridas sean accesibles por DOM.
        //   3) En cada pasada, recoger filas.
        function findDataContainer() {
            // Buscar el elemento scrollable mas grande (la tabla virtualizada de Socrates)
            // Heuristica: contiene muchos elementos con texto numerico (total packages, etc.).
            const all = document.querySelectorAll('div');
            let best = null, bestScore = -1;
            for (const el of all) {
                const cs = window.getComputedStyle(el);
                if (!/auto|scroll/.test(cs.overflowX + cs.overflowY)) continue;
                if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 300 || r.height < 200) continue;
                const score = r.width * r.height;
                if (score > bestScore) { bestScore = score; best = el; }
            }
            return best;
        }

        // Obtener celdas de tipo "dato" en la tabla. Una celda en Socrates es un <p> o un <div>
        // con texto. Para cada VRID, buscaremos las celdas con numero que esten en la misma
        // fila (alineacion por Y aprox).
        function findVridCells(vridColEl) {
            // vridColEl es el <p> del header. Su posicion X marca la columna VRId.
            // Buscamos <a> o <p> con texto VRID (alfanumerico 5-15 chars) alineados con esa X.
            const col = vridColEl.getBoundingClientRect();
            const cx = col.left + col.width / 2;

            // Candidatos: enlaces <a> con texto que parezca VRID
            const anchors = document.querySelectorAll('a, p');
            const cells = [];
            const seen = new Set();
            for (const a of anchors) {
                const txt = (a.textContent || '').trim();
                if (!/^[A-Z0-9]{5,15}$/i.test(txt)) continue;
                if (!isVisible(a)) continue;
                const r = a.getBoundingClientRect();
                // alineado en x con la columna VRID (tolerancia: +/- columna/2)
                if (Math.abs((r.left + r.width/2) - cx) > col.width) continue;
                if (seen.has(txt + ':' + Math.round(r.top))) continue;
                seen.add(txt + ':' + Math.round(r.top));
                cells.push({ text: txt.toUpperCase(), y: r.top + r.height/2, el: a });
            }
            return cells;
        }

        // Para una fila (dada por su Y), encuentra el valor numerico de la columna col
        function getNumericCellAt(colEl, rowY) {
            const col = colEl.getBoundingClientRect();
            const cx = col.left + col.width / 2;
            // Buscar elementos con texto numerico alineados con la columna y con Y cerca de rowY
            // (tolerancia vertical: altura de una fila tipica de Socrates ~ 40-50px, usamos 25)
            const els = document.querySelectorAll('p, span, div');
            let best = null, bestDy = 999;
            for (const el of els) {
                if (el.children.length > 0) continue;
                const txt = (el.textContent || '').trim();
                if (!/^\d[\d,\.]*$/.test(txt)) continue;
                if (!isVisible(el)) continue;
                const r = el.getBoundingClientRect();
                const ex = r.left + r.width / 2;
                if (Math.abs(ex - cx) > col.width) continue;
                const ey = r.top + r.height / 2;
                const dy = Math.abs(ey - rowY);
                if (dy > 30) continue;
                if (dy < bestDy) { bestDy = dy; best = txt; }
            }
            if (best === null) return 0;
            return parseFloat(best.replace(/,/g, '')) || 0;
        }

        // Scrollear todo el contenido (X e Y) y escanear cada fila.
        // Estrategia v2 (mas robusta):
        //   FASE 1: scroll vertical completo recogiendo TODOS los VRIDs visibles
        //           con su posicion Y. Lo hacemos varias veces (combinando container scroll
        //           y window scroll como fallback) hasta que no aparezcan VRIDs nuevos.
        //   FASE 2: scroll horizontal por la tabla recogiendo los valores numericos
        //           de cada columna alineados con cada VRID conocido.
        async function extractVolume() {
            // 1) Mapear columnas
            const mapResult = mapColumns();
            if (mapResult.missing.length > 0) {
                return { error: 'missing', missing: mapResult.missing };
            }
            const cols = mapResult.resolved;

            const container = findDataContainer();
            // Tambien intentamos con scroll de window (algunas tablas no tienen
            // un container scrollable propio, sino que el body es el que scrollea)
            const useWindow = !container || (document.documentElement.scrollHeight > window.innerHeight + 50);

            // ====== FASE 1: recolectar VRIDs en todo el scroll vertical ======
            // Estrategia: usar scrollIntoView() en la ULTIMA celda VRID visible.
            // Esto NO depende de encontrar el contenedor scrollable correcto.
            // El navegador sabe exactamente que scrollear.
            const vridSet = new Set();
            const vridElements = [];

            const captureVrids = () => {
                const m = mapColumns();
                if (m.missing.length === 0) Object.assign(cols, m.resolved);
                const found = findVridCells(cols.vrid.el);
                let lastEl = null;
                for (const vc of found) {
                    if (!vridSet.has(vc.text)) {
                        vridSet.add(vc.text);
                        vridElements.push({ text: vc.text, el: vc.el });
                    }
                    lastEl = vc.el; // siempre guardar la ultima celda visible
                }
                return lastEl;
            };

            // Scroll al inicio
            window.scrollTo(0, 0);
            if (container) { try { container.scrollTop = 0; } catch(e) {} }
            await sleep(500);

            let lastVisible = captureVrids();
            console.log('[BCN8 Soc] FASE 1 inicio: ' + vridSet.size + ' VRIDs visibles');

            let stagnant = 0;
            let lastCount = vridSet.size;

            for (let i = 0; i < 300; i++) {
                // Scrollear la ultima celda visible al TOP de la pantalla
                // Esto revela filas nuevas debajo
                if (lastVisible && document.body.contains(lastVisible)) {
                    try { lastVisible.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch (e) {}
                } else {
                    // Fallback: scroll generico
                    window.scrollBy(0, 500);
                    if (container) { try { container.scrollTop += 500; } catch(e) {} }
                }
                await sleep(250);

                // Capturar nuevos VRIDs
                lastVisible = captureVrids();

                // Deteccion de estancamiento
                if (vridSet.size === lastCount) {
                    stagnant++;
                    if (stagnant > 8) {
                        console.log('[BCN8 Soc] FASE 1 estancado en ' + vridSet.size + ' VRIDs tras ' + i + ' iteraciones');
                        break;
                    }
                } else {
                    stagnant = 0;
                    lastCount = vridSet.size;
                }

                if (i > 0 && i % 20 === 0) {
                    console.log(`[BCN8 Soc] FASE 1 progreso: ${vridSet.size} VRIDs (iter ${i})`);
                }
            }

            console.log('[BCN8 Soc] FASE 1 capturó ' + vridSet.size + ' VRIDs únicos');

            // Volver al inicio para FASE 2
            if (container) {
                try { container.scrollTop = 0; container.scrollLeft = 0; } catch(e) {}
            }
            window.scrollTo(0, 0);
            await sleep(400);

            // ====== FASE 2: recoger valores numericos por VRID ======
            const data = new Map();
            const empty = () => ({ total: 0, xdock: 0, xss: 0, m: 0, l: 0, xl: 0, nc: 0, ncp: 0, fluid: 0 });

            const captureVisibleRows = async () => {
                const m = mapColumns();
                if (m.missing.length === 0) Object.assign(cols, m.resolved);
                const visible = findVridCells(cols.vrid.el);
                let lastEl = null;
                for (const vc of visible) {
                    const existing = data.get(vc.text) || empty();
                    for (const k of Object.keys(existing)) {
                        if (!cols[k]) continue;
                        const v = getNumericCellAt(cols[k].el, vc.y);
                        if (v > 0) existing[k] = v;
                    }
                    data.set(vc.text, existing);
                    lastEl = vc.el;
                }
                return lastEl;
            };

            // Misma estrategia scrollIntoView que FASE 1
            let lastDataCount = 0;
            let stagnant2 = 0;
            for (let i = 0; i < 300; i++) {
                // Scroll horizontal si hay container con scroll X
                if (container) {
                    const maxX = container.scrollWidth - container.clientWidth;
                    if (maxX > 10) {
                        const steps = Math.max(2, Math.ceil(maxX / (container.clientWidth * 0.7)));
                        for (let xi = 0; xi <= steps; xi++) {
                            container.scrollLeft = Math.min(maxX, xi * container.clientWidth * 0.7);
                            await sleep(180);
                            await captureVisibleRows();
                        }
                        container.scrollLeft = 0;
                        await sleep(120);
                    } else {
                        await captureVisibleRows();
                    }
                } else {
                    await captureVisibleRows();
                }

                // Estancamiento por datos
                if (data.size === lastDataCount) {
                    stagnant2++;
                    if (stagnant2 > 8) break;
                } else {
                    stagnant2 = 0;
                    lastDataCount = data.size;
                }

                // Scroll vertical via scrollIntoView del ultimo VRID visible
                const visibleNow = findVridCells(cols.vrid.el);
                const lastVridEl = visibleNow.length > 0 ? visibleNow[visibleNow.length - 1].el : null;
                if (lastVridEl && document.body.contains(lastVridEl)) {
                    try { lastVridEl.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch (e) {}
                } else {
                    window.scrollBy(0, 500);
                    if (container) { try { container.scrollTop += 500; } catch(e) {} }
                }
                await sleep(250);
            }

            // Aseguramos que todos los vrids descubiertos en FASE 1 estan en data
            for (const ve of vridElements) {
                if (!data.has(ve.text)) data.set(ve.text, empty());
            }

            // Restaurar scroll
            if (container) {
                try { container.scrollTop = 0; container.scrollLeft = 0; } catch(e) {}
            }
            window.scrollTo(0, 0);

            console.log('[BCN8 Soc] FASE 1 capturó ' + vridSet.size + ' VRIDs únicos');
            console.log('[BCN8 Soc] FASE 2 leyó datos de ' + data.size + ' VRIDs');

            return { data };
        }

        function render(result) {
            if (result.error === 'missing') {
                bodyEl.innerHTML = missingColsMessage(result.missing);
                return;
            }
            if (result.error) {
                bodyEl.innerHTML = `<div class="bcn8-s-error">${escapeHtml(result.error)}</div>`;
                return;
            }
            const entries = [...result.data.entries()];
            if (entries.length === 0) {
                bodyEl.innerHTML = `<div style="text-align:center;color:#888;padding:14px;">No encontre camiones.</div>`;
                return;
            }
            // Summary
            const totalPkg = entries.reduce((a, [, v]) => a + (v.total || 0), 0);
            const totalFluid = entries.reduce((a, [, v]) => a + (v.fluid || 0), 0);
            const totalXd = entries.reduce((a, [, v]) => a + (v.xdock || 0), 0);
            let html = `<div class="bcn8-s-summary"><b>${entries.length}</b> camiones · <b>${totalPkg.toLocaleString('es')}</b> pkgs · <b>${totalXd}</b> XD cont · <b>${totalFluid.toLocaleString('es')}</b> fluid</div>`;

            // Preview de primeros 15
            const preview = entries.slice(0, 15);
            for (const [vrid, v] of preview) {
                const dec = decideGroup(v);
                html += `<div class="bcn8-s-row">
                    <b>${escapeHtml(vrid)}</b> → <span style="color:#1d5d9b;font-weight:600;">${dec.group}</span>
                    <div style="margin-top:3px;">
                        <span class="bcn8-s-tag">T:${v.total}</span>
                        <span class="bcn8-s-tag">XS:${v.xss}</span>
                        <span class="bcn8-s-tag">M:${v.m}</span>
                        <span class="bcn8-s-tag">L:${v.l}</span>
                        <span class="bcn8-s-tag">XL:${v.xl}</span>
                        <span class="bcn8-s-tag">NC:${v.nc}</span>
                        <span class="bcn8-s-tag">NC+:${v.ncp}</span>
                        <span class="bcn8-s-tag">XD:${v.xdock}</span>
                        <span class="bcn8-s-tag">Fl:${v.fluid}</span>
                    </div>
                </div>`;
            }
            if (entries.length > preview.length) {
                html += `<div style="text-align:center;color:#888;font-size:11px;padding:6px;">...y ${entries.length - preview.length} mas</div>`;
            }
            bodyEl.innerHTML = html;
        }

        async function refresh() {
            refreshBtn.classList.add('loading');
            statusEl.textContent = 'Escaneando Socrates...';
            try {
                const result = await extractVolume();
                if (result.error === 'missing') {
                    statusEl.innerHTML = `<span class="warn">⚠ Faltan columnas</span>`;
                    render(result);
                    return;
                }
                const now = Date.now();
                const nowStr = new Date(now).toLocaleTimeString('es-ES');
                try {
                    const serializable = {};
                    for (const [k, v] of result.data) serializable[k] = v;
                    GM_setValue('inbVolume', JSON.stringify({
                        data: serializable,
                        total: result.data.size,
                        updatedAt: now
                    }));
                    statusEl.innerHTML = `${result.data.size} camiones · ${nowStr} <span class="saved">✓ guardado</span>`;
                } catch (e) {
                    statusEl.textContent = `${result.data.size} camiones · ${nowStr} (no se pudo guardar)`;
                }
                render(result);
            } catch (e) {
                console.error('[BCN8 Socrates]', e);
                statusEl.textContent = 'Error';
                render({ error: e.message || String(e) });
            } finally {
                refreshBtn.classList.remove('loading');
            }
        }

        refreshBtn.addEventListener('click', refresh);

        // Auto-refresh
        attachAutoRefresh({
            container: panel,
            storageKey: 'bcn8inb-soc-auto',
            label: 'Auto-refrescar Socrates',
            defaultMinutes: 30,
            minMinutes: 5,
            maxMinutes: 240,
            action: refresh,
            cssPrefix: 'bcn8i',
            activateAntiThrottle: true,
        });
    }


    // ============================================================
    //              SESAME INBOUND: PRE-ASIGNACION
    // ============================================================
    function initSesameInbound() {
        const style = document.createElement('style');
        style.textContent = `
            #bcn8-inb {
                position: fixed; top: 80px; left: 20px;
                width: 400px; max-height: 84vh;
                background: #fff; border: 1px solid #d5d9d9; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                z-index: 2147483000;
                font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                font-size: 13px; color: #111;
                display: flex; flex-direction: column; overflow: hidden;
            }
            #bcn8-inb.bcn8-min { max-height: 42px; width: 280px; }
            #bcn8-inb.bcn8-min .bcn8-i-body,
            #bcn8-inb.bcn8-min .bcn8-i-action,
            #bcn8-inb.bcn8-min .bcn8-i-meta { display: none; }
            .bcn8-i-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
                background: linear-gradient(180deg,#1d5d9b 0%,#16456f 100%);
                color: #fff; cursor: move; user-select: none;
            }
            .bcn8-i-title { font-weight: 600; font-size: 13px; }
            .bcn8-i-actions { display: flex; gap: 4px; }
            .bcn8-i-btn {
                background: rgba(255,255,255,0.14); border: none; color: #fff;
                min-width: 26px; height: 26px; padding: 0 8px;
                border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .bcn8-i-btn:hover { background: rgba(255,255,255,0.28); }
            .bcn8-i-btn.loading { animation: bcn8-spin 1s linear infinite; }
            .bcn8-i-meta {
                padding: 8px 12px; background: #f7f8f8; border-bottom: 1px solid #eee;
                font-size: 11px; color: #555;
                display: flex; flex-direction: column; gap: 2px;
            }
            .bcn8-i-meta .stale { color: #b26100; font-weight: 600; }
            .bcn8-i-meta .ok { color: #0a7f28; font-weight: 600; }
            .bcn8-i-meta .err { color: #b71c1c; font-weight: 600; }
            .bcn8-i-filter {
                padding: 8px 12px; background: #fafafa; border-bottom: 1px solid #eee;
                font-size: 11px;
            }
            .bcn8-i-filter-label {
                font-weight: 600; color: #555; display: block; margin-bottom: 4px;
            }
            .bcn8-i-filter-row {
                display: flex; align-items: center; gap: 4px; flex-wrap: nowrap;
            }
            .bcn8-i-filter-row span { color: #666; font-size: 11px; }
            .bcn8-i-filter-input {
                flex: 1; min-width: 0; padding: 4px 6px;
                border: 1px solid #d5d9d9; border-radius: 3px;
                font-size: 12px; outline: none; font-family: inherit;
            }
            .bcn8-i-filter-input:focus {
                border-color: #1d5d9b;
                box-shadow: 0 0 0 2px rgba(29,93,155,0.15);
            }
            .bcn8-i-filter-clear {
                background: #eee; border: 1px solid #ccc; border-radius: 3px;
                width: 22px; height: 22px; padding: 0; cursor: pointer; font-size: 11px;
                color: #666;
            }
            .bcn8-i-filter-clear:hover { background: #ddd; }
            .bcn8-i-filter-hint {
                color: #888; font-size: 10px; margin-top: 3px;
            }
            .bcn8-i-filter-hint.active { color: #1d5d9b; font-weight: 600; }
            .bcn8-i-filter-quick {
                display: flex; align-items: center; gap: 4px; margin-top: 5px;
            }
            .bcn8-i-qbtn {
                background: #e3f2fd; border: 1px solid #90caf9; border-radius: 4px;
                padding: 3px 10px; font-size: 11px; font-weight: 600; color: #0d47a1;
                cursor: pointer; transition: background .15s;
            }
            .bcn8-i-qbtn:hover { background: #bbdefb; }
            .bcn8-i-qbtn.active { background: #0d47a1; color: #fff; border-color: #0d47a1; }
            .bcn8-i-action {
                padding: 10px 12px; background: #fff; border-bottom: 1px solid #eee;
                display: flex; flex-direction: column; gap: 6px;
            }
            .bcn8-i-run { background: #1d5d9b; color: #fff; border: none;
                padding: 8px 12px; border-radius: 4px; font-weight: 600;
                cursor: pointer; font-size: 13px; }
            .bcn8-i-run:hover { background: #16456f; }
            .bcn8-i-run:disabled { background: #ccc; cursor: not-allowed; }
            .bcn8-i-stop { background: #c14545; color: #fff; border: none;
                padding: 8px 12px; border-radius: 4px; font-weight: 600;
                cursor: pointer; font-size: 13px; }
            .bcn8-i-stop:hover { background: #9b2f2f; }
            .bcn8-i-resume { background: #2e7d32; color: #fff; border: none;
                padding: 8px 12px; border-radius: 4px; font-weight: 600;
                cursor: pointer; font-size: 13px; }
            .bcn8-i-resume:hover { background: #205024; }
            .bcn8-i-progress { font-size: 11px; color: #1d5d9b; font-weight: 600; margin-top: 4px; }
            .bcn8-i-body { padding: 8px 10px; overflow-y: auto; flex: 1 1 auto; }
            .bcn8-i-section { margin-bottom: 8px; }
            .bcn8-i-section-title {
                font-size: 11px; text-transform: uppercase;
                font-weight: 600; color: #555;
                padding: 4px 2px; margin-bottom: 4px;
                border-bottom: 1px solid #eee;
            }
            .bcn8-i-item {
                display: flex; align-items: center; justify-content: space-between;
                padding: 6px 8px; border-radius: 4px; margin-bottom: 4px;
                background: #fafafa; border: 1px solid #e7e7e7; gap: 6px;
            }
            .bcn8-i-item.unmatched { background: #fff4e5; border-color: #f0c070; }
            .bcn8-i-item.skipped { background: #eee; border-color: #ccc; opacity: 0.85; }
            .bcn8-i-item.ok { background: #e6f4ea; border-color: #b7dfc2; }
            .bcn8-i-item.isa { background: #f3e5f5; border-color: #ba68c8; }
            .bcn8-i-item.acc { background: #e8eaf6; border-color: #9fa8da; }
            .bcn8-i-item.ps  { background: #e3f2fd; border-color: #8bb8e8; }
            .bcn8-i-item-name { font-weight: 600; font-size: 12px; word-break: break-word; }
            .bcn8-i-item-info { font-family: 'Consolas', monospace; font-size: 11px; color: #333; margin-top: 2px; }
            .bcn8-i-badge {
                display: inline-block; font-size: 10px; font-weight: 700;
                padding: 1px 5px; border-radius: 3px; margin-right: 4px;
            }
            .bcn8-i-badge.grp { background: #c5cae9; color: #1a237e; }
            .bcn8-i-badge.isa { background: #e1bee7; color: #4a148c; }
            .bcn8-i-badge.acc { background: #9fa8da; color: #1a237e; }
            .bcn8-i-badge.ps  { background: #bbdefb; color: #0d47a1; }
            .bcn8-i-badge.pg { background: #ddd; color: #333; }
            .bcn8-i-badge.hr { background: #f0f0f0; color: #555; font-family: 'Consolas', monospace; }
            .bcn8-i-badge.skip { background: #e0e0e0; color: #666; }
            .bcn8-i-goto {
                background: #232f3e; color: #fff; border: none;
                padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;
                flex-shrink: 0;
            }
            .bcn8-i-goto:hover { background: #0f1924; }
            .bcn8-i-empty { padding: 14px; text-align: center; color: #888; font-size: 12px; }
            .bcn8-i-error {
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
        panel.id = 'bcn8-inb';
        panel.innerHTML = `
            <div class="bcn8-i-header" id="bcn8-i-drag">
                <span class="bcn8-i-title">📥 Pre-asignación Inbound</span>
                <div class="bcn8-i-actions">
                    <button class="bcn8-i-btn" id="bcn8-i-reload" title="Recargar">⟳</button>
                    <button class="bcn8-i-btn" id="bcn8-i-toggle" title="Minimizar">−</button>
                </div>
            </div>
            <div class="bcn8-i-meta" id="bcn8-i-meta">Cargando datos...</div>
            <div class="bcn8-i-filter">
                <label class="bcn8-i-filter-label">Filtro de hora (Sesame "Time"):</label>
                <div class="bcn8-i-filter-row">
                    <span>Desde</span>
                    <input type="time" class="bcn8-i-filter-input" id="bcn8-i-from"/>
                    <span>Hasta</span>
                    <input type="time" class="bcn8-i-filter-input" id="bcn8-i-to"/>
                    <button class="bcn8-i-filter-clear" id="bcn8-i-filter-clear" title="Limpiar">✕</button>
                </div>
                <div class="bcn8-i-filter-quick" id="bcn8-i-filter-quick">
                    <span style="font-size:10px;color:#666;">Rápido:</span>
                    <button class="bcn8-i-qbtn" data-hours="2">2h</button>
                    <button class="bcn8-i-qbtn" data-hours="4">4h</button>
                    <button class="bcn8-i-qbtn" data-hours="6">6h</button>
                    <button class="bcn8-i-qbtn" data-hours="8">8h</button>
                    <button class="bcn8-i-qbtn" data-hours="12">12h</button>
                </div>
                <div class="bcn8-i-filter-hint" id="bcn8-i-filter-hint">Vacio = sin filtro (procesa todos)</div>
            </div>
            <div class="bcn8-i-action">
                <button class="bcn8-i-run" id="bcn8-i-run">Asignar muelles Inbound</button>
                <button class="bcn8-i-stop" id="bcn8-i-stop" style="display:none;">⏸ Detener</button>
                <button class="bcn8-i-resume" id="bcn8-i-resume" style="display:none;">▶ Reanudar</button>
                <div class="bcn8-i-progress" id="bcn8-i-progress" style="display:none;"></div>
            </div>
            <div class="bcn8-i-body" id="bcn8-i-body">
                <div class="bcn8-i-empty">Pulsa "Asignar muelles Inbound" para empezar.</div>
            </div>
        `;
        document.body.appendChild(panel);

        const metaEl    = panel.querySelector('#bcn8-i-meta');
        const runBtn    = panel.querySelector('#bcn8-i-run');
        const stopBtn   = panel.querySelector('#bcn8-i-stop');
        const resumeBtn = panel.querySelector('#bcn8-i-resume');
        const reloadBtn = panel.querySelector('#bcn8-i-reload');
        const toggleBtn = panel.querySelector('#bcn8-i-toggle');
        const bodyEl    = panel.querySelector('#bcn8-i-body');
        const progEl    = panel.querySelector('#bcn8-i-progress');
        const header    = panel.querySelector('#bcn8-i-drag');
        const fromInp   = panel.querySelector('#bcn8-i-from');
        const toInp     = panel.querySelector('#bcn8-i-to');
        const filterClearBtn = panel.querySelector('#bcn8-i-filter-clear');
        const filterHint = panel.querySelector('#bcn8-i-filter-hint');

        // ====== Filtro de horas ======
        try {
            const savedFrom = GM_getValue('inbFilterFrom', '');
            const savedTo   = GM_getValue('inbFilterTo', '');
            if (savedFrom) fromInp.value = savedFrom;
            if (savedTo)   toInp.value = savedTo;
        } catch (e) {}

        // Parsea hora de la celda Time. Acepta:
        //  - "2:45:00 PM" / "10:00 AM" (12h con AM/PM)
        //  - "14:45:00" / "14:45"      (24h)
        function parseTimeToMinutes(text) {
            if (!text) return null;
            const firstLine = String(text).split(/[\n\r]+/).map(s => s.trim()).filter(Boolean)[0] || '';
            let m = firstLine.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm|a\.?m\.?|p\.?m\.?)/i);
            if (m) {
                let h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                const isPM = /p/i.test(m[3]);
                if (h === 12) h = 0;
                if (isPM) h += 12;
                return h * 60 + min;
            }
            m = firstLine.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
            if (m) {
                const h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                if (h <= 23 && min <= 59) return h * 60 + min;
            }
            m = firstLine.match(/(\d{1,2}):(\d{2})/);
            if (m) {
                const h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                if (h <= 23 && min <= 59) return h * 60 + min;
            }
            return null;
        }
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
        function isInFilter(timeMin, range) {
            if (range.from === null && range.to === null) return true;
            if (range.from !== null && timeMin < range.from) return false;
            if (range.to   !== null && timeMin > range.to)   return false;
            return true;
        }

        function updateFilterHint() {
            const f = fromInp.value, t = toInp.value;
            // Mostrar hora real detectada de la primera fila
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
            try { GM_setValue('inbFilterFrom', fromInp.value); } catch (e) {}
            updateFilterHint();
        });
        toInp.addEventListener('change', () => {
            try { GM_setValue('inbFilterTo', toInp.value); } catch (e) {}
            updateFilterHint();
        });
        filterClearBtn.addEventListener('click', () => {
            fromInp.value = '';
            toInp.value = '';
            try { GM_setValue('inbFilterFrom', ''); GM_setValue('inbFilterTo', ''); } catch (e) {}
            updateFilterHint();
        });
        updateFilterHint();
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
            try { GM_setValue('inbFilterFrom', fromInp.value); GM_setValue('inbFilterTo', toInp.value); } catch (e) {}
            updateFilterHint();
            panel.querySelectorAll('.bcn8-i-qbtn').forEach(b => b.classList.remove('active'));
            const activeBtn = panel.querySelector(`.bcn8-i-qbtn[data-hours="${hours}"]`);
            if (activeBtn) activeBtn.classList.add('active');
            scheduleFilterAlert(end);
        }
        panel.querySelectorAll('.bcn8-i-qbtn').forEach(btn => {
            btn.addEventListener('click', () => setQuickFilter(parseInt(btn.getAttribute('data-hours'))));
        });

        // ====== Alerta 15 min antes de fin de rango ======
        let filterAlertTimer = null;
        function scheduleFilterAlert(endDate) {
            if (filterAlertTimer) { clearTimeout(filterAlertTimer); filterAlertTimer = null; }
            const msUntilAlert = endDate.getTime() - 15 * 60000 - Date.now();
            if (msUntilAlert <= 0) return;
            filterAlertTimer = setTimeout(() => {
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
                        El rango de pre-asignación Inbound termina a las <strong>${toInp.value}</strong>.<br>
                        Revisa los camiones pre-asignados y valida el resultado.
                    </div>
                    <button id="bcn8i-alert-ok" style="
                        margin-top:16px;padding:10px 28px;background:#f57c00;color:#fff;
                        border:none;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;
                    ">Entendido</button>
                `;
                if (!document.getElementById('bcn8-pulse-css')) {
                    const s = document.createElement('style'); s.id = 'bcn8-pulse-css';
                    s.textContent = `@keyframes bcn8-pulse{0%,100%{box-shadow:0 8px 32px rgba(0,0,0,0.35)}50%{box-shadow:0 8px 32px rgba(245,124,0,0.6)}}`;
                    document.head.appendChild(s);
                }
                document.body.appendChild(popup);
                popup.querySelector('#bcn8i-alert-ok').addEventListener('click', () => popup.remove());
                setTimeout(() => { if (document.body.contains(popup)) popup.remove(); }, 60000);
            }, msUntilAlert);
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
        });
        document.addEventListener('mouseup', () => drag = null);

        // Nota: el panel se muestra siempre en Sesame. El usuario lo oculta
        // manualmente con el boton de minimizar si no lo quiere ver en Outbound.
        // Lo ponemos a la IZQUIERDA por defecto para no pisar al panel de Outbound.

        function loadVolume() {
            try {
                const raw = GM_getValue('inbVolume', null);
                if (!raw) return null;
                const j = JSON.parse(raw);
                return {
                    map: j.data || {},
                    total: j.total,
                    updatedAt: j.updatedAt
                };
            } catch (e) { return null; }
        }

        // Lee la clave PROPIA del script Inbound (escrita por initYard).
        // freePS = { list: ['PS-150', 'PS-151', ...], updatedAt }
        function loadYard() {
            try {
                const raw = GM_getValue('inbFreePS', null);
                if (!raw) return null;
                return JSON.parse(raw);
            } catch (e) { return null; }
        }

        function ageText(u) {
            const m = Math.round((Date.now() - u) / 60000);
            return m < 1 ? 'ahora' : (m + ' min');
        }
        function ageCls(u) {
            const m = Math.round((Date.now() - u) / 60000);
            return m > 60 ? 'stale' : 'ok';
        }

        function updateMeta() {
            const vol = loadVolume();
            const yard = loadYard();
            const lines = [];
            if (vol) {
                lines.push(`<span class="${ageCls(vol.updatedAt)}">Volumen Socrates: ${vol.total} camiones · hace ${ageText(vol.updatedAt)}</span>`);
            } else {
                lines.push(`<span class="err">⚠ Sin datos de Socrates. Abre Inbound Profile y pulsa ⟳.</span>`);
            }
            if (yard) {
                lines.push(`<span class="${ageCls(yard.updatedAt)}">Parkings: ${yard.total} libres · hace ${ageText(yard.updatedAt)}</span>`);
            } else {
                lines.push(`<span style="color:#888;">Parkings: sin datos (abre Yard Management y pulsa ⟳).</span>`);
            }
            metaEl.innerHTML = lines.join('');
            runBtn.disabled = !vol;
            return { vol, yard };
        }
        reloadBtn.addEventListener('click', updateMeta);

        // ====== Tabla context ======
        function findTableContext() {
            const refH = findHeaderByText('VRID/ISA #');
            const planH = findHeaderByText('Planned location');
            const accH  = findHeaderByText('Account');
            const timeH = findHeaderByText('Time');
            if (!refH || !planH) return { error: 'No encuentro columnas "VRID/ISA #" y "Planned location".' };
            const refRow = findRowAncestor(refH);
            const planRow = findRowAncestor(planH);
            if (!refRow || refRow !== planRow) return { error: 'No consigo localizar la fila de cabecera.' };
            const cells = getRowCells(refRow);
            const refIdx = cells.findIndex(c => c.contains(refH));
            const planIdx = cells.findIndex(c => c.contains(planH));
            const accIdx  = accH && refRow.contains(accH) ? cells.findIndex(c => c.contains(accH)) : -1;
            const timeIdx = timeH && refRow.contains(timeH) ? cells.findIndex(c => c.contains(timeH)) : -1;
            if (refIdx < 0 || planIdx < 0) return { error: 'No puedo determinar indices.' };
            const scope = findAncestor(refRow, n =>
                (n.getAttribute && ['table','grid'].includes(n.getAttribute('role'))) || n.tagName === 'TABLE'
            ) || refRow.parentElement?.parentElement || document.body;
            return { scope, refIdx, accIdx, timeIdx, planIdx, headerRow: refRow };
        }

        function getDataRows(ctx) {
            const allRows = ctx.scope.querySelectorAll('[role="row"], tr');
            const data = [];
            for (const row of allRows) {
                if (row === ctx.headerRow) continue;
                const cells = getRowCells(row);
                if (cells.length <= Math.max(ctx.refIdx, ctx.planIdx)) continue;
                const firstTxt = (cells[ctx.refIdx]?.textContent || '').trim();
                if (firstTxt === 'VRID/ISA #') continue;
                data.push({ row, cells });
            }
            return data;
        }

        // ====== Paginacion (copiado de outbound) ======
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
        function findAllPageElements() {
            const raw = [];
            const candidates = document.querySelectorAll('button, a, li, span, div, [role="button"], [role="link"]');
            for (const el of candidates) {
                const txt = (el.textContent || '').trim();
                const m = txt.match(/^(\d{1,3})$/);
                if (!m) continue;
                if (!isVisible(el)) continue;
                if (!isClickableElement(el)) continue;
                const inner = el.querySelector('button, a, [role="button"], [role="link"]');
                if (inner && (inner.textContent || '').trim() === txt) continue;
                raw.push({ el, page: parseInt(m[1], 10) });
            }
            raw.sort((a, b) => a.page - b.page);
            const byPage = new Map();
            for (const item of raw) if (!byPage.has(item.page)) byPage.set(item.page, item);
            return [...byPage.values()];
        }
        function isElActive(el) {
            if (!el) return false;
            if (el.getAttribute('aria-current')) return true;
            const cls = (el.className || '') + '';
            if (/\b(active|selected|current)\b/i.test(cls)) return true;
            const li = el.closest('li');
            if (li && /\b(active|selected|current)\b/i.test((li.className || '') + '')) return true;
            const p = el.parentElement;
            if (p && /\b(active|selected|current)\b/i.test((p.className || '') + '')) return true;
            return false;
        }
        function getActivePage() {
            const all = findAllPageElements();
            for (const { el, page } of all) if (isElActive(el)) return page;
            return null;
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
                const fpChanged = (prevFp !== null && curFp !== null && curFp !== prevFp);
                if (pageChanged && fpChanged) return true;
                if (pageChanged || fpChanged) { await sleep(500); return true; }
            }
            return false;
        }
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
        function findNextArrowButton() {
            for (const el of document.querySelectorAll('[aria-label]')) {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                if (/\b(next|siguiente)\b/.test(label) && !/prev|previous|anterior|first|last|primera|ultima/.test(label)) {
                    if (isVisible(el) && isClickableElement(el)) return el;
                }
            }
            const candidates = document.querySelectorAll('button, a, li, span, div, [role="button"]');
            const symbols = ['>', '›', '»', '❯', '→'];
            for (const el of candidates) {
                const txt = (el.textContent || '').trim();
                if (!symbols.includes(txt)) continue;
                if (!isVisible(el)) continue;
                if (!isClickableElement(el)) continue;
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                if (/last|ultima|ultimo/.test(label)) continue;
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
            const newPage = getActivePage();
            if (prevPage !== null && newPage !== null && newPage <= prevPage) return false;
            return true;
        }
        async function advanceToPage(targetPage) {
            const btn = findPageButton(targetPage);
            if (btn) return await goToPage(targetPage);
            const current = getActivePage();
            if (current === null) return false;
            let tries = 0;
            while (getActivePage() !== targetPage && tries < (targetPage - current + 3)) {
                const ok = await goToNextPageByArrow();
                if (!ok) return false;
                await sleep(400);
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

        // ====== ESTADO (stop/resume) ======
        const state = window.__bcn8InbState = window.__bcn8InbState || {
            running: false,
            stopRequested: false,
            assigned: [],      // VRID -> grupo (via Socrates)
            isaAssigned: [],   // ISA -> 100x
            accAssigned: [],   // Account -> DDs (TransfersCarts, ATSAMZLMissorts)
            psAssigned: [],    // Account -> PS libres
            unmatched: [],
            skipped: [],       // Fuera del filtro de horas
            processedPages: [],
            psPool: null,
            psPtr: 0,
            psRecycled: 0,
        };

        function resetState() {
            state.assigned = [];
            state.isaAssigned = [];
            state.accAssigned = [];
            state.psAssigned = [];
            state.unmatched = [];
            state.skipped = [];
            state.processedPages = [];
            state.psPool = null;
            state.psPtr = 0;
            state.psRecycled = 0;
        }

        function hasProgress() {
            return state.assigned.length + state.isaAssigned.length
                + state.accAssigned.length + state.psAssigned.length
                + state.unmatched.length + state.skipped.length > 0
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
                runBtn.textContent = 'Asignar muelles Inbound';
                runBtn.style.display = 'block';
                resumeBtn.style.display = 'none';
            }
        }

        async function run(mode = 'start') {
            if (state.running) return;
            state.running = true;
            state.stopRequested = false;

            // Anti-throttle: mantener la pestana activa aunque este en segundo plano
            window.__bcn8InbAntiThrottle?.start();

            if (mode === 'start') resetState();

            updateActionButtons();
            const { vol, yard } = updateMeta();
            if (!vol) {
                state.running = false;
                updateActionButtons();
                window.__bcn8InbAntiThrottle?.stop();
                return;
            }
            // Inicializar pool de parkings la primera vez
            if (state.psPool === null) {
                state.psPool = (yard?.list || []).slice();
                state.psPtr = 0;
                state.psRecycled = 0;
            }
            runBtn.classList.add('loading');
            progEl.style.display = 'block';

            const processedSet = new Set(state.processedPages);
            let startPage = mode === 'resume' && state.processedPages.length > 0
                ? Math.max(...state.processedPages) + 1
                : 1;

            const currentlyAt = getActivePage();
            if (currentlyAt !== null && currentlyAt !== startPage) {
                progEl.textContent = `Yendo a pagina ${startPage}...`;
                bodyEl.innerHTML = `<div class="bcn8-i-empty">Yendo a pagina ${startPage}...</div>`;
                const ok = await advanceToPage(startPage);
                if (!ok) {
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
                    state.unmatched.push({ ref: `Error en pagina ${currentPage}`, row: null, reason: ctx.error, page: currentPage });
                    break;
                }
                const rows = getDataRows(ctx);
                bodyEl.innerHTML = `<div class="bcn8-i-empty">Procesando pagina ${currentPage} · ${rows.length} filas...</div>`;
                progEl.textContent = `Pagina ${currentPage} · ${rows.length} filas`;

                // Deteccion de orden ascendente y corte temprano si filtro activo con "to"
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
                if (filterActive && filterRange.to !== null && pageIsAscending && validTimes.length > 0) {
                    const minOnPage = validTimes[0];
                    if (minOnPage > filterRange.to) {
                        progEl.textContent = `Pagina ${currentPage}: toda fuera de rango · termino aqui`;
                        state.processedPages.push(currentPage);
                        processedSet.add(currentPage);
                        break;
                    }
                }

                for (let idx = 0; idx < rows.length; idx++) {
                    if (state.stopRequested) break mainLoop;
                    const { row, cells } = rows[idx];
                    const refCell = cells[ctx.refIdx];
                    if (!refCell) continue;
                    const refIsISA = isISA(refCell);
                    const refClean = normalizeRef(refCell);
                    if (!refClean) continue;

                    const account = ctx.accIdx >= 0 && cells[ctx.accIdx]
                        ? (cells[ctx.accIdx].textContent || '').trim()
                        : '';

                    // Filtro de horas
                    let timeMin = null;
                    let timeStr = '';
                    if (ctx.timeIdx >= 0 && cells[ctx.timeIdx]) {
                        timeStr = (cells[ctx.timeIdx].textContent || '').trim().split(/[\n\r]+/)[0].trim();
                        timeMin = parseTimeToMinutes(timeStr);
                    }
                    if (filterActive) {
                        if (timeMin === null) {
                            state.skipped.push({ ref: refClean, account, row, reason: 'Hora no parseable', page: currentPage, time: timeStr, isISA: refIsISA });
                            continue;
                        }
                        if (!isInFilter(timeMin, filterRange)) {
                            state.skipped.push({ ref: refClean, account, row, reason: 'Fuera del rango', page: currentPage, time: timeStr, isISA: refIsISA });
                            continue;
                        }
                    }

                    const planCell = cells[ctx.planIdx];
                    const dropdowns = findDropdownsIn(planCell);
                    if (dropdowns.length === 0) {
                        state.unmatched.push({ ref: refClean, account, row, reason: 'Sin desplegables', page: currentPage, isISA: refIsISA, time: timeStr });
                        continue;
                    }

                    // ====== 0) Accounts FORZADOS a PS (prioridad maxima, antes de ISA y Socrates) ======
                    if (matchAccountInSet(account, PS_FORCED_ACCOUNTS)) {
                        if (!yard || state.psPool.length === 0) {
                            state.unmatched.push({ ref: refClean, account, row, reason: `Account ${account}: sin datos de parkings (abre Yard Management y pulsa ⟳)`, page: currentPage, isISA: refIsISA });
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
                        const entry = { ref: refClean, account, row, docks: picks, okCount, page: currentPage, source: 'PS', recycled };
                        if (okCount === 0) {
                            state.psPtr -= picks.length;
                            if (state.psPtr < 0) state.psPtr = 0;
                            state.unmatched.push({ ref: refClean, account, row, reason: `Account ${account}: sin match en desplegable (PS)`, page: currentPage });
                        } else state.psAssigned.push(entry);
                        continue;
                    }

                    // ====== 1) ISA -> 100x directo ======
                    if (refIsISA) {
                        const docks = GROUP_DOCKS['100x'];
                        let okCount = 0;
                        for (let i = 0; i < Math.min(dropdowns.length, docks.length); i++) {
                            const ok = await setDropdown(dropdowns[i], docks[i]);
                            if (ok) okCount++;
                            await sleep(120);
                        }
                        const entry = { ref: refClean, account, row, group: '100x', docks, okCount, page: currentPage, isISA: true };
                        if (okCount === 0) state.unmatched.push({ ref: refClean, account, row, reason: 'Sin match en desplegable (ISA 100x)', page: currentPage, isISA: true });
                        else state.isaAssigned.push(entry);
                        continue;
                    }

                    // ====== 2) VRID en Socrates -> grupo por volumen ======
                    let v = vol.map[refClean];
                    // Fallback: comparacion case-insensitive sobre las claves de Socrates
                    if (!v) {
                        const refUpper = refClean.toUpperCase();
                        for (const k of Object.keys(vol.map)) {
                            if (k.toUpperCase() === refUpper) { v = vol.map[k]; break; }
                        }
                    }
                    if (v) {
                        const dec = decideGroup(v);
                        const docks = GROUP_DOCKS[dec.group] || [];
                        if (docks.length === 0) {
                            state.unmatched.push({ ref: refClean, account, row, reason: `Grupo desconocido: ${dec.group}`, page: currentPage });
                            continue;
                        }
                        let okCount = 0;
                        for (let i = 0; i < Math.min(dropdowns.length, docks.length); i++) {
                            const ok = await setDropdown(dropdowns[i], docks[i]);
                            if (ok) okCount++;
                            await sleep(120);
                        }
                        const entry = { ref: refClean, account, row, group: dec.group, docks, okCount, page: currentPage, reason: dec.reason, volume: v };
                        if (okCount === 0) state.unmatched.push({ ref: refClean, account, row, reason: `Sin match en desplegable (${dec.group})`, page: currentPage });
                        else state.assigned.push(entry);
                        continue;
                    }

                    // ====== 3) Fallback: reglas por Account ======
                    const ruleMatch = matchAccountInRules(account, ACCOUNT_RULES);
                    const rule = ruleMatch ? ruleMatch.rule : null;
                    if (rule) {
                        if (rule.type === 'docks') {
                            const docks = rule.values;
                            let okCount = 0;
                            for (let i = 0; i < Math.min(dropdowns.length, docks.length); i++) {
                                const ok = await setDropdown(dropdowns[i], docks[i]);
                                if (ok) okCount++;
                                await sleep(120);
                            }
                            const entry = { ref: refClean, account, row, docks, okCount, page: currentPage, source: 'ACC' };
                            if (okCount === 0) state.unmatched.push({ ref: refClean, account, row, reason: `Sin match en desplegable (Account ${account})`, page: currentPage });
                            else state.accAssigned.push(entry);
                            continue;
                        }
                        if (rule.type === 'group') {
                            const grp = rule.values;
                            const docks = GROUP_DOCKS[grp] || [];
                            let okCount = 0;
                            for (let i = 0; i < Math.min(dropdowns.length, docks.length); i++) {
                                const ok = await setDropdown(dropdowns[i], docks[i]);
                                if (ok) okCount++;
                                await sleep(120);
                            }
                            const entry = { ref: refClean, account, row, group: grp, docks, okCount, page: currentPage, source: 'ACC' };
                            if (okCount === 0) state.unmatched.push({ ref: refClean, account, row, reason: `Sin match en desplegable (Account ${account} -> ${grp})`, page: currentPage });
                            else state.accAssigned.push(entry);
                            continue;
                        }
                        if (rule.type === 'mixed') {
                            // Rellena los primeros desplegables con los DDs fijos de rule.values
                            // y los huecos restantes con PS libres del pool.
                            // Ejemplo: TransfersCarts -> [DD-221, DD-224] + PS-XXX en el tercero.
                            const fixedDocks = rule.values || [];
                            const finalValues = [];
                            let recycledFlag = false;
                            const needed = dropdowns.length;

                            // Parte fija
                            for (let i = 0; i < fixedDocks.length && finalValues.length < needed; i++) {
                                finalValues.push(fixedDocks[i]);
                            }
                            // Parte PS (rellenar los huecos restantes)
                            const remaining = needed - finalValues.length;
                            if (remaining > 0) {
                                if (!yard || state.psPool.length === 0) {
                                    state.unmatched.push({ ref: refClean, account, row, reason: `Account ${account}: sin datos de parkings para completar (abre Yard Management y pulsa ⟳)`, page: currentPage });
                                    continue;
                                }
                                for (let i = 0; i < remaining; i++) {
                                    if (state.psPtr >= state.psPool.length) {
                                        state.psPtr = 0;
                                        state.psRecycled = (state.psRecycled || 0) + 1;
                                    }
                                    finalValues.push(state.psPool[state.psPtr]);
                                    if (state.psRecycled > 0) recycledFlag = true;
                                    state.psPtr++;
                                }
                            }

                            let okCount = 0;
                            for (let i = 0; i < finalValues.length; i++) {
                                const ok = await setDropdown(dropdowns[i], finalValues[i]);
                                if (ok) okCount++;
                                await sleep(120);
                            }
                            const entry = { ref: refClean, account, row, docks: finalValues, okCount, page: currentPage, source: 'ACC', recycled: recycledFlag };
                            if (okCount === 0) state.unmatched.push({ ref: refClean, account, row, reason: `Sin match en desplegable (Account ${account})`, page: currentPage });
                            else state.accAssigned.push(entry);
                            continue;
                        }
                        if (rule.type === 'ps') {
                            if (!yard || state.psPool.length === 0) {
                                state.unmatched.push({ ref: refClean, account, row, reason: `Account ${account}: sin datos de parkings (abre Yard Management y pulsa ⟳)`, page: currentPage });
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
                            const entry = { ref: refClean, account, row, docks: picks, okCount, page: currentPage, source: 'PS', recycled };
                            if (okCount === 0) {
                                state.psPtr -= picks.length;
                                if (state.psPtr < 0) state.psPtr = 0;
                                state.unmatched.push({ ref: refClean, account, row, reason: `Account ${account}: sin match en desplegable (PS)`, page: currentPage });
                            } else state.psAssigned.push(entry);
                            continue;
                        }
                    }

                    // ====== 4) Nada aplica ======
                    state.unmatched.push({
                        ref: refClean,
                        account,
                        row,
                        reason: account ? `VRID no encontrado (Account ${account} sin regla)` : 'VRID no encontrado en Socrates',
                        page: currentPage
                    });
                }

                state.processedPages.push(currentPage);
                processedSet.add(currentPage);

                if (state.stopRequested) break mainLoop;

                const nextPage = currentPage + 1;
                progEl.textContent = `Cambiando a pagina ${nextPage}...`;
                const advanced = await advanceToPage(nextPage);
                if (!advanced) break;
                await sleep(800);
                currentPage = getActivePage() || nextPage;
            }

            state.running = false;
            runBtn.classList.remove('loading');
            progEl.style.display = 'none';
            updateActionButtons();

            // Anti-throttle: ya no lo necesitamos
            window.__bcn8InbAntiThrottle?.stop();

            // ====== Diagnostico en consola ======
            // Si hay VRIDs no encontrados, listamos en consola para depurar.
            try {
                const notFound = state.unmatched
                    .filter(u => !u.isISA && /VRID no encontrado/i.test(u.reason || ''))
                    .map(u => u.ref);
                if (notFound.length > 0) {
                    console.log('[BCN8 Inb] VRIDs no encontrados en Socrates:', notFound);
                    const socKeys = Object.keys(vol.map);
                    console.log('[BCN8 Inb] VRIDs disponibles en Socrates (' + socKeys.length + '):', socKeys);
                    // Para cada no encontrado, buscar el mas parecido en Socrates
                    for (const ref of notFound) {
                        const close = socKeys.filter(k =>
                            k.includes(ref) || ref.includes(k) ||
                            k.toUpperCase().includes(ref.toUpperCase().slice(0, 6))
                        );
                        if (close.length > 0) {
                            console.log(`[BCN8 Inb]  Posibles coincidencias para "${ref}":`, close);
                        }
                    }
                }
            } catch (e) { console.warn('[BCN8 Inb] diagnostico:', e); }

            renderResults();
        }

        function renderResults() {
            const { assigned, isaAssigned, accAssigned, psAssigned, unmatched, skipped } = state;

            const renderItem = (item, kind, i) => {
                const badgePg = item.page ? `<span class="bcn8-i-badge pg">P${item.page}</span>` : '';
                const badgeHr = item.time ? `<span class="bcn8-i-badge hr">${escapeHtml(item.time)}</span>` : '';
                let badgeSrc = '';
                if (kind === 'sk') badgeSrc = `<span class="bcn8-i-badge skip">⏭</span>`;
                else if (item.isISA) badgeSrc = `<span class="bcn8-i-badge isa">ISA</span>`;
                else if (kind === 'acc') badgeSrc = `<span class="bcn8-i-badge acc">${item.group || 'ACC'}</span>`;
                else if (kind === 'ps')  badgeSrc = `<span class="bcn8-i-badge ps">PS${item.recycled ? ' ♻' : ''}</span>`;
                else if (item.group)     badgeSrc = `<span class="bcn8-i-badge grp">${item.group}</span>`;

                const accTag = item.account ? `<span style="color:#666;font-size:10px;">[${escapeHtml(item.account)}]</span> ` : '';
                const sub = (() => {
                    if (kind === 'un') return `${accTag}${escapeHtml(item.reason || '')}`;
                    if (kind === 'sk') return `${accTag}${escapeHtml(item.reason || '')}`;
                    if (kind === 'isa') return `100x · ${item.docks.join(', ')}`;
                    if (kind === 'acc') return `${accTag}${item.docks.join(', ')}`;
                    if (kind === 'ps')  return `${accTag}${item.docks.join(', ')}`;
                    return `${item.docks.join(', ')}${item.reason ? ' · ' + escapeHtml(item.reason) : ''}`;
                })();
                const cls = kind === 'un' ? 'unmatched'
                          : kind === 'sk' ? 'skipped'
                          : kind === 'isa' ? 'isa'
                          : kind === 'acc' ? 'acc'
                          : kind === 'ps'  ? 'ps'
                          : 'ok';
                return `
                    <div class="bcn8-i-item ${cls}">
                        <div>
                            <div class="bcn8-i-item-name">${badgePg}${badgeHr}${badgeSrc}${escapeHtml(item.ref)}</div>
                            <div class="bcn8-i-item-info">${sub}</div>
                        </div>
                        <button class="bcn8-i-goto" data-kind="${kind}" data-idx="${i}">Ir</button>
                    </div>`;
            };

            const parts = [];
            if (state.processedPages.length > 0) {
                const pgs = [...state.processedPages].sort((a,b) => a-b).join(', ');
                parts.push(`<div class="bcn8-i-section" style="font-size:11px;color:#555;">Paginas procesadas: ${pgs}</div>`);
            }
            if (unmatched.length > 0) {
                parts.push(`<div class="bcn8-i-section"><div class="bcn8-i-section-title">⚠ No encontrados (${unmatched.length})</div>${unmatched.map((u,i) => renderItem(u,'un',i)).join('')}</div>`);
            }
            if (isaAssigned.length > 0) {
                parts.push(`<div class="bcn8-i-section"><div class="bcn8-i-section-title">✓ ISA → 100x (${isaAssigned.length})</div>${isaAssigned.map((a,i) => renderItem(a,'isa',i)).join('')}</div>`);
            }
            if (accAssigned.length > 0) {
                parts.push(`<div class="bcn8-i-section"><div class="bcn8-i-section-title">✓ Por Account → DDs (${accAssigned.length})</div>${accAssigned.map((a,i) => renderItem(a,'acc',i)).join('')}</div>`);
            }
            if (psAssigned.length > 0) {
                parts.push(`<div class="bcn8-i-section"><div class="bcn8-i-section-title">✓ Por Account → Parking (${psAssigned.length})</div>${psAssigned.map((a,i) => renderItem(a,'ps',i)).join('')}</div>`);
            }
            parts.push(`<div class="bcn8-i-section"><div class="bcn8-i-section-title">✓ Asignados (${assigned.length})</div>${assigned.length === 0 ? `<div class="bcn8-i-empty">-</div>` : assigned.map((a,i) => renderItem(a,'ok',i)).join('')}</div>`);
            if (skipped.length > 0) {
                parts.push(`<div class="bcn8-i-section"><div class="bcn8-i-section-title">⏭ Fuera de horario (${skipped.length})</div>${skipped.map((s,i) => renderItem(s,'sk',i)).join('')}</div>`);
            }

            bodyEl.innerHTML = parts.join('');

            bodyEl.querySelectorAll('.bcn8-i-goto').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const kind = btn.getAttribute('data-kind');
                    const i = parseInt(btn.getAttribute('data-idx'), 10);
                    const src = kind === 'un' ? state.unmatched
                              : kind === 'sk' ? state.skipped
                              : kind === 'isa' ? state.isaAssigned
                              : kind === 'acc' ? state.accAssigned
                              : kind === 'ps'  ? state.psAssigned
                              : state.assigned;
                    const item = src[i];
                    if (!item) return;
                    if (item.row && document.body.contains(item.row)) { flashRow(item.row); return; }
                    if (item.page) {
                        progEl.style.display = 'block';
                        progEl.textContent = `Navegando a pagina ${item.page}...`;
                        await goToPage(item.page);
                        await sleep(500);
                        progEl.style.display = 'none';
                        const ctx = findTableContext();
                        if (!ctx.error) {
                            const rows = getDataRows(ctx);
                            for (const { row } of rows) {
                                if ((row.textContent || '').includes(item.ref)) {
                                    flashRow(row);
                                    return;
                                }
                            }
                        }
                    }
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

        setTimeout(() => { updateMeta(); updateActionButtons(); }, 800);
        setInterval(updateMeta, 30000);

        // ====== Auto-asignacion Inbound ======
        // Antes de ejecutar, valida que los datos de Socrates y Yard sean recientes.
        // Si no lo son, salta el ciclo y reintenta en 5 minutos.
        const MAX_DATA_AGE_HOURS = 2;
        function dataIsFreshEnough() {
            const vol = loadVolume();
            const yard = loadYard();
            const issues = [];
            const ageH = (ts) => ts ? (Date.now() - ts) / 3600000 : Infinity;
            if (!vol) issues.push('Socrates sin datos');
            else if (ageH(vol.updatedAt) > MAX_DATA_AGE_HOURS) issues.push(`Socrates (${ageH(vol.updatedAt).toFixed(1)}h)`);
            if (!yard) issues.push('Yard sin datos');
            else if (ageH(yard.updatedAt) > MAX_DATA_AGE_HOURS) issues.push(`Yard (${ageH(yard.updatedAt).toFixed(1)}h)`);
            return { ok: issues.length === 0, issues };
        }

        const inbAuto = attachAutoRefresh({
            container: panel,
            storageKey: 'bcn8inb-arr-auto',
            label: 'Auto-asignar Inbound',
            defaultMinutes: 180, // 3 horas por defecto
            minMinutes: 30,
            maxMinutes: 720,
            action: async () => {
                if (state.running) {
                    console.warn('[BCN8 Inb Auto] Otra ejecucion en curso, salto');
                    return;
                }
                const fresh = dataIsFreshEnough();
                if (!fresh.ok) {
                    console.warn('[BCN8 Inb Auto] Datos no frescos:', fresh.issues.join(', '), '· reintenta en 5 min');
                    setTimeout(() => {
                        if (inbAuto.isEnabled() && !state.running) {
                            const f2 = dataIsFreshEnough();
                            if (f2.ok) {
                                console.log('[BCN8 Inb Auto] Reintento: datos OK, ejecutando');
                                inbAuto.triggerNow();
                            } else {
                                console.warn('[BCN8 Inb Auto] Reintento: aun no hay datos frescos');
                            }
                        }
                    }, 5 * 60000);
                    return;
                }
                console.log('[BCN8 Inb Auto] Datos OK, ejecutando run(start)');
                await run('start');
            },
            cssPrefix: 'bcn8i',
            activateAntiThrottle: true,
        });
    }
})();
