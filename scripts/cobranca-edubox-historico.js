// ==========================================================================
// Reconstrói, a partir do Edubox, o histórico semana a semana da Cobrança
// (Visão do diretor): pra cada segunda-feira desde uma data, quanto estava
// atrasado NAQUELE dia, quanto já tinha vencido (base do %) e quanto entrou
// na semana. Grava em cobranca_edubox/semanas (o mesmo doc que o agente
// atualiza toda rodada). Só LÊ o Edubox.
//
// "Naquele dia" (segunda 00:00):
//  - vencido = valor da parcela − o que foi baixado ANTES daquele dia, pras
//    parcelas que já tinham vencido;
//  - parcela renegociada/cancelada antes daquele dia não conta (a dívida já
//    tinha virado outra parcela); depois daquele dia, conta (ainda estava aberta);
//  - parcela "Cancel" sem registro de baixa (sem data) fica de fora sempre;
//  - parcela "Baixado" sem registro de baixa (dado antigo) conta como paga na
//    data de pagamento da própria parcela (datpagctr).
//
// Uso: node scripts/cobranca-edubox-historico.js [AAAA-MM-DD início] [--ate=AAAA-MM-DD] [--gravar]
//      sem --gravar só mostra a conta (pra conferir antes).
// ==========================================================================
const path = require('path');
const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const { db } = require(path.join(RAIZ, 'src', 'firebase'));
const edubox = require(path.join(RAIZ, 'src', 'db-edubox'));

