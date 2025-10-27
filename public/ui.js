const ui = {};
ui.getJSON = async (url) => { const r = await fetch(url); if (!r.ok) { if (r.status === 401) location.href = '/public/index.html'; throw new Error('HTTP ' + r.status); } return r.json(); };
ui.logout = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/public/index.html'; };
ui.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); } };
ui.dt = s => new Date(s).toLocaleString();
ui.getParam = async (name) => {
    const rows = await ui.getJSON('/api/param?keys=' + encodeURIComponent(name)); // endpoint simple para leer parametros
    return rows?.[name];
};

ui.formatDate = function (iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}-${m}-${y.slice(2)}`;
};
window.ui = ui;

