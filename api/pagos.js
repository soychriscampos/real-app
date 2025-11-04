// api/pagos.js
import supaAdmin from '../lib/supaAdmin.js';
import { requireViewAlumno } from '../lib/authz.js';
import { getSession } from '../lib/session.js'; // por si más adelante decides validar STAFF para "registrar"

// ===== helpers comunes =====
function getAction(req) {
    const url = new URL(req.url, 'http://localhost');
    return (url.searchParams.get('action') || '').toLowerCase();
}
async function readJson(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { return raw ? JSON.parse(raw) : {}; }
    catch {
        const params = new URLSearchParams(raw);
        return Object.fromEntries(params.entries());
    }
}

// ===== GET /api/pagos/historial?alumno_id=&ciclo= =====
async function h_historial(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const alumno_id = (req.query.alumno_id || req.query.id || '').trim();
    const ciclo = (req.query.ciclo || '').trim();
    if (!alumno_id || !ciclo)
        return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    // Permisos: STAFF o PARENT vinculado
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
        console.error('[pagos/historial] Error:', e);
        return res.status(500).json({ error: 'No se pudo obtener el historial de pagos' });
    }
}

// ===== POST /api/pagos/registrar =====
async function h_registrar(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    // (Opcional) Si quieres limitar a STAFF, descomenta:
    // const sess = getSession(req);
    // if (!sess || !['ADMIN','SUBADMIN','CAJA','STAFF'].includes(String(sess.type||'').toUpperCase())) {
    //   return res.status(403).json({ error: 'No autorizado' });
    // }

    const body = await readJson(req);
    const {
        alumno_id,
        ciclo,                 // requerido
        fecha_pago,            // 'YYYY-MM-DD'
        monto_total,
        tipo_de_pago,          // 'Colegiatura' | 'Inscripción' | 'Otro'
        metodo_de_pago,
        recibio,
        observaciones,
        origen = 'UI',
        modo = 'fifo',         // (fifo | manual)
        periodo_unico = null,  // modo=manual
        aplicaciones = []      // modo=manual: [{periodo,monto}]
    } = body;

    if (!alumno_id || !ciclo) return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    const soloFecha = String(fecha_pago || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(soloFecha)) {
        return res.status(400).json({ error: 'Fecha inválida (usa YYYY-MM-DD)' });
    }

    const montoNum = Number(monto_total || 0);
    if (!(montoNum > 0)) return res.status(400).json({ error: 'Monto inválido' });

    try {
        // 1) ciclo_id
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos').select('id, fecha_inicio, fecha_fin').eq('ciclo', ciclo).single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;

        // 2) Insert en pagos
        const pagoRow = {
            alumno_id,
            ciclo_id,
            fecha_pago: soloFecha,
            monto_total: montoNum,
            tipo_de_pago: tipo_de_pago || null, // puede llegar 'Inscripción' con tilde
            metodo_de_pago: metodo_de_pago || null,
            recibio: recibio || null,
            observaciones: observaciones || null,
            origen
        };

        const { data: pagoIns, error: eP } = await supaAdmin
            .from('pagos')
            .insert([pagoRow])
            .select('id')
            .single();
        if (eP) return res.status(400).json({ error: eP.message });

        const pago_id = pagoIns?.id || null;

        // 3) Determinar aplicaciones (sólo colegiaturas)
        const { data: cal, error: eCal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });
        if (eCal) throw eCal;
        const calPeriods = (cal || []).map(r => r.periodo);

        const tipoUp = String(tipo_de_pago || '').toUpperCase();
        const esIns = (tipoUp === 'INSCRIPCIÓN' || tipoUp === 'INSCRIPCION');

        let apps = [];
        if (!esIns) {
            if (modo === 'manual') {
                if (periodo_unico) {
                    if (!calPeriods.includes(periodo_unico)) {
                        return res.status(400).json({ error: `Periodo inválido: ${periodo_unico}` });
                    }
                    apps = [{ periodo: periodo_unico, monto: montoNum }];
                } else {
                    const cleaned = (aplicaciones || [])
                        .map(a => ({ periodo: String(a.periodo || ''), monto: Number(a.monto || 0) }))
                        .filter(a => a.monto > 0 && a.periodo);

                    for (const a of cleaned) {
                        if (!calPeriods.includes(a.periodo)) {
                            return res.status(400).json({ error: `Periodo inválido en aplicaciones: ${a.periodo}` });
                        }
                    }
                    const suma = cleaned.reduce((s, a) => s + a.monto, 0);
                    if (+suma.toFixed(2) !== +montoNum.toFixed(2)) {
                        return res.status(400).json({ error: 'La suma de aplicaciones manuales no coincide con el monto total' });
                    }
                    apps = cleaned;
                }
            } else {
                // FIFO
                const today = new Date().toISOString().slice(0, 10);

                const [{ data: precios }, { data: alum }] = await Promise.all([
                    supaAdmin.from('precios_alumno')
                        .select('concepto, vigencia_desde, importe_base')
                        .eq('alumno_id', alumno_id)
                        .order('vigencia_desde', { ascending: false }),
                    supaAdmin.from('alumnos').select('nivel').eq('id', alumno_id).single()
                ]);

                let colegiatura = 0;
                const soloCol = (precios || []).filter(r => (r.concepto || '').toUpperCase() === 'COLEGIATURA');
                if (soloCol.length) {
                    const vigente = soloCol.find(r => r.vigencia_desde <= today) || soloCol[0];
                    colegiatura = Number(vigente.importe_base || 0);
                }
                if (!colegiatura) {
                    const { data: params } = await supaAdmin.from('parametros').select('parametro,valor');
                    const map = {}; (params || []).forEach(p => (map[p.parametro] = p.valor));
                    const nivel = (alum?.nivel || '').toLowerCase();
                    if (nivel === 'preescolar') colegiatura = Number(map['colegiatura_base_pre'] || 0);
                    if (nivel === 'primaria') colegiatura = Number(map['colegiatura_base_pri'] || 0);
                }

                const { data: appsPrev } = await supaAdmin
                    .from('pago_aplicaciones')
                    .select('periodo, monto_aplicado')
                    .eq('alumno_id', alumno_id)
                    .eq('ciclo_id', ciclo_id);

                const pagado = {};
                (appsPrev || []).forEach(a => {
                    pagado[a.periodo] = (pagado[a.periodo] || 0) + Number(a.monto_aplicado || 0);
                });

                const pendientes = (cal || []).map(p => {
                    const tipo = (p.tipo || '').toUpperCase();
                    const mult = Number(p.multiplicador || 1);
                    const imp = (tipo === 'COLEGIATURA') ? (colegiatura * mult) : 0;
                    const pa = Number(pagado[p.periodo] || 0);
                    const saldo = Math.max(0, +(imp - pa).toFixed(2));
                    return { periodo: p.periodo, saldo, orden: p.orden };
                }).filter(x => x.saldo > 0);

                let restante = montoNum;
                for (const per of pendientes) {
                    if (restante <= 0) break;
                    const aplicar = Math.min(restante, per.saldo);
                    if (aplicar > 0) {
                        apps.push({ periodo: per.periodo, monto: +aplicar.toFixed(2) });
                        restante = +(restante - aplicar).toFixed(2);
                    }
                }
            }
        }

        // 4) Insert en pago_aplicaciones (solo si no es “Inscripción”)
        if (apps.length) {
            const appRows = apps.map(a => ({
                alumno_id,
                pago_id,
                ciclo_id,
                periodo: a.periodo,
                monto_aplicado: Number(a.monto)
            }));
            const { error: eA } = await supaAdmin.from('pago_aplicaciones').insert(appRows);
            if (eA) {
                if (pago_id) await supaAdmin.from('pagos').delete().eq('id', pago_id);
                return res.status(400).json({ error: eA.message });
            }
        }

        return res.status(201).json({ ok: true, pago_id, aplicaciones: apps });
    } catch (e) {
        console.error('[pagos/registrar] Error:', e);
        return res.status(500).json({ error: 'No se pudo registrar el pago' });
    }
}

