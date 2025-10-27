// api/alumnos/list.js
import supaAdmin from '../../lib/supaAdmin.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const { data: alumnos, error: eA } = await supaAdmin
            .from('alumnos')
            .select('id, alumno_code, nombre_completo, sexo, nivel, grado, estatus, oficial_sep')
            .order('nivel', { ascending: true })
            .order('grado', { ascending: true })
            .order('nombre_completo', { ascending: true });

        if (eA) throw eA;

        if (!alumnos || !alumnos.length) {
            return res.status(200).json({
                alumnos: [],
                resumen: {
                    hombres: 0, mujeres: 0, hombres_sep: 0, mujeres_sep: 0,
                    ingreso_total_actual: 0, ingreso_promedio: 0,
                    ingreso_base_esperado: 0, diferencia_vs_base: 0,
                    base_pre: 0, base_pri: 0
                },
                resumen_niveles: {
                    Preescolar: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } },
                    Primaria: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } }
                }
            });
        }

        const alumnoIds = alumnos.map(a => a.id);

        const { data: precios, error: eP } = await supaAdmin
            .from('precios_alumno')
            .select('alumno_id, concepto, vigencia_desde, importe_base')
            .in('alumno_id', alumnoIds)
            .order('vigencia_desde', { ascending: false });

        if (eP) throw eP;

        const { data: params, error: ePar } = await supaAdmin
            .from('parametros').select('parametro, valor');

        if (ePar) throw ePar;

        const pmap = {};
        (params || []).forEach(p => { pmap[p.parametro] = p.valor; });
        const basePre = Number(pmap['colegiatura_base_pre'] || 0);
        const basePri = Number(pmap['colegiatura_base_pri'] || 0);

        const hoy = new Date().toISOString().slice(0, 10);
        const byAlumno = new Map(); // alumno_id -> importe_actual

        const porAlumno = {};
        (precios || []).forEach(r => {
            if ((r.concepto || '').toLowerCase() !== 'colegiatura') return;
            const arr = porAlumno[r.alumno_id] || [];
            arr.push(r);
            porAlumno[r.alumno_id] = arr;
        });

        for (const a of alumnos) {
            const lista = porAlumno[a.id] || [];
            let vigente = null;
            if (lista.length) {
                vigente = lista.find(x => x.vigencia_desde <= hoy) || lista[0];
            }
            let importe = vigente ? Number(vigente.importe_base || 0) : null;
            if (importe === null) {
                const nivel = String(a.nivel || '').toLowerCase();
                importe = (nivel === 'preescolar') ? basePre
                    : (nivel === 'primaria') ? basePri
                        : 0;
            }
            byAlumno.set(a.id, Number(importe || 0));
        }

        const nivelOrder = v => {
            const x = String(v || '').toLowerCase();
            if (x === 'preescolar') return 0;
            if (x === 'primaria') return 1;
            return 2;
        };
        const gradoOrder = g => Number(g || 0);

        const filas = alumnos
            .slice()
            .sort((a, b) => {
                const n = nivelOrder(a.nivel) - nivelOrder(b.nivel);
                if (n !== 0) return n;
                const g = gradoOrder(a.grado) - gradoOrder(b.grado);
                if (g !== 0) return g;
                return a.nombre_completo.localeCompare(b.nombre_completo, 'es');
            })
            .map(a => ({
                alumno_id: a.id,
                alumno_code: a.alumno_code || null,
                nombre_completo: a.nombre_completo,
                sexo: a.sexo,
                nivel: a.nivel,
                grado: Number(a.grado || 0),
                estatus: a.estatus,
                oficial_sep: !!a.oficial_sep,
                importe_actual: byAlumno.get(a.id) ?? 0
            }));

        // KPIs globales
        const hombres = filas.filter(f => (f.sexo || '').toUpperCase() === 'H').length;
        const mujeres = filas.filter(f => (f.sexo || '').toUpperCase() === 'M').length;

        const hombres_sep = filas.filter(f => f.oficial_sep && (f.sexo || '').toUpperCase() === 'H').length;
        const mujeres_sep = filas.filter(f => f.oficial_sep && (f.sexo || '').toUpperCase() === 'M').length;

        const ingreso_total_actual = +filas.reduce((s, f) => s + Number(f.importe_actual || 0), 0).toFixed(2);
        const ingreso_promedio = filas.length ? +(ingreso_total_actual / filas.length).toFixed(2) : 0;

        const nPre = filas.filter(f => String(f.nivel || '').toLowerCase() === 'preescolar').length;
        const nPri = filas.filter(f => String(f.nivel || '').toLowerCase() === 'primaria').length;
        const ingreso_base_esperado = +(nPre * basePre + nPri * basePri).toFixed(2);
        const diferencia_vs_base = +(ingreso_total_actual - ingreso_base_esperado).toFixed(2);

        // Resumen por nivel/grado/sexo (para tablas pedidas)
        const RN = {
            Preescolar: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } },
            Primaria: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } }
        };
        const ensureRow = (obj, g) => {
            if (!obj.grados[g]) obj.grados[g] = { H: 0, M: 0, total: 0, H_oficial: 0, M_oficial: 0, total_oficial: 0 };
            return obj.grados[g];
        };
        const normNivel = (v) => (String(v || '').toLowerCase() === 'preescolar' ? 'Preescolar' : 'Primaria');
        const normSexo = (v) => (String(v || 'H').toUpperCase() === 'M' ? 'M' : 'H');

        for (const f of filas) {
            const n = normNivel(f.nivel);
            const g = String(f.grado || '');
            const s = normSexo(f.sexo);
            const row = ensureRow(RN[n], g);

            row[s] += 1;
            row.total += 1;
            RN[n].total[s] += 1;

            if (f.oficial_sep) {
                if (s === 'H') row.H_oficial += 1; else row.M_oficial += 1;
                row.total_oficial += 1;
                RN[n].totalOficial[s] += 1;
            }
        }

        // Asegurar grados presentes aunque estén en cero
        for (const g of ['1', '2', '3']) {
            if (!RN.Preescolar.grados[g]) RN.Preescolar.grados[g] = { H: 0, M: 0, total: 0, H_oficial: 0, M_oficial: 0, total_oficial: 0 };
        }
        for (const g of ['1', '2', '3', '4', '5', '6']) {
            if (!RN.Primaria.grados[g]) RN.Primaria.grados[g] = { H: 0, M: 0, total: 0, H_oficial: 0, M_oficial: 0, total_oficial: 0 };
        }

        return res.status(200).json({
            alumnos: filas,
            resumen: {
                hombres, mujeres,
                hombres_sep, mujeres_sep,
                ingreso_total_actual,
                ingreso_promedio,
                ingreso_base_esperado,
                diferencia_vs_base,
                base_pre: basePre,
                base_pri: basePri
            },
            resumen_niveles: RN
        });

    } catch (e) {
        console.error('[alumnos/list] Error:', e);
        return res.status(500).json({ error: 'No se pudo obtener el listado' });
    }
}
