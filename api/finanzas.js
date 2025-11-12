// api/finanzas.js
import supaAdmin from '../lib/supaAdmin.js';
import { getSession } from '../lib/session.js';

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

const RECEIVER_LABELS = {
    CHRISTIAN: 'Christian',
    FRAN: 'Fran'
};

function classifyRecibio(nombre) {
    const raw = (nombre || '').trim();
    const normalized = norm(raw);
    if (normalized.includes('CHRISTIAN')) return { key: 'CHRISTIAN', label: RECEIVER_LABELS.CHRISTIAN };
    if (normalized.includes('FRAN')) return { key: 'FRAN', label: RECEIVER_LABELS.FRAN };
    if (!normalized) return { key: 'OTROS', label: 'Otros' };
    return { key: normalized, label: raw || 'Otros' };
}

function classifyMetodo(metodo) {
    const raw = (metodo || '').trim();
    if (!raw) return { key: 'SIN_METODO', label: 'Sin método' };
    const label = raw.charAt(0).toUpperCase() + raw.slice(1);
    return { key: norm(raw) || 'SIN_METODO', label };
}

const monthFmt = new Intl.DateTimeFormat('es-MX', { month: 'short', year: 'numeric' });
function monthLabel(ym) {
    if (!ym) return '';
    const date = new Date(ym + '-01T00:00:00');
    if (Number.isNaN(date.getTime())) return ym;
    return monthFmt.format(date);
}

const tipoLabels = {
    COLEGIATURA: 'Colegiatura',
    INSCRIPCION: 'Inscripción'
};

function humanTipo(key) {
    return tipoLabels[key] || key || '—';
}

function ymCompare(a, b) {
    return a.localeCompare(b);
}

function monthsBetween(startYm, endYm) {
    const out = [];
    if (!startYm || !endYm) return out;
    const startDate = new Date(startYm + '-01T00:00:00');
    const endDate = new Date(endYm + '-01T00:00:00');
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return out;
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
        out.push(cursor.toISOString().slice(0, 7));
        cursor.setMonth(cursor.getMonth() + 1);
    }
    return out;
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