// ===== GET /api/pagos/summary?alumno_id=&ciclo= =====
async function h_summary(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const alumno_id = (req.query.alumno_id || '').trim();
    const cicloStr = (req.query.ciclo || '').trim();
    if (!alumno_id || !cicloStr)
        return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    // Permisos: STAFF o PARENT vinculado
    const s = await requireViewAlumno(req, res, alumno_id);
    if (!s) return;

    try {
        const { data: cicloRow, error: eCiclo } = await supaAdmin
            .from('ciclos')
            .select('id, fecha_inicio, fecha_fin')
            .eq('ciclo', cicloStr)
            .single();
        if (eCiclo || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });

        const ciclo_id = cicloRow.id;
        const fecha_inicio_ciclo = cicloRow.fecha_inicio;
        const fecha_fin_ciclo = cicloRow.fecha_fin;
        const hoy = new Date().toISOString().slice(0, 10);

        const { data: cal, error: eCal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, fecha_vencimiento, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });
        if (eCal) throw eCal;

        const { data: precios, error: ePre } = await supaAdmin
            .from('precios_alumno')
            .select('concepto, vigencia_desde, importe_base')
            .eq('alumno_id', alumno_id)
            .order('vigencia_desde', { ascending: false });
        if (ePre) throw ePre;

        // Colegiatura vigente o base por nivel
        let colegiatura = null;
        if (precios?.length) {
            const soloCol = precios.filter(r => (r.concepto || '').toUpperCase() === 'COLEGIATURA');
            if (soloCol.length) {
                const hoyS = new Date().toISOString().slice(0, 10);
                const vigente = soloCol.find(r => r.vigencia_desde <= hoyS) || soloCol[0];
                colegiatura = Number(vigente.importe_base || 0);
            }
        }
        if (colegiatura === null || colegiatura === undefined) {
            const [{ data: alum, error: eAlum }, { data: params, error: ePar }] = await Promise.all([
                supaAdmin.from('alumnos').select('nivel').eq('id', alumno_id).single(),
                supaAdmin.from('parametros').select('parametro,valor')
            ]);
            if (eAlum) throw eAlum;
            if (ePar) throw ePar;
            const map = {}; (params || []).forEach(p => (map[p.parametro] = p.valor));
            const nivel = (alum?.nivel || '').toLowerCase();
            if (nivel === 'preescolar') colegiatura = Number(map['colegiatura_base_pre'] || 0);
            if (nivel === 'primaria') colegiatura = Number(map['colegiatura_base_pri'] || 0);
            if (!Number.isFinite(colegiatura)) colegiatura = 0;
        }

        // Precio de INSCRIPCION vigente dentro del ciclo
        let inscripcion_importe = 0;
        if (precios?.length) {
            const soloIns = precios
                .filter(r => (r.concepto || '').toUpperCase() === 'INSCRIPCION')
                .filter(r => r.vigencia_desde <= fecha_fin_ciclo)
                .sort((a, b) => (a.vigencia_desde < b.vigencia_desde ? 1 : -1));
            if (soloIns.length) inscripcion_importe = Number(soloIns[0].importe_base || 0);
        }

        const { data: apps, error: eApps } = await supaAdmin
            .from('pago_aplicaciones')
            .select('periodo, monto_aplicado')
            .eq('alumno_id', alumno_id)
            .eq('ciclo_id', ciclo_id);
        if (eApps) throw eApps;

        const pagadoPorPeriodo = {};
        (apps || []).forEach(a => {
            const k = a.periodo;
            pagadoPorPeriodo[k] = (pagadoPorPeriodo[k] || 0) + Number(a.monto_aplicado || 0);
        });

        // Pagos de inscripción (tabla pagos)
        let inscripcion_pagado = 0;
        if (inscripcion_importe > 0) {
            const { data: pagosIns, error: ePI } = await supaAdmin
                .from('pagos')
                .select('monto_total')
                .eq('alumno_id', alumno_id)
                .eq('ciclo_id', ciclo_id)
                .eq('tipo_de_pago', 'Inscripción');
            if (ePI) throw ePI;
            inscripcion_pagado = +((pagosIns || []).reduce((s, p) => s + Number(p.monto_total || 0), 0)).toFixed(2);
        }

        // === NUEVO: determinar "inicio_cobro" desde vigencia_desde (solo COLEGIATURA)
        let inicio_cobro = fecha_inicio_ciclo; // fallback = inicio del ciclo
        const vigs = (precios || [])
            .filter(r => String(r.concepto || '').toUpperCase() === 'COLEGIATURA')
            .map(r => String(r.vigencia_desde || '').slice(0, 10))
            .filter(Boolean)
            .sort(); // ASC
        const cand = vigs.find(v => v >= fecha_inicio_ciclo);
        if (cand) inicio_cobro = cand;
        // normalizar a primer día del mes
        inicio_cobro = inicio_cobro.slice(0, 7) + '-01';

        // === NUEVO: calendario filtrado
        // - Mantiene SIEMPRE INSCRIPCION (si existe en calendario)
        // - Filtra COLEGIATURA a partir de inicio_cobro
        const calFiltrado = (cal || []).filter(p => {
            const tipoUp = String(p.tipo || '').toUpperCase();
            const fv = String(p.fecha_vencimiento || '').slice(0, 10);
            if (!fv) return false;
            if (tipoUp === 'INSCRIPCION') return true; // no se corta
            if (tipoUp === 'COLEGIATURA') return fv >= inicio_cobro;
            return true; // otros tipos (si los hubiera), déjalos pasar
        });

        // Armar detalle por calendario (incluye INS)
        const detalle = (calFiltrado || []).map(p => {
            const periodoUp = (p.periodo || '').toUpperCase();
            const tipoUp = (p.tipo || '').toUpperCase();
            const mult = Number(p.multiplicador || 1);

            const esIns = periodoUp === 'INS' || tipoUp === 'INSCRIPCION';
            let importe = 0, pagado = 0;

            if (esIns) {
                importe = +Number(inscripcion_importe).toFixed(2);
                pagado = +Number(inscripcion_pagado).toFixed(2);
            } else if (tipoUp === 'COLEGIATURA') {
                importe = +Number(Number(colegiatura) * mult).toFixed(2);
                pagado = +Number(pagadoPorPeriodo[p.periodo] || 0).toFixed(2);
            } else {
                importe = 0;
                pagado = +Number(pagadoPorPeriodo[p.periodo] || 0).toFixed(2);
            }

            const saldo = Math.max(0, +(importe - pagado).toFixed(2));
            return {
                periodo: p.periodo,
                tipo: p.tipo,
                multiplicador: mult,
                fecha_vencimiento: p.fecha_vencimiento || (esIns ? fecha_inicio_ciclo : null),
                importe,
                pagado,
                saldo
            };
        });

        // Adeudo solo con lo vencido
        const adeudo = +(detalle
            .filter(d => d.fecha_vencimiento && d.fecha_vencimiento <= hoy)
            .reduce((s, d) => s + (d.saldo || 0), 0)
        ).toFixed(2);
        const estatus = adeudo > 0 ? 'Pendiente' : 'Al corriente';

        // === NUEVO: “Desglose del Periodo” visible
        //  - Vencidos (<= hoy)
        //  - Mes actual (aunque no esté vencido)
        //  - Futuros con pago aplicado (pagado > 0)
        const yyyymm = s => (s ? s.slice(0, 7) : null);
        const detalleVisible = detalle
            .filter(d => {
                if (!d.fecha_vencimiento) return false;
                const fv = d.fecha_vencimiento;
                return (fv <= hoy) || (yyyymm(fv) === yyyymm(hoy)) || (d.pagado > 0);
            })
            .sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)));

        // Adelantos (solo colegiatura a futuro) usando el calendario ya filtrado
        let adelanto_monto = 0;
        let adelanto_periodos = 0;
        for (const p of (calFiltrado || [])) {
            if (!p.fecha_vencimiento || p.fecha_vencimiento <= hoy) continue;
            const tipoUp = (p.tipo || '').toUpperCase();
            if (tipoUp !== 'COLEGIATURA') continue;

            const mult = Number(p.multiplicador || 1);
            const importe = Number(colegiatura) * mult;
            const aplicado = Number(pagadoPorPeriodo[p.periodo] || 0);
            if (aplicado > 0) {
                if (+aplicado.toFixed(2) >= +importe.toFixed(2)) adelanto_periodos++;
                adelanto_monto += Math.min(aplicado, importe);
            }
        }
        const adelanto = { monto: +adelanto_monto.toFixed(2), periodos: adelanto_periodos };

        return res.status(200).json({ estatus, adeudo, detalle: detalleVisible, adelanto });

    } catch (e) {
        console.error('[pagos/summary] Error:', e);
        return res.status(500).json({ error: 'No se pudo calcular el resumen' });
    }
}


// ===== Router =====
export default async function handler(req, res) {
    try {
        const action = getAction(req);
        switch (action) {
            case 'historial': return h_historial(req, res);
            case 'registrar': return h_registrar(req, res);
            case 'summary': return h_summary(req, res);
            default: return res.status(404).json({ error: 'Acción no soportada' });
        }
    } catch (e) {
        console.error('[pagos/*] Error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