const CATEGORIA_JURIDICO = 9;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// Consulta com até 3 tentativas (a nuvem do Edubox às vezes derruba a conexão).
async function q(sql, params) {
    for (let t = 1; ; t++) {
        try { return (await edubox.query(sql, params)).rows; } catch (e) {
            if (t >= 3) throw e;
            console.log(`  (conexão caiu: ${e.message} — tentando de novo)`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

function normalizarSemestre(s) {
    const m = (s || '').trim().match(/^(\d{4})\s*[-/.]\s*(\d)$/);
    return m ? `${m[1]}.${m[2]}` : ((s || '').trim() || 'sem semestre');
}
const grupoDe = (semctr) => (/-/.test(semctr || '') ? 'medicina' : 'graduacao');
function isoData(x) {
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function segundas(desde, ate) {
    const [a, m, d] = desde.split('-').map(Number);
    const x = new Date(a, m - 1, d, 12);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    const lista = [];
    while (isoData(x) <= ate) { lista.push(isoData(x)); x.setDate(x.getDate() + 7); }
    return lista;
}

const SQL_FOTO = `
    WITH b AS (
        SELECT ctribc,
               sum(totibc) FILTER (WHERE tipibc IN ('baixa', 'baixa_parcial')) AS pago,
               bool_or(tipibc IN ('renegociacao', 'reneg_parcial', 'cancelamento')) AS saiu
        FROM tfi_itembaixactr
        WHERE estibc IS NULL AND datibc < $2::date
        GROUP BY ctribc
    )
    SELECT c.semctr, coalesce(p.catpla = $1, false) AS juridico,
           -- mesmas regras do agente: semestre pelo vencimento; Financeiro só
           -- matrícula Ativo/Concluído/Pendente (situação de hoje)
           to_char(c.venctr, 'YYYY') || '.' || CASE WHEN extract(month FROM c.venctr) <= 6 THEN '1' ELSE '2' END AS semv,
           coalesce(trim(m.stamat) IN ('Ativo', 'Concluído', 'Pendente'), false) AS cobrar,
           sum(c.valctr) AS devido,
           sum(greatest(c.valctr - greatest(coalesce(b.pago, 0),
               -- parcela baixada sem registro de baixa: vale a data de pagamento da própria parcela
               CASE WHEN c.stactr = 'Baixado' AND (c.datpagctr IS NULL OR c.datpagctr < $2::date) THEN c.valctr ELSE 0 END), 0)) AS vencido
    FROM tfi_ctreceber c
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    LEFT JOIN b ON b.ctribc = c.codctr
    LEFT JOIN tac_matricula m ON m.codmat = c.matctr
    WHERE c.venctr < $2::date
      AND NOT coalesce(b.saiu, false)
      AND NOT (c.stactr = 'Cancel' AND NOT EXISTS (SELECT 1 FROM tfi_itembaixactr x WHERE x.ctribc = c.codctr))
      AND coalesce(p.despla, '') !~* '^teste$'
    GROUP BY 1, 2, 3, 4`;

const SQL_RECEBIDO = `
    SELECT date_trunc('week', b.datibc)::date AS segunda, c.semctr,
           to_char(c.venctr, 'YYYY') || '.' || CASE WHEN extract(month FROM c.venctr) <= 6 THEN '1' ELSE '2' END AS semv,
           coalesce(p.catpla = $1, false) AS juridico,
           sum(b.totibc) AS valor,
           sum(b.totibc) FILTER (WHERE c.venctr::date < b.datibc::date) AS atraso
    FROM tfi_itembaixactr b
    JOIN tfi_ctreceber c ON c.codctr = b.ctribc
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    WHERE b.tipibc IN ('baixa', 'baixa_parcial') AND b.estibc IS NULL
      AND b.datibc >= $2::date AND b.datibc <= CURRENT_DATE
    GROUP BY 1, 2, 3, 4`;

// { grupo: { sem|'todos': {f, j, fd} } } a partir das linhas por semestre
function agrupar(linhas, campo) {
    const out = { graduacao: {}, medicina: {} };
    for (const l of linhas) {
        const g = grupoDe(l.semctr);
        if (!l.juridico && !l.cobrar) continue; // desistente/trancado/cancelado: fora da cobrança
        for (const sem of [l.semv, 'todos']) {
            const x = (out[g][sem] = out[g][sem] || { f: 0, j: 0, fd: 0 });
            x[l.juridico ? 'j' : 'f'] += Number(l[campo]) || 0;
            if (!l.juridico) x.fd += Number(l.devido) || 0;
        }
    }
    for (const g of Object.values(out)) for (const x of Object.values(g)) { x.f = r2(x.f); x.j = r2(x.j); x.fd = r2(x.fd); }
    return out;
}

async function main() {
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] || '') ? process.argv[2] : '2026-01-05';
    const gravar = process.argv.includes('--gravar');
    const hoje = isoData(new Date());
    // --ate=AAAA-MM-DD limita o fim (rodar uma semana por processo)
    const argAte = (process.argv.find(x => x.startsWith('--ate=')) || '').slice(6);
    const lista = segundas(desde, /^\d{4}-\d{2}-\d{2}$/.test(argAte) && argAte < hoje ? argAte : hoje);
    console.log(`Semanas: ${lista[0]} a ${lista[lista.length - 1]} (${lista.length})`);

    const semanas = {};
    const ref = db.collection('cobranca_edubox').doc('semanas');
    // grava o que já foi calculado (merge no doc que o agente também usa)
    async function gravarParcial(semanasCalc) {
        const atual = ((await ref.get()).data() || {}).semanas || {};
        for (const [seg, w] of Object.entries(semanasCalc)) {
            for (const [grupo, sems] of Object.entries(w)) for (const [sem, x] of Object.entries(sems)) {
                const dest = (((atual[seg] = atual[seg] || {})[grupo] = atual[seg][grupo] || {})[sem] = atual[seg][grupo][sem] || {});
                if (x.ini) dest.ini = x.ini;
                if (x.rec) dest.rec = x.rec;
            }
        }
        await ref.set({ atualizadoEm: new Date().toISOString(), semanas: atual });
        return Object.keys(atual).length;
    }
    for (const seg of lista) {
        const t0 = Date.now();
        const fotos = agrupar(await q(SQL_FOTO, [CATEGORIA_JURIDICO, seg]), 'vencido');
        for (const grupo of ['graduacao', 'medicina']) for (const [sem, x] of Object.entries(fotos[grupo])) {
            (((semanas[seg] = semanas[seg] || {})[grupo] = semanas[seg][grupo] || {})[sem] = semanas[seg][grupo][sem] || {}).ini = x;
        }
        const t = fotos.graduacao.todos || {};
        console.log(`${seg}  grad: atrasado ${t.f} de ${t.fd} (${t.fd ? (100 * t.f / t.fd).toFixed(2) : '-'}%)  ${Date.now() - t0}ms`);
        if (gravar) await gravarParcial({ [seg]: semanas[seg] });
    }
    for (const l of await q(SQL_RECEBIDO, [CATEGORIA_JURIDICO, lista[0]])) {
        const seg = isoData(new Date(l.segunda));
        if (!semanas[seg]) continue;
        const g = grupoDe(l.semctr);
        for (const sem of [l.semv, 'todos']) {
            const x = (((semanas[seg][g] = semanas[seg][g] || {})[sem] = semanas[seg][g][sem] || {}).rec = semanas[seg][g][sem].rec || { f: 0, j: 0, fa: 0, ja: 0 });
            x[l.juridico ? 'j' : 'f'] += Number(l.valor) || 0;
            x[l.juridico ? 'ja' : 'fa'] += Number(l.atraso) || 0;
        }
    }
    for (const w of Object.values(semanas)) for (const g of Object.values(w)) for (const x of Object.values(g)) {
        if (x.rec) for (const k in x.rec) x.rec[k] = r2(x.rec[k]);
    }

    if (!gravar) { console.log('(só conferência — rode com --gravar pra salvar)'); return; }
    console.log(`Gravado: ${await gravarParcial(semanas)} semanas em cobranca_edubox/semanas.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('Falhou:', e.message); process.exit(1); });
