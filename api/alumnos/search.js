// /api/alumnos/search.js
import supaAdmin from '../../lib/supaAdmin.js';

function normalizeNoAccents(s = '') {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.status(200).json([]);

        const norm = normalizeNoAccents(q);

        const { data, error } = await supaAdmin
            .from('alumnos_busqueda') // <- la vista
            .select('id, nombre_completo, nivel, grado')
            .ilike('nombre_idx', `%${norm}%`)
            .order('nombre_completo', { ascending: true })
            .limit(12);

        if (error) throw error;
        return res.status(200).json(data || []);
    } catch (e) {
        console.error('[alumnos/search] Error:', e);
        return res.status(500).json({ error: 'Error buscando alumnos' });
    }
}
