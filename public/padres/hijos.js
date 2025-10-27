// /api/padres/hijos.js
import supaAdmin from '../../lib/supaAdmin.js';
import { getSession } from '../../lib/session.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'No autorizado' });

    const role = (s.type || '').toUpperCase();
    if (role !== 'PARENT') return res.status(403).json({ error: 'Solo padres pueden listar sus hijos' });

    try {
        // 1) vínculos tutor -> alumno
        const { data: links, error: e1 } = await supaAdmin
            .from('alumno_contacto')
            .select('alumno_id, prioridad')
            .eq('tutor_id', s.sub);
        if (e1) throw e1;

        const ids = [...new Set((links || []).map(r => r.alumno_id))];
        if (ids.length === 0) return res.status(200).json([]);

        // 2) alumnos: solo las columnas necesarias
        const { data: alumnos, error: e2 } = await supaAdmin
            .from('alumnos')
            .select('id, nombre_completo, nivel, grado')
            .in('id', ids);
        if (e2) throw e2;

        // Orden por prioridad, luego nombre
        const prio = new Map((links || []).map(l => [l.alumno_id, l.prioridad ?? 999]));
        const out = (alumnos || []).slice().sort((a, b) => {
            const pa = prio.get(a.id) ?? 999, pb = prio.get(b.id) ?? 999;
            if (pa !== pb) return pa - pb;
            return (a.nombre_completo || '').localeCompare(b.nombre_completo || '');
        });

        return res.status(200).json(out);
    } catch (e) {
        console.error('[padres/hijos] Error:', e);
        return res.status(500).json({ error: 'No se pudo obtener la lista de alumnos' });
    }
}
