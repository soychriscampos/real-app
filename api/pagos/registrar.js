// api/pagos/registrar.js
import supaAdmin from '../../lib/supaAdmin.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const body = req.body || {};
    const {
        alumno_id,
        ciclo,                 // << requerido (el front ya lo manda con /api/param?keys=ciclo_actual)
        fecha_pago,            // 'YYYY-MM-DD' (DATE puro)
        monto_total,
        tipo_de_pago,          // 'Colegiatura' | 'Inscripción' | 'Otro'
        metodo_de_pago,
        recibio,
        observaciones,
        origen = 'UI',
        modo = 'fifo',         // (fifo | manual)
        periodo_unico = null,  // para modo=manual (aplicar todo a un periodo)
        aplicaciones = []      // para modo=manual (lista {periodo,monto})
    } = body;

    if (!alumno_id || !ciclo) return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    // Validar fecha como 'YYYY-MM-DD'
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

        // 2) Insert en pagos (fecha_pago es DATE)
        const pagoRow = {
            alumno_id,
            ciclo_id,
            fecha_pago: soloFecha,
            monto_total: montoNum,
            tipo_de_pago: tipo_de_pago || null,   //  aquí llega 'Inscripción' con tilde
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

        // 3) Determinar aplicaciones por periodo (para colegiatura)
        const { data: cal, error: eCal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });
        if (eCal) throw eCal;
        const calPeriods = (cal || []).map(r => r.periodo);

        let apps = [];

        // Para tipo_de_pago = 'Inscripción' NO aplicamos a periodos de colegiatura
        // (la inscripción se refleja en summary por tipo_de_pago de la tabla pagos)
        const tipoUp = String(tipo_de_pago || '').toUpperCase();
        const esIns = (tipoUp === 'INSCRIPCIÓN' || tipoUp === 'INSCRIPCION');

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
                // FIFO (solo para colegiaturas)
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
                (appsPrev || []).forEach(a => { pagado[a.periodo] = (pagado[a.periodo] || 0) + Number(a.monto_aplicado || 0); });

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
                        restante = + (restante - aplicar).toFixed(2);
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
        console.error(e);
        return res.status(500).json({ error: 'No se pudo registrar el pago' });
    }
}
