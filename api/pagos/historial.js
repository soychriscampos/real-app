// /api/pagos/historial.js
import supaAdmin from '../../lib/supaAdmin.js';
import { requireViewAlumno } from '../../lib/authz.js'; // ⬅️ nuevo

export default async function handler(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const alumno_id = (req.query.alumno_id || req.query.id || '').trim();
    const ciclo = (req.query.ciclo || '').trim();
    if (!alumno_id || !ciclo)
        return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    // === Pre-check de permisos (STAFF o PARENT con vínculo) ===
    const s = await requireViewAlumno(req, res, alumno_id);
    if (!s) return;

    try {
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos').select('id').eq('ciclo', ciclo).single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;

        const { data, error } = await supaAdmin
            .from('pagos')
            .select('fecha_pago, monto_total, tipo_de_pago, metodo_de_pago, recibio, observaciones')
            .eq('alumno_id', alumno_id)
            .eq('ciclo_id', ciclo_id)
            .order('fecha_pago', { ascending: false })
            .limit(200);

        if (error) throw error;

        const out = (data || []).map(p => ({
            fecha_pago: p.fecha_pago, // 'YYYY-MM-DD'
            monto_total: Number(p.monto_total || 0),
            tipo_de_pago: p.tipo_de_pago || null,
            metodo_de_pago: p.metodo_de_pago || null,
            recibio: p.recibio || null,
            observaciones: p.observaciones || null
        }));

        return res.status(200).json(out);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'No se pudo obtener el historial de pagos' });
    }
}
