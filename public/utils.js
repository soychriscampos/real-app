// /utils.js

// Normaliza a número (acepta string con $ y comas)
window.toNumber = function toNumber(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[^0-9.-]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
};

// Formato MXN con miles: $5,700.00, $102,500.00
window.fmtMXN = function fmtMXN(v) {
    const n = toNumber(v);
    return new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(n);
};

// Autoaplica formato a elementos marcados
//  - clase .money   → toma el textContent y lo reemplaza formateado
//  - [data-currency] → usa data-value si existe, si no el textContent
window.applyCurrency = function applyCurrency(root = document) {
    // .money
    root.querySelectorAll('.money').forEach(el => {
        el.textContent = fmtMXN(el.textContent);
    });
    // [data-currency]
    root.querySelectorAll('[data-currency]').forEach(el => {
        const raw = el.dataset.value ?? el.textContent;
        el.textContent = fmtMXN(raw);
    });
};

// Ejecuta al cargar la página y también cuando cambien nodos
document.addEventListener('DOMContentLoaded', () => applyCurrency());
