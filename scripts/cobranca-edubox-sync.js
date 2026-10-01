// ==========================================================================
// Sincronização Edubox -> Órbita (módulo Cobrança do Financeiro).
//
// O Edubox (Postgres na nuvem do fornecedor) só aceita conexão do IP da
// Fatec — o Órbita publicado (Vercel) não alcança. Então este script roda
// num PC da Fatec (via cobranca-edubox-agente.js) e SÓ LÊ o Edubox; o que ele
// grava é no Firestore do Órbita:
//   cobranca_edubox/atual              resumo do que está em aberto (vencido e
//                                      a vencer) por semestre, Graduação x
//                                      Medicina, Financeiro x Jurídico, curso
//                                      e faixa de atraso
//   cobranca_edubox_alunos/{graduacao|medicina}
//                                      alunos com parcela vencida (lista de
//                                      cobrança: contato, parcelas, atraso)
//   cobranca_edubox_pagamentos/recentes pagamentos por aluno nos últimos 60
//                                      dias (retorno das cobranças da semana)
//   cobranca_edubox/semanas            resumo por semana (segunda-feira):
//                                      vencido no início/agora, devido e
//                                      recebido — gráfico da Visão do diretor
//   cobranca_edubox_baixas/{AAAA-MM-DD} recebido por dia (últimos 45 dias)
//   cobranca_edubox_historico/{id}      "foto" dos totais vencidos a cada
//                                      rodada (base do "comecei a semana com X")
//   config/cobranca_sync               status/última atualização
//
// Regras (definidas com o usuário, 30/09/2026):
//  - "A cobrar" = só o VENCIDO (parcela Aberto/Parcial com vencimento < hoje).
//  - Medicina x Graduação: pelo formato do semestre no Edubox ("2026-2" é a
//    base MED, "2026/2" é a de graduação) — também é o que separa no curso.
//  - Jurídico = parcelas de plano da categoria "RENEGOCIAÇÃO JUDICIAL"
//    (planos Advogado Fatec, Advogado Medicina, Débito Judicial). Todo o
//    dinheiro é da Fatec; só precisa sair no relatório certo.
//  - Quem manda é o PLANO DA PARCELA (decisão do usuário, 01/10/2026): parcela
//    de plano jurídico é do advogado; qualquer outra é do Financeiro, mesmo
//    que o aluno também tenha acordo. "Advogado" (Advogado Fatec/Medicina) =
//    acordo feito; "Débito judicial" = está com a advogada, sem acordo ainda.
//  - Aluno com acordo ganha a situação de pagamento (último pagamento, pago
//    em 90 dias) — mostra se o acordo está andando.
//  - Recebido = baixas do tipo "baixa"/"baixa_parcial", sem estorno, com data
//    até hoje (existe baixa digitada com data futura no Edubox — ignorada).
//
// Uso manual: node scripts/cobranca-edubox-sync.js
// ==========================================================================
const path = require('path');
const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const { db } = require(path.join(RAIZ, 'src', 'firebase'));
const edubox = require(path.join(RAIZ, 'src', 'db-edubox'));

const CATEGORIA_JURIDICO = 9; // tfi_categoria "RENEGOCIAÇÃO JUDICIAL"
const DIAS_BAIXAS = 45;
const FAIXAS = [[1, 30, '1-30'], [31, 60, '31-60'], [61, 90, '61-90'], [91, Infinity, '90+']];
const SEM_CURSO = 'Sem curso vinculado';

const q = async (sql, params) => (await edubox.query(sql, params)).rows;

