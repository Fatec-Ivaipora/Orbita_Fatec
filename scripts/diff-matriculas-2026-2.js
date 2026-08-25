// Compara os registros já lançados no Órbita (Financeiro > Matrículas) com a
// planilha nova, SÓ para o semestre 2026.2 (Fatec + Medicina). Não grava nada
// — é só um raio-x pra decidir a estratégia de atualização com segurança
// (o sistema pode ter edições manuais feitas depois da migração original,
// então um "apagar tudo e reimportar" pode perder informação).
//
//   node scripts/diff-matriculas-2026-2.js

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PLANILHA_PATH = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/PLANILHA GERAL DE ALUNOS - NOVA.xlsx';
const COL_ALUNOS = 'matriculas_alunos';
const SEMESTRE = '2026.2';

const ABAS = [
    { sheet: 'Matriz Fatec 2026.2', modulo: 'fatec' },
    { sheet: 'Matriz Medicina 2026.2', modulo: 'medicina' }
];

const COL = { nome: 0, curso: 1, periodo: 2, cidade: 3, planoConfissao: 4, situacao: 5, telefone: 6, observacoes: 7 };

const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

const CURSO_ALIASES = {
    'ARQUITETURA': 'ARQUITETURA URB.',
    'CIÊNCIAS CONTÁBEIS': 'CONTÁBEIS',
    'ENGENHARIA CIVIL': 'ENGENHARIA CÍVIL',
    'MEDICINA VETERINARIA': 'MEDICINA VETERINÁRIA'
};
function nomeCursoParaBusca(nomeOriginal) {
    return CURSO_ALIASES[norm(nomeOriginal)] || nomeOriginal;
}

function chaveComparacao(texto) {
    let t = (texto || '').toString().replace(/[–—]/g, '-').trim().replace(/\s+/g, ' ');
    t = t.replace(/[\s.\-]*\d{4}[.\/]\d\s*$/, '').trim();
    return t.toUpperCase();
}
function construirMapa(paresRaw) {
    const mapa = new Map();
    paresRaw.forEach(([raw, canonico]) => mapa.set(chaveComparacao(raw), canonico));
    return mapa;
}
const MAPA_SITUACAO = construirMapa([
    ['Rematrícula Assinada', 'Rematrícula Assinada'], ['Matrícula Nova - Assinada', 'Matrícula Nova - Assinada'],
    ['Matrícula Nova – Assinada', 'Matrícula Nova - Assinada'], ['Matrícula Nova', 'Matrícula Nova'],
    ['Cancelou', 'Cancelou'], ['Cancelado', 'Cancelou'], ['Trancou', 'Trancou'],
    ['1ª Evasão', '1ª Evasão'], ['2ª Evasão', '2ª Evasão'], ['Retorno', 'Retorno'],
    ['Mudança Curso', 'Mudança de Curso'], ['Mudança de Curso', 'Mudança de Curso'],
    ['Desistente', 'Desistente'], ['Pendência Financeira', 'Pendência Financeira'],
    ['Não Assinou', 'Não Assinou'], ['Transferiu', 'Transferência'], ['Transferência', 'Transferência'],
    ['Transferido', 'Transferência'], ['Reprovado', 'Reprovado'], ['Reprovou', 'Reprovado'],
    ['Retido', 'Reprovado'], ['Formando', 'Formando'], ['Formandos', 'Formando']
]);
const MAPA_PLANO = construirMapa([
    ['Não', 'Não'], ['Nao', 'Não'], ['Sim', 'Sim'],
    ['PROUNI Integral', 'PROUNI Integral'], ['PROUNI Parcial', 'PROUNI Parcial'],
    ['PROUNI A.A Integral', 'PROUNI Integral (Anos Anteriores)'],
    ['PROUNI A.A Parcial', 'PROUNI Parcial (Anos Anteriores)'], ['Pravaler', 'Pravaler']
]);
function normalizarSituacao(v) { return MAPA_SITUACAO.get(chaveComparacao(v)) || null; }
function normalizarPlano(v) { if (!v || !v.toString().trim()) return 'Não'; return MAPA_PLANO.get(chaveComparacao(v)) || null; }

function chaveAluno(modulo, nome, cursoNome) {
    return modulo === 'medicina' ? `MED|${norm(nome)}` : `FAT|${norm(nome)}|${norm(cursoNome)}`;
}

