// api/padres/hijos.js
import supaAdmin from '../../lib/supaAdmin.js';
import { getSession } from '../../lib/session.js';

export default async function handler(req, res) {
    try {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        const s = getSession(req);
        if (!s) return res.status(401).json({ error: 'No autorizado' });
        if ((s.type || '').toUpperCase() !== 'PARENT') return res.status(403).json({ error: 'No autorizado' });

        const tutorId = s.sub;
        if (!tutorId) return res.status(400).json({ error: 'Falta tutor_id en la sesión' });

        // Busca alumnos relacionados al tutor_id
        const { data, error } = await supaAdmin
            .from('alumno_contacto')
            .select(`
        alumno_id,
        prioridad,
        alumnos:alumno_id ( id, nombre_completo, nivel, grado )
      `)
            .eq('tutor_id', tutorId)
            .order('prioridad', { ascending: true });

        if (error) return res.status(500).json({ error: 'Error obteniendo alumnos' });

        const rows = (data || [])
            .map(r => ({
                id: r.alumnos?.id || r.alumno_id,
                nombre_completo: r.alumnos?.nombre_completo || '',
                nivel: r.alumnos?.nivel || '',
                grado: r.alumnos?.grado ?? null,
                prioridad: r.prioridad ?? null
            }))
            // orden secundario estable
            .sort((a, b) => {
                const pri = (a.prioridad ?? 999) - (b.prioridad ?? 999);
                if (pri !== 0) return pri;
                const n1 = String(a.nivel || ''), n2 = String(b.nivel || '');
                if (n1 !== n2) return n1.localeCompare(n2, 'es');
                const g1 = Number(a.grado || 0), g2 = Number(b.grado || 0);
                if (g1 !== g2) return g1 - g2;
                return String(a.nombre_completo || '').localeCompare(String(b.nombre_completo || ''), 'es');
            });

        return res.status(200).json(rows);
    } catch (e) {
        console.error('[padres/hijos] error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