function normalizarSemestre(s) {
    const m = (s || '').trim().match(/^(\d{4})\s*[-/.]\s*(\d)$/);
    return m ? `${m[1]}.${m[2]}` : ((s || '').trim() || 'sem semestre');
}
function grupoDe(semctr) {
    return /-/.test(semctr || '') ? 'medicina' : 'graduacao';
}
function faixaDe(dias) {
    const f = FAIXAS.find(([de, ate]) => dias >= de && dias <= ate);
    return f ? f[2] : null;
}
function isoData(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Curso de cada parcela: pela matrícula da parcela; se não tiver, pela
// matrícula mais recente do cliente (aluno). O resto fica "Sem curso vinculado".
const SQL_ABERTO = `
    WITH curso_cli AS (
        SELECT DISTINCT ON (m.climat) m.climat, cu.descur
        FROM tac_matricula m
        JOIN tac_turma t ON t.codtur = m.turmat
        JOIN tac_curso cu ON cu.codcur = t.curtur
        ORDER BY m.climat, m.datmat DESC NULLS LAST, m.codmat DESC
    )
    SELECT c.codctr, c.clictr, c.semctr, c.venctr, c.valctr, coalesce(c.valpagctr, 0) AS valpag,
           c.stactr, (p.catpla = $1) AS juridico, p.despla,
           trim(coalesce(cu.descur, cc.descur, '')) AS curso,
           trim(cl.nomcli) AS nome, cl.cpfcli, cl.celcli, cl.foncli
    FROM tfi_ctreceber c
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    LEFT JOIN tac_matricula m ON m.codmat = c.matctr
    LEFT JOIN tac_turma t ON t.codtur = m.turmat
    LEFT JOIN tac_curso cu ON cu.codcur = t.curtur
    LEFT JOIN curso_cli cc ON cc.climat = c.clictr
    LEFT JOIN tfi_cliente cl ON cl.codcli = c.clictr
    WHERE c.stactr IN ('Aberto', 'Parcial')
      AND coalesce(p.despla, '') !~* '^teste$'`;

const SQL_BAIXAS = `
    WITH curso_cli AS (
        SELECT DISTINCT ON (m.climat) m.climat, cu.descur
        FROM tac_matricula m
        JOIN tac_turma t ON t.codtur = m.turmat
        JOIN tac_curso cu ON cu.codcur = t.curtur
        ORDER BY m.climat, m.datmat DESC NULLS LAST, m.codmat DESC
    )
    SELECT b.datibc, b.totibc, c.venctr, c.semctr, c.clictr, (p.catpla = $1) AS juridico, trim(p.despla) AS plano,
           coalesce(tb.destba, 'OUTRO') AS tipo,
           trim(coalesce(cu.descur, cc.descur, '')) AS curso
    FROM tfi_itembaixactr b
    JOIN tfi_ctreceber c ON c.codctr = b.ctribc
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    LEFT JOIN tfi_tipobaixa tb ON tb.codtba = b.tbaibc
    LEFT JOIN tac_matricula m ON m.codmat = c.matctr
    LEFT JOIN tac_turma t ON t.codtur = m.turmat
    LEFT JOIN tac_curso cu ON cu.codcur = t.curtur
    LEFT JOIN curso_cli cc ON cc.climat = c.clictr
    WHERE b.tipibc IN ('baixa', 'baixa_parcial')
      AND b.estibc IS NULL
      AND b.datibc BETWEEN CURRENT_DATE - $2::int AND CURRENT_DATE`;

// "Devido até hoje": tudo que já venceu, pago ou não — base do % de
// inadimplência (vencido em aberto ÷ devido). Fora: parcela cancelada e
// parcela substituída por renegociação/cancelamento (senão a dívida entra
// duas vezes: a original e a renegociada).
const SQL_DEVIDO = `
    WITH curso_cli AS (
        SELECT DISTINCT ON (m.climat) m.climat, cu.descur
        FROM tac_matricula m
        JOIN tac_turma t ON t.codtur = m.turmat
        JOIN tac_curso cu ON cu.codcur = t.curtur
        ORDER BY m.climat, m.datmat DESC NULLS LAST, m.codmat DESC
    )
    SELECT c.semctr, coalesce(p.catpla = $1, false) AS juridico,
           trim(coalesce(cu.descur, cc.descur, '')) AS curso, sum(c.valctr) AS devido
    FROM tfi_ctreceber c
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    LEFT JOIN tac_matricula m ON m.codmat = c.matctr
    LEFT JOIN tac_turma t ON t.codtur = m.turmat
    LEFT JOIN tac_curso cu ON cu.codcur = t.curtur
    LEFT JOIN curso_cli cc ON cc.climat = c.clictr
    WHERE c.venctr < CURRENT_DATE AND c.stactr <> 'Cancel'
      AND coalesce(p.despla, '') !~* '^teste$'
      AND NOT EXISTS (SELECT 1 FROM tfi_itembaixactr b WHERE b.ctribc = c.codctr
                      AND b.tipibc IN ('renegociacao', 'reneg_parcial', 'cancelamento') AND b.estibc IS NULL)
    GROUP BY 1, 2, 3`;

// Último pagamento de cada cliente (qualquer parcela e só as de acordo).
const SQL_ULTIMO_PAGAMENTO = `
    SELECT c.clictr, max(b.datibc)::date AS ultimo,
           (max(b.datibc) FILTER (WHERE p.catpla = $1))::date AS ultimo_acordo
    FROM tfi_itembaixactr b
    JOIN tfi_ctreceber c ON c.codctr = b.ctribc
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    WHERE b.tipibc IN ('baixa', 'baixa_parcial') AND b.estibc IS NULL AND b.datibc <= CURRENT_DATE
    GROUP BY c.clictr`;

// Pagamentos por cliente e dia nos últimos 90 dias.
const SQL_PAGAMENTOS_RECENTES = `
    SELECT c.clictr, trim(coalesce(cl.cpfcli, '')) AS cpf, b.datibc::date AS dia,
           coalesce(p.catpla = $1, false) AS juridico, sum(b.totibc) AS valor
    FROM tfi_itembaixactr b
    JOIN tfi_ctreceber c ON c.codctr = b.ctribc
    LEFT JOIN tfi_plano p ON p.codpla = c.plactr
    LEFT JOIN tfi_cliente cl ON cl.codcli = c.clictr
    WHERE b.tipibc IN ('baixa', 'baixa_parcial') AND b.estibc IS NULL
      AND b.datibc BETWEEN CURRENT_DATE - 90 AND CURRENT_DATE
    GROUP BY 1, 2, 3, 4`;

const chaveDe = (cpfcli, clictr) => {
    const cpf = (cpfcli || '').replace(/\D/g, '');
    return cpf.length === 11 ? cpf : `cli${clictr}`;
};

async function montarPagamentos(hoje) {
    const [ult, rec] = await Promise.all([
        q(SQL_ULTIMO_PAGAMENTO, [CATEGORIA_JURIDICO]),
        q(SQL_PAGAMENTOS_RECENTES, [CATEGORIA_JURIDICO])
    ]);
    const porCliente = {};
    for (const r of ult) {
        porCliente[r.clictr] = { ultimo: r.ultimo ? isoData(r.ultimo) : null, ultimoAcordo: r.ultimo_acordo ? isoData(r.ultimo_acordo) : null, pago90: 0, pago90Acordo: 0 };
    }
    const recentes = {}; // chave -> { 'AAAA-MM-DD': valor } últimos 60 dias (retorno das cobranças)
    const limite60 = isoData(new Date(Date.now() - 60 * 86400000));
    for (const r of rec) {
        const dia = isoData(r.dia);
        if (dia > hoje) continue;
        const v = Number(r.valor) || 0;
        const pc = (porCliente[r.clictr] = porCliente[r.clictr] || { ultimo: null, ultimoAcordo: null, pago90: 0, pago90Acordo: 0 });
        pc.pago90 += v;
        if (r.juridico) pc.pago90Acordo += v;
        if (dia >= limite60) {
            const k = chaveDe(r.cpf, r.clictr);
            const dias = (recentes[k] = recentes[k] || {});
            dias[dia] = r2((dias[dia] || 0) + v);
        }
    }
    for (const pc of Object.values(porCliente)) { pc.pago90 = r2(pc.pago90); pc.pago90Acordo = r2(pc.pago90Acordo); }
    return { porCliente, recentes };
}

// Situação dos alunos com acordo/débito: quantos pagaram algo em 90 dias.
function montarSituacaoAdvogado(linhas, pagamentos) {
    const porCli = {};
    for (const l of linhas) {
        if (!l.juridico || Number(l.valctr) - Number(l.valpag) <= 0) continue;
        const c = (porCli[l.clictr] = porCli[l.clictr] || { grupo: grupoDe(l.semctr), planos: new Set() });
        c.planos.add((l.despla || '').trim());
    }
    const novo = () => ({ alunos: 0, pagando: 0, pago90: 0 });
    const saida = { graduacao: { advogado: novo(), debito: novo() }, medicina: { advogado: novo(), debito: novo() } };
    for (const [cli, c] of Object.entries(porCli)) {
        const tipo = [...c.planos].some(pl => /ADVOGADO/i.test(pl)) ? 'advogado' : 'debito';
        const pg = pagamentos.porCliente[cli];
        const x = saida[c.grupo][tipo];
        x.alunos += 1;
        if (pg && pg.pago90 > 0) { x.pagando += 1; x.pago90 += pg.pago90; }
    }
    for (const g of Object.values(saida)) for (const x of Object.values(g)) x.pago90 = r2(x.pago90);
    return saida;
}

function novoBloco() {
    return { valor: 0, parcelas: 0, alunos: new Set() };
}
function fecharBloco(b) {
    return { valor: r2(b.valor), parcelas: b.parcelas, alunos: b.alunos.size };
}

// Estrutura do resumo de um grupo (graduação ou medicina) num recorte de semestre.
function novoGrupo() {
    return {
        vencido: novoBloco(), aVencer: novoBloco(),
        financeiro: { vencido: novoBloco(), aVencer: novoBloco() },
        juridico: { vencido: novoBloco(), aVencer: novoBloco() },
        faixas: Object.fromEntries(FAIXAS.map(f => [f[2], novoBloco()])),
        porCurso: {},
        financeiroComAdvogado: novoBloco(), // vencido do Financeiro de quem está com advogado (não cobrar)
        planosJuridico: {} // plano -> { vencido, aVencer }
    };
}
function somar(bloco, valor, cliente) {
    bloco.valor += valor;
    bloco.parcelas += 1;
    bloco.alunos.add(cliente);
}
function fecharGrupo(g) {
    return {
        vencido: fecharBloco(g.vencido), aVencer: fecharBloco(g.aVencer),
        financeiro: { vencido: fecharBloco(g.financeiro.vencido), aVencer: fecharBloco(g.financeiro.aVencer) },
        juridico: { vencido: fecharBloco(g.juridico.vencido), aVencer: fecharBloco(g.juridico.aVencer) },
        faixas: Object.fromEntries(Object.entries(g.faixas).map(([k, b]) => [k, fecharBloco(b)])),
        porCurso: Object.fromEntries(Object.entries(g.porCurso).map(([k, c]) => [k, {
            vencido: fecharBloco(c.vencido), financeiroVencido: fecharBloco(c.financeiroVencido), juridicoVencido: fecharBloco(c.juridicoVencido)
        }])),
        financeiroComAdvogado: fecharBloco(g.financeiroComAdvogado),
        planosJuridico: Object.fromEntries(Object.entries(g.planosJuridico).map(([k, x]) => [k, { vencido: fecharBloco(x.vencido), aVencer: fecharBloco(x.aVencer) }]))
    };
}

async function montarResumo(hoje, pagamentos) {
    const linhas = await q(SQL_ABERTO, [CATEGORIA_JURIDICO]);
    const recortes = {}; // { semestre|'todos': { graduacao: G, medicina: G } }
    const garantir = (sem) => (recortes[sem] = recortes[sem] || { graduacao: novoGrupo(), medicina: novoGrupo() });
    const hojeMs = new Date(hoje + 'T12:00:00').getTime();
    const comAdvogado = clientesComAdvogado(linhas);

    for (const l of linhas) {
        const valor = Number(l.valctr) - Number(l.valpag);
        if (valor <= 0) continue;
        const grupo = grupoDe(l.semctr);
        const sem = normalizarSemestre(l.semctr);
        const venc = isoData(l.venctr);
        const vencido = venc < hoje;
        const dias = vencido ? Math.round((hojeMs - new Date(venc + 'T12:00:00').getTime()) / 86400000) : 0;
        const curso = l.curso || SEM_CURSO;
        for (const recorte of [sem, 'todos']) {
            const g = garantir(recorte)[grupo];
            const lado = l.juridico ? g.juridico : g.financeiro;
            if (l.juridico) {
                const pl = (g.planosJuridico[(l.despla || '').trim()] = g.planosJuridico[(l.despla || '').trim()] || { vencido: novoBloco(), aVencer: novoBloco() });
                somar(vencido ? pl.vencido : pl.aVencer, valor, l.clictr);
            }
            if (vencido) {
                somar(g.vencido, valor, l.clictr);
                somar(lado.vencido, valor, l.clictr);
                if (!l.juridico && comAdvogado.has(l.clictr)) somar(g.financeiroComAdvogado, valor, l.clictr);
                const f = faixaDe(dias);
                if (f) somar(g.faixas[f], valor, l.clictr);
                const c = (g.porCurso[curso] = g.porCurso[curso] || { vencido: novoBloco(), financeiroVencido: novoBloco(), juridicoVencido: novoBloco() });
                somar(c.vencido, valor, l.clictr);
                somar(l.juridico ? c.juridicoVencido : c.financeiroVencido, valor, l.clictr);
            } else {
                somar(g.aVencer, valor, l.clictr);
                somar(lado.aVencer, valor, l.clictr);
            }
        }
    }
    const resumo = {};
    const devidoLinhas = await q(SQL_DEVIDO, [CATEGORIA_JURIDICO]);
    const alunos = montarAlunos(linhas, hoje, hojeMs, comAdvogado, pagamentos);
    const situacaoAdvogado = montarSituacaoAdvogado(linhas, pagamentos);
    for (const [sem, gr] of Object.entries(recortes)) {
        resumo[sem] = { graduacao: fecharGrupo(gr.graduacao), medicina: fecharGrupo(gr.medicina) };
    }
    for (const d of devidoLinhas) {
        const grupo = grupoDe(d.semctr);
        const valor = Number(d.devido) || 0;
        const curso = d.curso || SEM_CURSO;
        for (const sem of [normalizarSemestre(d.semctr), 'todos']) {
            const g = resumo[sem] && resumo[sem][grupo];
            if (!g) continue; // semestre sem nada em aberto: não aparece no painel
            g.devido = g.devido || { financeiro: 0, juridico: 0 };
            g.devido[d.juridico ? 'juridico' : 'financeiro'] += valor;
            if (!d.juridico && g.porCurso[curso]) g.porCurso[curso].devidoFinanceiro = (g.porCurso[curso].devidoFinanceiro || 0) + valor;
        }
    }
    for (const gr of Object.values(resumo)) for (const g of Object.values(gr)) {
        if (g.devido) { g.devido.financeiro = r2(g.devido.financeiro); g.devido.juridico = r2(g.devido.juridico); }
        for (const c of Object.values(g.porCurso)) if (c.devidoFinanceiro) c.devidoFinanceiro = r2(c.devidoFinanceiro);
    }
    return { resumo, alunos, situacaoAdvogado, parcelasLidas: linhas.length };
}

function telefone(v) {
    const d = (v || '').replace(/\D/g, '').replace(/^0+/, '');
    if (d.length === 10 || d.length === 11) return '55' + d;
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
    return '';
}

// Lista de cobrança: um registro por aluno (cliente) e grupo, só com o que
// está VENCIDO. A chave do aluno no Órbita é o CPF (é como o histórico de
// ações já era guardado); sem CPF válido, "cli" + código do cliente.
function clientesComAdvogado(linhas) {
    const set = new Set();
    for (const l of linhas) if (l.juridico && Number(l.valctr) - Number(l.valpag) > 0) set.add(l.clictr);
    return set;
}

function montarAlunos(linhas, hoje, hojeMs, comAdvogado, pagamentos) {
    const planosDe = {};
    for (const l of linhas) {
        if (!l.juridico || !comAdvogado.has(l.clictr)) continue;
        const pl = (planosDe[l.clictr] = planosDe[l.clictr] || new Set());
        pl.add((l.despla || '').trim());
    }
    const mapa = { graduacao: {}, medicina: {} };
    for (const l of linhas) {
        const valor = Number(l.valctr) - Number(l.valpag);
        const venc = isoData(l.venctr);
        if (valor <= 0 || venc >= hoje) continue;
        const grupo = grupoDe(l.semctr);
        const cpf = (l.cpfcli || '').replace(/\D/g, '');
        const chave = cpf.length === 11 ? cpf : `cli${l.clictr}`;
        const a = (mapa[grupo][chave] = mapa[grupo][chave] || {
            chave, cpf: cpf.length === 11 ? cpf : '', codcli: l.clictr, nome: l.nome || '(sem nome)',
            celular: telefone(l.celcli) || telefone(l.foncli), fone: (l.foncli || l.celcli || '').trim(),
            cursos: [], total: 0, financeiro: 0, juridico: 0, maisAntigo: venc, parcelas: [],
            comAdvogado: comAdvogado.has(l.clictr), planosAdvogado: [...(planosDe[l.clictr] || [])],
            tipoAdvogado: !comAdvogado.has(l.clictr) ? null
                : [...(planosDe[l.clictr] || [])].some(pl => /ADVOGADO/i.test(pl)) ? 'advogado' : 'debito',
            pagamento: (pagamentos && pagamentos.porCliente[l.clictr]) || null
        });
        const curso = l.curso || SEM_CURSO;
        if (!a.cursos.includes(curso)) a.cursos.push(curso);
        a.total += valor;
        a[l.juridico ? 'juridico' : 'financeiro'] += valor;
        if (venc < a.maisAntigo) a.maisAntigo = venc;
        a.parcelas.push({ v: venc, s: normalizarSemestre(l.semctr), valor: r2(valor), j: !!l.juridico, pl: (l.despla || '').trim() });
    }
    // Nome do plano vai uma vez só em `planos` do grupo; a parcela guarda o
    // índice (`pl`) — o nome repetido em cada parcela quase estourava o limite
    // de 1 MB do documento.
    const saida = {};
    for (const g of ['graduacao', 'medicina']) {
        const planos = [];
        const idx = {};
        const indice = (nome) => (nome in idx ? idx[nome] : (idx[nome] = planos.push(nome) - 1));
        saida[g] = Object.values(mapa[g]).map(a => {
            a.parcelas.sort((x, y) => x.v.localeCompare(y.v));
            a.parcelas.forEach(pc => { pc.pl = indice(pc.pl); });
            return {
                ...a, total: r2(a.total), financeiro: r2(a.financeiro), juridico: r2(a.juridico),
                diasAtraso: Math.round((hojeMs - new Date(a.maisAntigo + 'T12:00:00').getTime()) / 86400000),
                semestres: [...new Set(a.parcelas.map(p => p.s))].sort().reverse()
            };
        }).sort((x, y) => y.total - x.total);
        saida[g + 'Planos'] = planos;
    }
    return saida;
}

async function montarBaixas(hoje) {
    const linhas = await q(SQL_BAIXAS, [CATEGORIA_JURIDICO, DIAS_BAIXAS]);
    const porDia = {};
    const novoLado = () => ({ valor: 0, n: 0, emAtraso: 0, porTipo: {}, porCurso: {}, porPlano: {} });
    for (const l of linhas) {
        const dia = isoData(l.datibc);
        if (dia > hoje) continue;
        const grupo = grupoDe(l.semctr);
        const sem = normalizarSemestre(l.semctr);
        const valor = Number(l.totibc) || 0;
        const atrasada = isoData(l.venctr) < dia; // pagou depois do vencimento = recuperado pela cobrança
        const d = (porDia[dia] = porDia[dia] || { data: dia, graduacao: { financeiro: novoLado(), juridico: novoLado() }, medicina: { financeiro: novoLado(), juridico: novoLado() }, porSemestre: {} });
        const lado = d[grupo][l.juridico ? 'juridico' : 'financeiro'];
        lado.valor += valor;
        lado.n += 1;
        if (atrasada) lado.emAtraso += valor;
        lado.porTipo[l.tipo] = (lado.porTipo[l.tipo] || 0) + valor;
        const curso = l.curso || SEM_CURSO;
        lado.porCurso[curso] = (lado.porCurso[curso] || 0) + valor;
        if (l.juridico) lado.porPlano[l.plano || ''] = (lado.porPlano[l.plano || ''] || 0) + valor;
        // por semestre da parcela (pro filtro de semestre do fechamento semanal)
        const ps = (d.porSemestre[sem] = d.porSemestre[sem] || { graduacao: { financeiro: 0, juridico: 0, financeiroAtraso: 0, juridicoAtraso: 0 }, medicina: { financeiro: 0, juridico: 0, financeiroAtraso: 0, juridicoAtraso: 0 } });
        const k = l.juridico ? 'juridico' : 'financeiro';
        ps[grupo][k] += valor;
        if (atrasada) ps[grupo][k + 'Atraso'] += valor;
    }
    // arredonda
    for (const d of Object.values(porDia)) {
        for (const g of ['graduacao', 'medicina']) for (const k of ['financeiro', 'juridico']) {
            const x = d[g][k];
            x.valor = r2(x.valor); x.emAtraso = r2(x.emAtraso);
            for (const t in x.porTipo) x.porTipo[t] = r2(x.porTipo[t]);
            for (const c in x.porCurso) x.porCurso[c] = r2(x.porCurso[c]);
            for (const c in x.porPlano) x.porPlano[c] = r2(x.porPlano[c]);
        }
        for (const s of Object.values(d.porSemestre)) for (const g of ['graduacao', 'medicina']) for (const k in s[g]) s[g][k] = r2(s[g][k]);
    }
    return { porDia, baixasLidas: linhas.length };
}

// Segunda-feira (AAAA-MM-DD) da semana de uma data AAAA-MM-DD.
function segundaDe(diaIso) {
    const [a, m, d] = diaIso.split('-').map(Number);
    const x = new Date(a, m - 1, d, 12);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return isoData(x);
}

// Resumo por semana (doc único, últimas 60 semanas): por grupo e semestre,
// vencido no início da semana (1ª rodada da semana) e agora, devido, e o
// recebido (das baixas diárias). Uma leitura só pra montar o gráfico.
async function atualizarSemanas(hoje, resumo, porDia, agora) {
    const ref = db.collection('cobranca_edubox').doc('semanas');
    const snap = await ref.get();
    const semanas = (snap.exists && snap.data().semanas) || {};
    const fotoAgora = (g) => ({ f: g.financeiro.vencido.valor, j: g.juridico.vencido.valor, fd: (g.devido && g.devido.financeiro) || 0 });

    const seg = segundaDe(hoje);
    const atual = (semanas[seg] = semanas[seg] || {});
    for (const [sem, gr] of Object.entries(resumo)) {
        for (const grupo of ['graduacao', 'medicina']) {
            const x = ((atual[grupo] = atual[grupo] || {})[sem] = atual[grupo][sem] || {});
            if (!x.ini) x.ini = fotoAgora(gr[grupo]);
            x.atual = fotoAgora(gr[grupo]);
        }
    }
    // recebido: recalcula as semanas cobertas pelas baixas diárias
    const rec = {};
    for (const d of Object.values(porDia)) {
        const sg = segundaDe(d.data);
        for (const grupo of ['graduacao', 'medicina']) {
            const somar = (sem, f, j, fa, ja) => {
                const r = (((rec[sg] = rec[sg] || {})[grupo] = rec[sg][grupo] || {})[sem] = rec[sg][grupo][sem] || { f: 0, j: 0, fa: 0, ja: 0 });
                r.f += f; r.j += j; r.fa += fa; r.ja += ja;
            };
            somar('todos', d[grupo].financeiro.valor, d[grupo].juridico.valor, d[grupo].financeiro.emAtraso, d[grupo].juridico.emAtraso);
            for (const [sem, ps] of Object.entries(d.porSemestre)) {
                const v = ps[grupo];
                if (v.financeiro || v.juridico) somar(sem, v.financeiro, v.juridico, v.financeiroAtraso, v.juridicoAtraso);
            }
        }
    }
    for (const [sg, gr] of Object.entries(rec)) for (const [grupo, sems] of Object.entries(gr)) for (const [sem, r] of Object.entries(sems)) {
        const x = (((semanas[sg] = semanas[sg] || {})[grupo] = semanas[sg][grupo] || {})[sem] = semanas[sg][grupo][sem] || {});
        x.rec = { f: r2(r.f), j: r2(r.j), fa: r2(r.fa), ja: r2(r.ja) };
    }
    const chaves = Object.keys(semanas).sort();
    for (const k of chaves.slice(0, Math.max(0, chaves.length - 60))) delete semanas[k];
    await ref.set({ atualizadoEm: agora, semanas });
}

async function sincronizar(origem = 'manual') {
    const inicio = Date.now();
    const cfg = db.collection('config').doc('cobranca_sync');
    await cfg.set({ status: 'rodando', rodandoDesde: new Date().toISOString(), origemRodando: origem }, { merge: true });
    try {
        const hoje = isoData(new Date());
        const pagamentos = await montarPagamentos(hoje);
        const { resumo, alunos, situacaoAdvogado, parcelasLidas } = await montarResumo(hoje, pagamentos);
        const { porDia, baixasLidas } = await montarBaixas(hoje);
        const agora = new Date().toISOString();
        const semestres = Object.keys(resumo).filter(s => s !== 'todos').sort((a, b) => b.localeCompare(a));

        await db.collection('cobranca_edubox').doc('atual').set({ geradoEm: agora, origem, semestres, resumo, situacaoAdvogado });
        await db.collection('cobranca_edubox_pagamentos').doc('recentes').set({ geradoEm: agora, porAluno: pagamentos.recentes });
        for (const g of ['graduacao', 'medicina']) {
            await db.collection('cobranca_edubox_alunos').doc(g).set({ geradoEm: agora, alunos: alunos[g], planos: alunos[g + 'Planos'] });
        }

        // "Foto" compacta dos totais vencidos (base do fechamento semanal)
        const foto = {};
        for (const [sem, gr] of Object.entries(resumo)) {
            foto[sem] = {};
            for (const g of ['graduacao', 'medicina']) {
                foto[sem][g] = { financeiro: gr[g].financeiro.vencido.valor, juridico: gr[g].juridico.vencido.valor, alunos: gr[g].vencido.alunos };
            }
        }
        const idFoto = agora.slice(0, 16).replace(/[-:T]/g, '');
        await db.collection('cobranca_edubox_historico').doc(idFoto).set({ geradoEm: agora, data: hoje, origem, vencido: foto });

        await atualizarSemanas(hoje, resumo, porDia, agora);

        const batch = db.batch();
        for (const [dia, dados] of Object.entries(porDia)) {
            batch.set(db.collection('cobranca_edubox_baixas').doc(dia), { ...dados, atualizadoEm: agora });
        }
        await batch.commit();

        const duracaoMs = Date.now() - inicio;
        await cfg.set({ status: 'ok', ultimaAtualizacao: agora, ultimaOrigem: origem, duracaoMs, erro: null, parcelasLidas, baixasLidas }, { merge: true });
        return { ok: true, duracaoMs, parcelasLidas, baixasLidas, dias: Object.keys(porDia).length, semestres: semestres.length };
    } catch (err) {
        await cfg.set({ status: 'erro', erro: err.message, erroEm: new Date().toISOString() }, { merge: true });
        throw err;
    }
}

module.exports = { sincronizar };

if (require.main === module) {
    sincronizar('manual')
        .then(r => { console.log('Sincronização concluída:', JSON.stringify(r)); process.exit(0); })
        .catch(e => { console.error('Falhou:', e.message); process.exit(1); });
}
