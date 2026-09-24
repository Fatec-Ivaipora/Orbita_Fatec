// Migração única: puxa os registros ao vivo da planilha Google (Apps Script) do
// app avulso "classificador-reprovados-dp.html" e grava no Firestore, coleção
// `secretaria_dp_registros`, para alimentar o módulo Relatório DP do Órbita.
// A planilha Google NÃO é apagada — continua servindo de backup/histórico.
// Rodar uma única vez: node scripts/migrar-secretaria-dp.js
//
// Variáveis de ambiente necessárias (no .env):
//   SECRETARIA_DP_URL   — URL completa da implantação do Apps Script
//   SECRETARIA_DP_TOKEN — token de acesso configurado no Apps Script

require('dotenv').config();
const { db } = require('../src/firebase');

const BASE_URL = process.env.SECRETARIA_DP_URL;
const TOKEN    = process.env.SECRETARIA_DP_TOKEN;
const COL_REGISTROS = 'secretaria_dp_registros';

if (!BASE_URL || !TOKEN) {
    console.error('Erro: defina SECRETARIA_DP_URL e SECRETARIA_DP_TOKEN no .env antes de rodar.');
    process.exit(1);
}

function dedupKey(curso, nome, turma, disciplina) {
    return [curso, nome, turma, disciplina]
        .map(v => (v || '').trim().toUpperCase())
        .join('|');
}

async function main() {
    console.log('Buscando registros ao vivo da planilha Google...');
    const res = await fetch(`${BASE_URL}?token=${encodeURIComponent(TOKEN)}`);
    if (!res.ok) throw new Error(`Falha de rede (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Erro desconhecido retornado pela planilha');

    const registros = data.records || [];
    console.log(`${registros.length} registros lidos da planilha.`);

    const existentesSnap = await db.collection(COL_REGISTROS).select('dedupKey').get();
    const seenKeys = new Set();
    existentesSnap.forEach(doc => seenKeys.add(doc.data().dedupKey));
    console.log(`${seenKeys.size} registros já existentes no Firestore (não serão duplicados).`);

    const paraGravar = [];
    registros.forEach(rec => {
        const { curso, nome, turma, disciplina, professor, periodo, financeiro, status } = rec;
        if (!curso || !nome || !turma || !disciplina) return;
        const key = dedupKey(curso, nome, turma, disciplina);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        paraGravar.push({
            curso: String(curso).trim(),
            nome: String(nome).trim(),
            turma: String(turma).trim(),
            disciplina: String(disciplina).trim(),
            professor: (professor || '').trim(),
            periodo: (periodo || '').trim(),
            financeiro: (financeiro || '').trim(),
            status: status || 'A_CURSAR',
            origem: 'csv',
            dedupKey: key,
            createdAt: new Date().toISOString(),
            createdBy: 'migracao-planilha-dp',
            createdByName: 'Migração automática (planilha Google)'
        });
    });

    console.log(`${paraGravar.length} registros novos serão gravados no Firestore.`);
    if (!paraGravar.length) {
        console.log('Nada para migrar. Concluído.');
        return;
    }

    const chunks = [];
    for (let i = 0; i < paraGravar.length; i += 400) chunks.push(paraGravar.slice(i, i + 400));

    let gravados = 0;
    for (const chunk of chunks) {
        const batch = db.batch();
        chunk.forEach(dados => batch.set(db.collection(COL_REGISTROS).doc(), dados));
        await batch.commit();
        gravados += chunk.length;
        console.log(`Gravados ${gravados}/${paraGravar.length}...`);
    }

    console.log('Migração concluída com sucesso!');
}

main().catch(err => {
    console.error('Erro na migração:', err);
    process.exit(1);
});
