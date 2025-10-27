// api/pagos/aplicaciones.js
import supaAdmin from '../../lib/supaAdmin.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const alumno_id = (req.query.alumno_id || '').trim();
    const ciclo = (req.query.ciclo || '').trim();
    if (!alumno_id || !ciclo) return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    try {
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos').select('id').eq('ciclo', ciclo).single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;

        const { data, error } = await supaAdmin
            .from('pago_aplicaciones')
            .select(`
        periodo,
        monto_aplicado,
        pagos:pagos!inner(fecha_pago, metodo_de_pago)
      `)
            .eq('alumno_id', alumno_id)
            .eq('ciclo_id', ciclo_id)
            .order('pagos.fecha_pago', { ascending: false });

        if (error) throw error;

        const out = (data || []).map(r => ({
            periodo: r.periodo,
            monto_aplicado: Number(r.monto_aplicado || 0),
            fecha_pago: r.pagos?.fecha_pago || null,     // 'YYYY-MM-DD' si cambiaste a DATE
            metodo_de_pago: r.pagos?.metodo_de_pago || null
        }));

        return res.status(200).json(out);
    } catch (e) {
        console.error('[pagos/aplicaciones] Error:', e);
        return res.status(500).json({ error: 'No se pudieron obtener aplicaciones' });
    }
}