function creditoPrevioAlumno(alumnoId, inicio, pagadoPorPeriodo, calendario) {
    let total = 0;
    for (const p of (calendario || [])) {
        if (tipoDePeriodo(p) !== 'COLEGIATURA') continue;
        const fv = String(p.fecha_vencimiento || '').slice(0, 10);
        if (!fv || fv >= inicio) continue;
        const key = alumnoId + '|' + p.periodo;
        total += Number(pagadoPorPeriodo.get(key) || 0);
    }
    return +total.toFixed(2);
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
            let creditoPrevio = creditoPrevioAlumno(a.id, inicio, pagadoCol, cal);

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
                let abono = Number(pagadoCol.get(a.id + '|' + p.periodo) || 0);
                if (abono < esperado && creditoPrevio > 0) {
                    const faltante = Math.max(0, +(esperado - abono).toFixed(2));
                    const uso = Math.min(faltante, creditoPrevio);
                    abono = +(abono + uso).toFixed(2);
                    creditoPrevio = +(creditoPrevio - uso).toFixed(2);
                }
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

            let creditoPrevio = creditoPrevioAlumno(al.id, inicio, pagadoPeriodo, cal);

            // b) colegiaturas
            for (const p of (vencidosFiltrados || [])) {
                if (tipoDePeriodo(p) !== 'COLEGIATURA') continue;
                const mult = Number(p.multiplicador || 1);
                const esperado = importeCol * mult; // (Opcional: puedes usar precio por fecha del periodo)
                const key = al.id + '|' + p.periodo;
                let pagado = Number(pagadoPeriodo.get(key) || 0);
                if (pagado < esperado && creditoPrevio > 0) {
                    const faltante = Math.max(0, +(esperado - pagado).toFixed(2));
                    const uso = Math.min(faltante, creditoPrevio);
                    pagado = +(pagado + uso).toFixed(2);
                    creditoPrevio = +(creditoPrevio - uso).toFixed(2);
                }
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

// ==== /api/finanzas?action=ingresos ====
async function h_ingresos(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const cicloStr = String(req.query.ciclo || '').trim();
    if (!cicloStr) return res.status(400).json({ error: 'Falta ciclo' });

    const sess = getSession(req);
    const type = (sess?.type || '').toUpperCase();
    if (type !== 'ADMIN') {
        return res.status(403).json({ error: 'Solo ADMIN puede consultar ingresos' });
    }

    try {
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos')
            .select('id, fecha_inicio')
            .eq('ciclo', cicloStr)
            .single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;
        const fechaInicio = String(cicloRow.fecha_inicio || '').slice(0, 10);

        const { data: pagos, error } = await supaAdmin
            .from('pagos')
            .select('fecha_pago, monto_total, tipo_de_pago, metodo_de_pago, recibio')
            .eq('ciclo_id', ciclo_id)
            .order('fecha_pago', { ascending: true });
        if (error) throw error;

        const dayMap = new Map();
        const recTotals = new Map();
        const metodoTotals = new Map();
        const monthTotals = new Map();
        const recibioLabels = new Map(Object.entries(RECEIVER_LABELS));
        const metodoLabels = new Map([['SIN_METODO', 'Sin método']]);
        const preInicioByRec = new Map();

        let totalMonto = 0;
        let totalPagos = 0;
        let preInicioTotal = 0;
        let preInicioColegiaturas = 0;

        const ensurePreRec = (rec) => {
            if (!preInicioByRec.has(rec.key)) {
                preInicioByRec.set(rec.key, {
                    key: rec.key,
                    label: rec.label,
                    total: 0,
                    tipos: new Map()
                });
            }
            return preInicioByRec.get(rec.key);
        };

        for (const pago of (pagos || [])) {
            const tipo = norm(pago.tipo_de_pago || '');
            let tipoKey = null;
            if (!tipo) tipoKey = 'COLEGIATURA';
            else if (tipo === 'INSCRIPCION') tipoKey = 'INSCRIPCION';
            else if (tipo === 'COLEGIATURA') tipoKey = 'COLEGIATURA';

            const fecha = String(pago.fecha_pago || '').slice(0, 10);
            if (!fecha) continue;

            const monto = Number(pago.monto_total || 0);
            if (!(monto > 0)) continue;

            const rec = classifyRecibio(pago.recibio);
            const met = classifyMetodo(pago.metodo_de_pago);
            recibioLabels.set(rec.key, rec.label);
            metodoLabels.set(met.key, met.label);

            if (fechaInicio && fecha < fechaInicio) {
                if (!tipoKey) continue;
                const info = ensurePreRec(rec);
                info.total += monto;
                info.tipos.set(tipoKey, (info.tipos.get(tipoKey) || 0) + monto);
                preInicioTotal += monto;
                if (tipoKey === 'COLEGIATURA') {
                    preInicioColegiaturas += monto;
                }
                continue;
            }

            if (tipoKey && tipoKey !== 'COLEGIATURA') continue;
            if (!tipoKey) continue;

            totalMonto += monto;
            totalPagos += 1;

            recTotals.set(rec.key, (recTotals.get(rec.key) || 0) + monto);
            metodoTotals.set(met.key, (metodoTotals.get(met.key) || 0) + monto);

            const monthKey = fecha.slice(0, 7);
            monthTotals.set(monthKey, (monthTotals.get(monthKey) || 0) + monto);

            const entry = dayMap.get(fecha) || { fecha, total: 0, pagos: 0, recibio: {}, metodos: {} };
            entry.total += monto;
            entry.pagos += 1;
            entry.recibio[rec.key] = (entry.recibio[rec.key] || 0) + monto;
            entry.metodos[met.key] = (entry.metodos[met.key] || 0) + monto;
            dayMap.set(fecha, entry);
        }

        const listFromMap = (m, labels) => Array.from(m.entries())
            .map(([key, val]) => ({
                key,
                label: labels.get(key) || key,
                monto: +val.toFixed(2)
            }))
            .sort((a, b) => b.monto - a.monto);

        const por_dia = Array.from(dayMap.values())
            .sort((a, b) => b.fecha.localeCompare(a.fecha))
            .map(d => ({
                fecha: d.fecha,
                total: +d.total.toFixed(2),
                pagos: d.pagos,
                recibio: Object.entries(d.recibio)
                    .map(([key, val]) => ({
                        key,
                        label: recibioLabels.get(key) || key,
                        monto: +val.toFixed(2)
                    }))
                    .sort((a, b) => b.monto - a.monto),
                metodos: Object.entries(d.metodos)
                    .map(([key, val]) => ({
                        key,
                        label: metodoLabels.get(key) || key,
                        monto: +val.toFixed(2)
                    }))
                    .sort((a, b) => b.monto - a.monto)
            }));

        let por_mes = Array.from(monthTotals.entries())
            .sort((a, b) => ymCompare(a[0], b[0]))
            .map(([key, val]) => ({
                mes: key,
                label: monthLabel(key),
                total: +val.toFixed(2)
            }));

        if (fechaInicio) {
            const startYm = fechaInicio.slice(0, 7);
            const dataMonths = Array.from(monthTotals.keys()).sort(ymCompare);
            const latestData = dataMonths[dataMonths.length - 1] || startYm;
            const todayYm = new Date().toISOString().slice(0, 7);
            const endYm = [latestData, todayYm].filter(Boolean).sort(ymCompare).pop();
            const monthSeq = monthsBetween(startYm, endYm);
            const seqSeries = monthSeq.map(key => ({
                mes: key,
                label: monthLabel(key),
                total: +Number(monthTotals.get(key) || 0).toFixed(2)
            }));
            por_mes = [{
                mes: 'PREVIO',
                label: 'Antes inicio',
                total: +preInicioColegiaturas.toFixed(2)
            }, ...seqSeries];
        }

        const ordenRec = (key) => key === 'CHRISTIAN' ? 0 : key === 'FRAN' ? 1 : 2;
        const pre_ciclo = {
            fecha_limite: fechaInicio,
            total: +preInicioTotal.toFixed(2),
            por_recibio: Array.from(preInicioByRec.values())
                .sort((a, b) => ordenRec(a.key) - ordenRec(b.key) || a.label.localeCompare(b.label, 'es'))
                .map(item => ({
                    key: item.key,
                    label: item.label,
                    total: +item.total.toFixed(2),
                    tipos: Array.from(item.tipos.entries())
                        .map(([tipoKey, monto]) => ({
                            key: tipoKey,
                            label: humanTipo(tipoKey),
                            monto: +monto.toFixed(2)
                        }))
                        .sort((a, b) => (a.key === 'COLEGIATURA' ? 0 : 1) - (b.key === 'COLEGIATURA' ? 0 : 1))
                }))
        };

        return res.status(200).json({
            ciclo: cicloStr,
            fecha_inicio: fechaInicio,
            total_general: +totalMonto.toFixed(2),
            total_pagos: totalPagos,
            resumen_recibio: listFromMap(recTotals, recibioLabels),
            resumen_metodo: listFromMap(metodoTotals, metodoLabels),
            por_dia,
            por_mes,
            pre_ciclo
        });
    } catch (e) {
        console.error('[finanzas/ingresos] Error:', e);
        return res.status(500).json({ error: 'Error al obtener ingresos' });
    }
}

// ==== router ====
export default async function handler(req, res) {
    try {
        const action = getAction(req);
        switch (action) {
            case 'deudores': return h_deudores(req, res);
            case 'overview': return h_overview(req, res);
            case 'ingresos': return h_ingresos(req, res);
            default: return res.status(404).json({ error: 'Acción no soportada' });
        }
    } catch (e) {
        console.error('[finanzas/*] Error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
