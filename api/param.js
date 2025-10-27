// api/param.js
import supaAdmin from '../lib/supaAdmin.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    const keys = (req.query.keys || '').split(',').map(s => s.trim()).filter(Boolean);
    const q = supaAdmin.from('parametros').select('parametro, valor');
    const { data, error } = await (keys.length ? q.in('parametro', keys) : q);
    if (error) return res.status(500).json({ error: error.message });
    const out = {}; (data || []).forEach(r => out[r.parametro] = r.valor);
    res.json(out);
}
