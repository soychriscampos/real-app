// /api/pagos/summary.js
import supaAdmin from '../../lib/supaAdmin.js';
import { requireViewAlumno } from '../../lib/authz.js'; // ⬅️ nuevo

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    const alumno_id = (req.query.alumno_id || '').trim();
    const cicloStr = (req.query.ciclo || '').trim();
    if (!alumno_id || !cicloStr) {
        return res.status(400).json({ error: 'Falta alumno_id o ciclo' });
    }

    // === Pre-check de permisos (STAFF o PARENT con vínculo) ===
    const s = await requireViewAlumno(req, res, alumno_id);
    if (!s) return;

    try {
        // --- Ciclo
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

        // --- Calendario (incluye INS)
        const { data: cal, error: eCal } = await supaAdmin
            .from('calendario_ciclo')
            .select('periodo, tipo, multiplicador, fecha_vencimiento, orden')
            .eq('ciclo_id', ciclo_id)
            .order('orden', { ascending: true });
        if (eCal) throw eCal;

        // --- Precios personalizados
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
                const hoy = new Date().toISOString().slice(0, 10);
                const vigente = soloCol.find(r => r.vigencia_desde <= hoy) || soloCol[0];
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

        // Precio de INSCRIPCION vigente para el ciclo (permite vigencia antes del inicio)
        let inscripcion_importe = 0;
        if (precios?.length) {
            const soloIns = precios
                .filter(r => (r.concepto || '').toUpperCase() === 'INSCRIPCION')
                .filter(r => r.vigencia_desde <= fecha_fin_ciclo)
                .sort((a, b) => (a.vigencia_desde < b.vigencia_desde ? 1 : -1));
            if (soloIns.length) inscripcion_importe = Number(soloIns[0].importe_base || 0);
        }

        // --- Pagos aplicados a periodos (para colegiaturas)
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

        // --- Pagos de inscripción registrados (tipo_de_pago = 'Inscripción')
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

        // --- Construir detalle respetando el calendario (incluye INS)
        const detalle = (cal || []).map(p => {
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
                // Otros tipos (si existieran) → 0
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

        // --- Adeudo (solo vencidos)
        const adeudo = +(detalle
            .filter(d => d.fecha_vencimiento && d.fecha_vencimiento <= hoy)
            .reduce((s, d) => s + (d.saldo || 0), 0)
        ).toFixed(2);

        const estatus = adeudo > 0 ? 'Pendiente' : 'Al corriente';

        // --- Detalle hasta hoy (no muestra futuros)
        const detalleHastaHoy = detalle.filter(d =>
            d.fecha_vencimiento && d.fecha_vencimiento <= hoy
        );

        // --- Adelantos (solo colegiatura a futuro)
        let adelanto_monto = 0;
        let adelanto_periodos = 0;
        for (const p of (cal || [])) {
            const periodoUp = (p.periodo || '').toUpperCase();
            const tipoUp = (p.tipo || '').toUpperCase();
            if (!p.fecha_vencimiento || p.fecha_vencimiento <= hoy) continue;
            if (periodoUp === 'INS' || tipoUp === 'INSCRIPCION') continue; // no cuenta como adelanto

            if (tipoUp === 'COLEGIATURA') {
                const mult = Number(p.multiplicador || 1);
                const importe = Number(colegiatura) * mult;
                const aplicado = Number(pagadoPorPeriodo[p.periodo] || 0);
                if (aplicado > 0) {
                    if (+aplicado.toFixed(2) >= +importe.toFixed(2)) adelanto_periodos++;
                    adelanto_monto += Math.min(aplicado, importe);
                }
            }
        }
        const adelanto = {
            monto: +adelanto_monto.toFixed(2),
            periodos: adelanto_periodos
        };

        return res.status(200).json({
            estatus,
            adeudo,
            detalle: detalleHastaHoy,
            adelanto
        });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'No se pudo calcular el resumen' });
    }
}
