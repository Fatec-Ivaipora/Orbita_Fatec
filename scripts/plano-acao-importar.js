// Plano de Ação dos Coordenadores — carga das atividades e do calendário
// acadêmico do Edubox (21/10/2026).
//
//   node scripts/plano-acao-importar.js 2026.2 [AAAA-MM-DD]
//
// - Atividades: grava o catálogo de src/utils/planoAcaoCatalogo.js em
//   `plano_acao_atividades` SÓ se a coleção estiver vazia (depois a Direção
//   edita pela tela e isto não sobrescreve).
// - Calendário: lê tca_calendario/tca_evento do Edubox (semestre "2026/2" =
//   calendário da graduação) e grava em `plano_acao_semestres/2026.2`: início
//   e fim do semestre, dias sem aula (feriado/recesso), eventos e os prazos das
//   atividades que têm regra de calendário. Prazo lançado pela Direção na tela
//   (origem "direcao") é mantido. Atividade sem prazo = pendência de data.
// - 2º argumento (opcional): a partir de quando conta atraso
//   (`inicioAcompanhamento`). Sem ele, mantém o que já estava ou usa o início
//   do semestre.
//
// Roda NESTA máquina (precisa do Edubox no .env, só leitura). Rodar de novo
// quando a secretaria mexer no calendário.
require('dotenv').config();
const { db } = require('../src/firebase');
const { query } = require('../src/db-edubox');
const { ATIVIDADES } = require('../src/utils/planoAcaoCatalogo');

const semestre = process.argv[2];
const inicioAcompArg = process.argv[3];
if (!/^\d{4}\.[12]$/.test(semestre || '')) {
    console.error('Uso: node scripts/plano-acao-importar.js 2026.2 [AAAA-MM-DD]');
    process.exit(1);
}

const iso = (d) => d.toISOString().slice(0, 10);
const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function diasEntre(ini, fim) {
    const out = [];
    for (let d = new Date(`${ini}T12:00:00Z`); iso(d) <= fim; d.setUTCDate(d.getUTCDate() + 1)) out.push(iso(d));
    return out;
}

async function carregarAtividades() {
    const col = db.collection('plano_acao_atividades');
    const ja = await col.limit(1).get();
    if (!ja.empty) { console.log('Atividades: já cadastradas, não mexi.'); return (await col.get()).docs.map(d => ({ id: d.id, ...d.data() })); }
    const batch = db.batch();
    const agora = new Date().toISOString();
    ATIVIDADES.forEach(a => batch.set(col.doc(a.id), { ...a, ativo: true, createdAt: agora, createdBy: 'importação do documento' }));
    await batch.commit();
    console.log(`Atividades: ${ATIVIDADES.length} cadastradas.`);
    return ATIVIDADES.map(a => ({ ...a, ativo: true }));
}

async function main() {
    const atividades = await carregarAtividades();

    const [ano, s] = semestre.split('.');
    const semcal = `${ano}/${s}`;
    const { rows } = await query(
        `select c.dincal, c.dfical, c.comcal, e.deseve
           from tca_calendario c join tca_evento e on e.codeve = c.evecal
          where c.semcal = $1 order by c.dincal`, [semcal]);
    if (!rows.length) throw new Error(`O Edubox ainda não tem o calendário ${semcal}.`);

    const ev = rows.map(r => ({
        inicio: iso(r.dincal), fim: iso(r.dfical || r.dincal),
        descricao: limpa(r.deseve), complemento: limpa(r.comcal)
    }));
    // O calendário "2026/2" também traz o fim do semestre anterior (julho):
    // o semestre vai do INÍCIO DO SEMESTRE LETIVO ao ENCERRAMENTO seguinte.
    const piso = s === '1' ? `${ano}-01-01` : `${ano}-07-01`;
    const inicio = ev.filter(e => /IN[ÍI]CIO DO SEMESTRE LETIVO/.test(e.descricao) && e.inicio >= piso).map(e => e.inicio).sort()[0];
    if (!inicio) throw new Error('Não achei o "INÍCIO DO SEMESTRE LETIVO" no calendário.');
    const fim = ev.filter(e => /ENCERRAMENTO DO SEMESTRE/.test(e.descricao) && e.inicio > inicio).map(e => e.inicio).sort()[0];
    if (!fim) throw new Error('Não achei o "ENCERRAMENTO DO SEMESTRE" no calendário.');

    const noSemestre = ev.filter(e => e.fim >= inicio && e.inicio <= fim);
    const naoLetivos = {};
    noSemestre.filter(e => /FERIADO|RECESSO/.test(e.descricao)).forEach(e => {
        diasEntre(e.inicio, e.fim).forEach(d => { naoLetivos[d] = e.complemento ? `${e.descricao} – ${e.complemento}` : e.descricao; });
    });
    // mesmo evento repetido (a secretaria às vezes lança duas vezes)
    const eventos = [...new Map(noSemestre.map(e => [`${e.inicio}|${e.fim}|${e.descricao}|${e.complemento}`, e])).values()];

    const ref = db.collection('plano_acao_semestres').doc(semestre);
    const atual = (await ref.get()).data() || {};
    const prazos = {};
    const pendencias = [];
    for (const a of atividades.filter(x => x.ativo !== false)) {
        const daDirecao = ((atual.prazos || {})[a.id] || []).filter(p => p.origem === 'direcao');
        let doCalendario = [];
        if (a.calendario) {
            const re = new RegExp(a.calendario.evento, 'i');
            const datas = new Map();
            eventos.filter(e => re.test(e.descricao)).forEach(e => {
                const data = a.calendario.quando === 'inicio' ? e.inicio : e.fim;
                if (data >= inicio && data <= fim) datas.set(data, { data, origem: 'calendario', evento: e.complemento ? `${e.descricao} – ${e.complemento}` : e.descricao });
            });
            doCalendario = [...datas.values()];
        }
        const lista = [...doCalendario, ...daDirecao].sort((x, y) => x.data.localeCompare(y.data));
        if (lista.length) prazos[a.id] = lista;
        else if (!['diario', 'semanal', 'mensal'].includes(a.periodicidade)) pendencias.push(a);
    }

    const inicioAcompanhamento = inicioAcompArg || atual.inicioAcompanhamento || inicio;
    await ref.set({
        semestre, calendarioEdubox: semcal, inicio, fim, inicioAcompanhamento,
        naoLetivos, eventos, prazos,
        calendarioAtualizadoEm: new Date().toISOString()
    }, { merge: false });

    console.log(`\nSemestre ${semestre} (calendário ${semcal}): ${inicio} a ${fim}; atraso conta a partir de ${inicioAcompanhamento}.`);
    console.log(`Dias sem aula: ${Object.keys(naoLetivos).length}. Eventos: ${eventos.length}.`);
    console.log(`Prazos vindos do calendário: ${Object.values(prazos).flat().filter(p => p.origem === 'calendario').length}.`);
    for (const a of atividades) if (prazos[a.id]) console.log(`  ${a.id} ${prazos[a.id].map(p => p.data).join(', ')}  ${a.titulo.slice(0, 70)}`);
    console.log(`\nPendência de data (Direção define na tela): ${pendencias.length}`);
    pendencias.forEach(a => console.log(`  ${a.id} [${a.periodicidade}] ${a.titulo.slice(0, 90)}`));
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
