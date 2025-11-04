// api/finanzas.js
import supaAdmin from '../lib/supaAdmin.js';

// ==== helpers comunes ====
const norm = (s = '') =>
    s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();

const tipoDePeriodo = (p) => {
    const per = norm(p.periodo || '');
    const tipoRaw = norm(p.tipo || '');
    if (per === 'INS') return 'INSCRIPCION';
    if (tipoRaw === 'INSCRIPCION' || tipoRaw === 'INS') return 'INSCRIPCION';
    return 'COLEGIATURA';
};

function getAction(req) {
    const url = new URL(req.url, 'http://localhost');
    return (url.searchParams.get('action') || '').toLowerCase();
}

// ==== NUEVO: inicio de cobro por alumno (YYYY-MM-01) basado en vigencia_desde de COLEGIATURA ====
function inicioCobroAlumno(alumnoId, cicloStart /* 'YYYY-MM-DD' */, byAlumno) {
    const listaCol = (byAlumno[alumnoId]?.['COLEGIATURA']) || [];
    const vs = listaCol
        .map(x => String(x.vigencia_desde || '').slice(0, 10))
        .filter(Boolean)
        .sort(); // ASC

    // Si hay una vigencia dentro o después del inicio del ciclo, usa la más temprana de esas;
    // si no, usa la más temprana en general; si no hay, cae al inicio del ciclo.
    const cand = vs.find(v => v >= cicloStart) || vs[0] || cicloStart;
    return (cand || cicloStart).slice(0, 7) + '-01';
}

