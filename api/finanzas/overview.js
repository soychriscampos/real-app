// /api/finanzas/overview.js
import supaAdmin from '../../lib/supaAdmin.js';

// Normaliza removiendo tildes y mayúsculas
const norm = (s = '') => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();

// Para calendario: si el periodo es INS, trátalo como INSCRIPCION
function tipoDePeriodo(p) {
    const per = norm(p.periodo || '');
    const tipoRaw = norm(p.tipo || '');
    if (per === 'INS') return 'INSCRIPCION';
    if (tipoRaw === 'INSCRIPCION' || tipoRaw === 'INS') return 'INSCRIPCION';
    return 'COLEGIATURA';
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const cicloStr = String(req.query.ciclo || '').trim();
    if (!cicloStr) return res.status(400).json({ error: 'Falta ciclo' });

    try {
        // 1) Ciclo y calendario
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos').select('id').eq('ciclo', cicloStr).single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;

        const { data: cal, error: eCal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, fecha_vencimiento, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });
        if (eCal) throw eCal;

        const hoy = new Date().toISOString().slice(0, 10);
        const vencidos = (cal || []).filter(p => p.fecha_vencimiento && p.fecha_vencimiento <= hoy);

        // 2) Alumnos
        const { data: alumnos, error: eA } = await supaAdmin
            .from('alumnos').select('id, nombre_completo, nivel, grado');
        if (eA) throw eA;
        const alumnoIds = (alumnos || []).map(a => a.id);

        // 3) Precios personalizados (tomamos COLEGIATURA e INSCRIPCION)
        const { data: precios } = await supaAdmin
            .from('precios_alumno')
            .select('alumno_id, concepto, vigencia_desde, importe_base')
            .in('alumno_id', alumnoIds)
            .order('vigencia_desde', { ascending: false });

        const byAlumno = {};
        (precios || []).forEach(r => {
            const c = norm(r.concepto || '');
            if (c !== 'COLEGIATURA' && c !== 'INSCRIPCION') return;
            (byAlumno[r.alumno_id] ||= { COLEGIATURA: [], INSCRIPCION: [] })[c].push(r);
        });

        const importeVigente = (al, concepto /*'COLEGIATURA'|'INSCRIPCION'*/, hoyStr) => {
            const lista = (byAlumno[al.id]?.[concepto]) || [];
            if (!lista.length) return 0; // si no hay precio, 0 (tu regla: insc no tiene base global)
            const vigente = lista.find(x => x.vigencia_desde <= hoyStr) || lista[0];
            return Number(vigente.importe_base || 0);
        };

        // 4) Pagos aplicados por periodo (para colegiaturas) desde pago_aplicaciones
        const { data: apps, error: eApps } = await supaAdmin
            .from('pago_aplicaciones')
            .select('alumno_id, periodo, monto_aplicado')
            .eq('ciclo_id', ciclo_id);
        if (eApps) throw eApps;

        const pagadoPeriodo = new Map(); // key: alumno|periodo -> sum
        (apps || []).forEach(a => {
            const k = a.alumno_id + '|' + a.periodo;
            pagadoPeriodo.set(k, (pagadoPeriodo.get(k) || 0) + Number(a.monto_aplicado || 0));
        });

        // 5) Pagos de INSCRIPCION desde pagos(tipo_de_pago, monto_total)
        const { data: pagos, error: ePag } = await supaAdmin
            .from('pagos')
            .select('alumno_id, tipo_de_pago, monto_total'); // agrega fecha si luego filtras por rango
        if (ePag) throw ePag;

        const pagadoInscripcion = new Map(); // key: alumno_id -> sum pagos de inscripción
        (pagos || []).forEach(p => {
            const tipo = norm(p.tipo_de_pago || '');
            if (tipo === 'INSCRIPCION') {
                const k = p.alumno_id;
                pagadoInscripcion.set(k, (pagadoInscripcion.get(k) || 0) + Number(p.monto_total || 0));
            }
        });

        // 6) Cálculos
        let totalDeuda = 0;
        const deudaPorNivel = {};
        const deudaPorPeriodo = {};
        const alumnoDeuda = new Map();

        for (const al of (alumnos || [])) {
            const importeCol = importeVigente(al, 'COLEGIATURA', hoy);
            const importeIns = importeVigente(al, 'INSCRIPCION', hoy);

            // a) INSCRIPCION (no depende del calendario por multiplicadores, sólo vencimiento del periodo INS)
            const tieneINSvencido = vencidos.some(p => norm(p.periodo) === 'INS');
            if (tieneINSvencido && importeIns > 0) {
                const pagadoIns = Number(pagadoInscripcion.get(al.id) || 0);
                const saldoIns = Math.max(0, +(importeIns - pagadoIns).toFixed(2));
                if (saldoIns > 0) {
                    totalDeuda += saldoIns;
                    deudaPorNivel[al.nivel] = (deudaPorNivel[al.nivel] || 0) + saldoIns;
                    deudaPorPeriodo['INS'] = (deudaPorPeriodo['INS'] || 0) + saldoIns;
                    alumnoDeuda.set(al.id, (alumnoDeuda.get(al.id) || 0) + saldoIns);
                }
            }

            // b) COLEGIATURAS por periodos vencidos (no INS)
            for (const p of (vencidos || [])) {
                const tipo = tipoDePeriodo(p);
                if (tipo !== 'COLEGIATURA') continue; // saltar INS aquí, ya lo contamos arriba
                const mult = Number(p.multiplicador || 1);
                const esperado = importeCol * mult;

                const key = al.id + '|' + p.periodo;
                const pagado = Number(pagadoPeriodo.get(key) || 0);
                const saldo = Math.max(0, +(esperado - pagado).toFixed(2));

                if (saldo > 0) {
                    totalDeuda += saldo;
                    deudaPorNivel[al.nivel] = (deudaPorNivel[al.nivel] || 0) + saldo;
                    deudaPorPeriodo[p.periodo] = (deudaPorPeriodo[p.periodo] || 0) + saldo;
                    alumnoDeuda.set(al.id, (alumnoDeuda.get(al.id) || 0) + saldo);
                }
            }
        }

        const por_nivel = Object.entries(deudaPorNivel)
            .map(([nivel, monto]) => ({ nivel, monto: +monto.toFixed(2) }))
            .sort((a, b) => a.nivel.localeCompare(b.nivel, 'es'));

        // arma por_periodo respetando orden del calendario (si existe)
        const orden = (cal || []).map(p => p.periodo);
        const por_periodo_obj = Object.assign({}, deudaPorPeriodo);
        const por_periodo = orden
            .filter(per => per in por_periodo_obj)
            .map(per => ({ periodo: per, monto: +por_periodo_obj[per].toFixed(2) }));

        return res.status(200).json({
            fecha_corte: hoy,
            periodos_vencidos: (vencidos || []).map(p => p.periodo),
            total_deuda: +totalDeuda.toFixed(2),
            alumnos_con_deuda: Array.from(alumnoDeuda.keys()).length,
            por_nivel,
            por_periodo
        });
    } catch (e) {
        console.error('[finanzas/overview] Error:', e);
        return res.status(500).json({ error: 'Error en overview' });
    }
}