async function main() {
    console.log(`Lendo planilha: ${PLANILHA_PATH}`);
    const wb = XLSX.readFile(PLANILHA_PATH);

    console.log('Buscando cursos cadastrados em `courses`...');
    const cursosSnap = await db.collection('courses').get();
    const cursoPorNome = {};
    cursosSnap.forEach(d => { cursoPorNome[norm(d.data().name)] = { id: d.id, ...d.data() }; });

    // ---- Lado planilha ----
    const planilhaMap = new Map(); // chave -> [registros]
    const cursosNaoEncontrados = new Set();
    for (const aba of ABAS) {
        const sheet = wb.Sheets[aba.sheet];
        if (!sheet) { console.log(`AVISO: aba "${aba.sheet}" não encontrada.`); continue; }
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }).slice(1);
        for (const row of rows) {
            const nome = (row[COL.nome] || '').toString().trim();
            if (!nome) continue;

            let cursoNome = 'Medicina';
            if (aba.modulo === 'fatec') {
                const cursoOriginal = (row[COL.curso] || '').toString().trim();
                const curso = cursoPorNome[norm(nomeCursoParaBusca(cursoOriginal))];
                if (!curso) { cursosNaoEncontrados.add(cursoOriginal || '(vazio)'); continue; }
                cursoNome = curso.name;
            }

            const registro = {
                modulo: aba.modulo,
                curso: cursoNome,
                periodo: (row[COL.periodo] || '').toString().trim(),
                nome,
                cidade: (row[COL.cidade] || '').toString().trim(),
                telefone: (row[COL.telefone] || '').toString().trim(),
                situacao: normalizarSituacao((row[COL.situacao] || '').toString().trim()),
                planoConfissao: normalizarPlano((row[COL.planoConfissao] || '').toString().trim()),
                observacoes: (row[COL.observacoes] || '').toString().trim(),
                situacaoOriginalPlanilha: (row[COL.situacao] || '').toString().trim() || null
            };
            const chave = chaveAluno(aba.modulo, nome, cursoNome);
            if (!planilhaMap.has(chave)) planilhaMap.set(chave, []);
            planilhaMap.get(chave).push(registro);
        }
    }

    // ---- Lado sistema (Firestore) ----
    console.log('Buscando registros já lançados no sistema para 2026.2 (fatec + medicina)...');
    const snap = await db.collection(COL_ALUNOS).where('semestre', '==', SEMESTRE).get();
    const sistemaMap = new Map();
    snap.forEach(d => {
        const x = d.data();
        if (x.modulo !== 'fatec' && x.modulo !== 'medicina') return;
        const chave = chaveAluno(x.modulo, x.nome, x.curso);
        if (!sistemaMap.has(chave)) sistemaMap.set(chave, []);
        sistemaMap.get(chave).push({ id: d.id, ...x });
    });

    // ---- Comparação ----
    const iguais = [];
    const divergentes = [];
    const duplicadosSistema = [];
    const duplicadosPlanilha = [];
    const somenteNaPlanilha = [];
    const somenteNoSistema = [];

    const todasChaves = new Set([...planilhaMap.keys(), ...sistemaMap.keys()]);
    const CAMPOS_COMPARAR = ['periodo', 'cidade', 'telefone', 'situacao', 'planoConfissao', 'observacoes'];

    for (const chave of todasChaves) {
        const naPlanilha = planilhaMap.get(chave) || [];
        const noSistema = sistemaMap.get(chave) || [];

        if (naPlanilha.length > 1) { duplicadosPlanilha.push({ chave, registros: naPlanilha }); continue; }
        if (noSistema.length > 1) { duplicadosSistema.push({ chave, registros: noSistema }); continue; }

        if (naPlanilha.length === 1 && noSistema.length === 0) { somenteNaPlanilha.push(naPlanilha[0]); continue; }
        if (naPlanilha.length === 0 && noSistema.length === 1) { somenteNoSistema.push(noSistema[0]); continue; }

        const p = naPlanilha[0], s = noSistema[0];
        const diffs = CAMPOS_COMPARAR.filter(c => (p[c] || '') !== (s[c] || ''));
        if (diffs.length === 0) iguais.push({ chave, sistema: s });
        else divergentes.push({ chave, planilha: p, sistema: s, camposDiferentes: diffs });
    }

    console.log('\n===== RESUMO DIFF 2026.2 (Fatec + Medicina) =====');
    console.log(`Iguais (nada a fazer): ${iguais.length}`);
    console.log(`Divergentes (situação/dado mudou): ${divergentes.length}`);
    console.log(`Só na planilha (aluno novo, não está no sistema): ${somenteNaPlanilha.length}`);
    console.log(`Só no sistema (não aparece mais na planilha nova): ${somenteNoSistema.length}`);
    console.log(`Duplicados no sistema (mesmo nome+curso, ${duplicadosSistema.length} chaves — não mexo sem revisão): ${duplicadosSistema.reduce((a, d) => a + d.registros.length, 0)} registros`);
    console.log(`Duplicados na planilha (mesmo nome+curso, ${duplicadosPlanilha.length} chaves — não mexo sem revisão): ${duplicadosPlanilha.reduce((a, d) => a + d.registros.length, 0)} registros`);
    if (cursosNaoEncontrados.size) console.log(`\nCurso(s) da planilha não encontrados em 'courses': ${[...cursosNaoEncontrados].join(', ')}`);

    console.log('\n--- Amostra de divergentes (até 15) ---');
    divergentes.slice(0, 15).forEach(d => {
        console.log(`${d.sistema.nome} (${d.sistema.curso}) — campos: ${d.camposDiferentes.join(', ')}`);
        d.camposDiferentes.forEach(c => console.log(`   ${c}: sistema="${d.sistema[c] || ''}" -> planilha="${d.planilha[c] || ''}"`));
    });

    const fs = require('fs');
    const outPath = require('path').join(__dirname, '..', '..', 'diff-matriculas-2026-2-resultado.json');
    fs.writeFileSync(outPath, JSON.stringify({ iguais, divergentes, somenteNaPlanilha, somenteNoSistema, duplicadosSistema, duplicadosPlanilha }, null, 2), 'utf8');
    console.log(`\nResultado completo salvo em: ${outPath}`);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