// ==== /api/finanzas?action=deudores ====
async function h_deudores(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const cicloStr = String(req.query.ciclo || '').trim();
    if (!cicloStr) return res.status(400).json({ error: 'Falta ciclo' });

    try {
        // ciclo y calendario
        const { data: cicloRow } = await supaAdmin
            .from('ciclos')
            .select('id, fecha_inicio')
            .eq('ciclo', cicloStr)
            .single();
        if (!cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;
        const cicloStart = cicloRow.fecha_inicio;

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

        // Precio vigente "a hoy" (mantenemos tu lógica actual)
        const importeVigente = (al, concepto, hoyStr) => {
            const lista = (byAlumno[al.id]?.[concepto]) || [];
            if (!lista.length) return 0;
            const vigente = lista.find(x => x.vigencia_desde <= hoyStr) || lista[0];
            return Number(vigente.importe_base || 0);
        };

        // pagos de inscripción (no por periodo)
        const { data: pagos } = await supaAdmin
            .from('pagos')
            .select('alumno_id, tipo_de_pago, monto_total');
        const pagadoIns = new Map();
        (pagos || []).forEach(p => {
            if (norm(p.tipo_de_pago || '') === 'INSCRIPCION') {
                const k = p.alumno_id;
                pagadoIns.set(k, (pagadoIns.get(k) || 0) + Number(p.monto_total || 0));
            }
        });

        // aplicaciones por periodo (colegiaturas)
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

            // === NUEVO: filtrar vencidos por inicio de cobro del alumno
            const inicio = inicioCobroAlumno(a.id, cicloStart, byAlumno);
            const vencidosFiltrados = (vencidos || []).filter(p => {
                const t = tipoDePeriodo(p);
                if (t === 'INSCRIPCION') return true; // INS no se corta
                const fv = String(p.fecha_vencimiento || '').slice(0, 10);
                return fv && fv >= inicio; // COLEGIATURA solo desde su inicio real
            });

            let deuda = 0;
            const conceptos = [];

            // INS contra pagos
            if (hayINSvencido && ins > 0) {
                const pag = Number(pagadoIns.get(a.id) || 0);
                const saldo = Math.max(0, +(ins - pag).toFixed(2));
                if (saldo > 0) { deuda += saldo; conceptos.push('INS'); }
            }

            // Colegiaturas por periodo vencido (ya filtrados)
            for (const p of (vencidosFiltrados || [])) {
                if (tipoDePeriodo(p) !== 'COLEGIATURA') continue;
                const esperado = col * Number(p.multiplicador || 1);
                const abono = Number(pagadoCol.get(a.id + '|' + p.periodo) || 0);
                const saldo = Math.max(0, +(esperado - abono).toFixed(2));
                if (saldo > 0) { deuda += saldo; conceptos.push(p.periodo); }
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

// ==== /api/finanzas?action=overview ====
async function h_overview(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const cicloStr = String(req.query.ciclo || '').trim();
    if (!cicloStr) return res.status(400).json({ error: 'Falta ciclo' });

    try {
        // ciclo + calendario
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos')
            .select('id, fecha_inicio')
            .eq('ciclo', cicloStr)
            .single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;
        const cicloStart = cicloRow.fecha_inicio;

        const { data: cal, error: eCal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, fecha_vencimiento, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });
        if (eCal) throw eCal;

        const hoy = new Date().toISOString().slice(0, 10);
        const vencidos = (cal || []).filter(p => p.fecha_vencimiento && p.fecha_vencimiento <= hoy);

        // alumnos
        const { data: alumnos, error: eA } = await supaAdmin
            .from('alumnos').select('id, nombre_completo, nivel, grado');
        if (eA) throw eA;
        const alumnoIds = (alumnos || []).map(a => a.id);

        // precios
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

        // precio vigente "a hoy"
        const importeVigente = (al, concepto, hoyStr) => {
            const lista = (byAlumno[al.id]?.[concepto]) || [];
            if (!lista.length) return 0;
            const vigente = lista.find(x => x.vigencia_desde <= hoyStr) || lista[0];
            return Number(vigente.importe_base || 0);
        };

        // aplicaciones (colegiaturas) por periodo
        const { data: apps, error: eApps } = await supaAdmin
            .from('pago_aplicaciones')
            .select('alumno_id, periodo, monto_aplicado')
            .eq('ciclo_id', ciclo_id);
        if (eApps) throw eApps;

        const pagadoPeriodo = new Map();
        (apps || []).forEach(a => {
            const k = a.alumno_id + '|' + a.periodo;
            pagadoPeriodo.set(k, (pagadoPeriodo.get(k) || 0) + Number(a.monto_aplicado || 0));
        });

        // pagos de inscripción
        const { data: pagos, error: ePag } = await supaAdmin
            .from('pagos')
            .select('alumno_id, tipo_de_pago, monto_total');
        if (ePag) throw ePag;

        const pagadoInscripcion = new Map();
        (pagos || []).forEach(p => {
            if (norm(p.tipo_de_pago || '') === 'INSCRIPCION') {
                const k = p.alumno_id;
                pagadoInscripcion.set(k, (pagadoInscripcion.get(k) || 0) + Number(p.monto_total || 0));
            }
        });

        // agregados
        let totalDeuda = 0;
        const deudaPorNivel = {};
        const deudaPorPeriodo = {};
        const alumnoDeuda = new Map();

        const tieneINSvencido = vencidos.some(p => norm(p.periodo) === 'INS');

        for (const al of (alumnos || [])) {
            const importeCol = importeVigente(al, 'COLEGIATURA', hoy);
            const importeIns = importeVigente(al, 'INSCRIPCION', hoy);

            // === NUEVO: filtrar vencidos por inicio de cobro del alumno
            const inicio = inicioCobroAlumno(al.id, cicloStart, byAlumno);
            const vencidosFiltrados = (vencidos || []).filter(p => {
                const t = tipoDePeriodo(p);
                if (t === 'INSCRIPCION') return true; // INS no se corta
                const fv = String(p.fecha_vencimiento || '').slice(0, 10);
                return fv && fv >= inicio; // COLEGIATURA solo desde su inicio real
            });

            // a) inscripción
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

            // b) colegiaturas
            for (const p of (vencidosFiltrados || [])) {
                if (tipoDePeriodo(p) !== 'COLEGIATURA') continue;
                const mult = Number(p.multiplicador || 1);
                const esperado = importeCol * mult; // (Opcional: puedes usar precio por fecha del periodo)
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

// ==== router ====
export default async function handler(req, res) {
    try {
        const action = getAction(req);
        switch (action) {
            case 'deudores': return h_deudores(req, res);
            case 'overview': return h_overview(req, res);
            default: return res.status(404).json({ error: 'Acción no soportada' });
        }
    } catch (e) {
        console.error('[finanzas/*] Error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
