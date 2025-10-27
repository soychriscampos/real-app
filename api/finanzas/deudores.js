// /api/finanzas/deudores.js
import supaAdmin from '../../lib/supaAdmin.js';

const norm = (s = '') => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const tipoDePeriodo = (p) => (norm(p.periodo) === 'INS' ? 'INSCRIPCION'
    : (['INSCRIPCION', 'INS'].includes(norm(p.tipo || '')) ? 'INSCRIPCION' : 'COLEGIATURA'));

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const cicloStr = String(req.query.ciclo || '').trim();
    if (!cicloStr) return res.status(400).json({ error: 'Falta ciclo' });

    try {
        // ciclo y calendario
        const { data: cicloRow } = await supaAdmin.from('ciclos').select('id').eq('ciclo', cicloStr).single();
        if (!cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;

        const { data: cal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, fecha_vencimiento, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });

        const hoy = new Date().toISOString().slice(0, 10);
        const vencidos = (cal || []).filter(p => p.fecha_vencimiento && p.fecha_vencimiento <= hoy);

        // alumnos
        const { data: alumnos } = await supaAdmin
            .from('alumnos').select('id, nombre_completo, nivel, grado');
        const ids = (alumnos || []).map(a => a.id);

        // precios alumno (colegiatura e inscripción)
        const { data: precios } = await supaAdmin
            .from('precios_alumno')
            .select('alumno_id, concepto, vigencia_desde, importe_base')
            .in('alumno_id', ids)
            .order('vigencia_desde', { ascending: false });

        const byAlumno = {};
        (precios || []).forEach(r => {
            const c = norm(r.concepto || '');
            if (c !== 'COLEGIATURA' && c !== 'INSCRIPCION') return;
            (byAlumno[r.alumno_id] ||= { COLEGIATURA: [], INSCRIPCION: [] })[c].push(r);
        });

        const importeVigente = (al, concepto, hoyStr) => {
            const lista = (byAlumno[al.id]?.[concepto]) || [];
            if (!lista.length) return 0;
            const vigente = lista.find(x => x.vigencia_desde <= hoyStr) || lista[0];
            return Number(vigente.importe_base || 0);
        };

        // pagos: inscripciones por alumno
        const { data: pagos } = await supaAdmin
            .from('pagos')
            .select('alumno_id, tipo_de_pago, monto_total'); // añade fecha si filtras luego
        const pagadoIns = new Map();
        (pagos || []).forEach(p => {
            if (norm(p.tipo_de_pago || '') === 'INSCRIPCION') {
                const k = p.alumno_id;
                pagadoIns.set(k, (pagadoIns.get(k) || 0) + Number(p.monto_total || 0));
            }
        });

        // pagos aplicados en colegiaturas por periodo
        const { data: apps } = await supaAdmin
            .from('pago_aplicaciones')
            .select('alumno_id, periodo, monto_aplicado')
            .eq('ciclo_id', ciclo_id);
        const pagadoCol = new Map(); // key alumno|periodo
        (apps || []).forEach(a => {
            const k = a.alumno_id + '|' + a.periodo;
            pagadoCol.set(k, (pagadoCol.get(k) || 0) + Number(a.monto_aplicado || 0));
        });

        const rows = [];
        const hayINSvencido = vencidos.some(p => norm(p.periodo) === 'INS');

        for (const a of (alumnos || [])) {
            const col = importeVigente(a, 'COLEGIATURA', hoy);
            const ins = importeVigente(a, 'INSCRIPCION', hoy);

            let deuda = 0;
            const conceptos = [];

            // INS: contra pagos (no aplicaciones)
            if (hayINSvencido && ins > 0) {
                const pag = Number(pagadoIns.get(a.id) || 0);
                const saldo = Math.max(0, +(ins - pag).toFixed(2));
                if (saldo > 0) {
                    deuda += saldo;
                    conceptos.push('INS');
                }
            }

            // Colegiaturas: por periodo vencido
            for (const p of (vencidos || [])) {
                if (tipoDePeriodo(p) !== 'COLEGIATURA') continue;
                const esperado = col * Number(p.multiplicador || 1);
                const abono = Number(pagadoCol.get(a.id + '|' + p.periodo) || 0);
                const saldo = Math.max(0, +(esperado - abono).toFixed(2));
                if (saldo > 0) {
                    deuda += saldo;
                    conceptos.push(p.periodo);
                }
            }

            if (deuda > 0) {
                rows.push({
                    id: a.id,
                    nombre: a.nombre_completo,
                    nivel: a.nivel,
                    grado: a.grado,
                    conceptos: conceptos.join(', '),
                    cantidad: +deuda.toFixed(2)
                });
            }
        }

        rows.sort((x, y) => y.cantidad - x.cantidad);

        return res.status(200).json({
            fecha_corte: hoy,
            periodos_vencidos: (vencidos || []).map(p => p.periodo),
            total: rows.length,
            deudores: rows
        });
    } catch (e) {
        console.error('[finanzas/deudores] Error:', e);
        return res.status(500).json({ error: 'Error en deudores' });
    }
}
