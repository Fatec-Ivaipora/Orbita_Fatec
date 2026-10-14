// ==========================================================================
// Cruza o Relatório de Matrículas com os Contratos do Comercial (14/10/2026) — roda uma vez para os
// dados que já existem; daqui pra frente a sincronização é automática (src/rotas/contratos.js).
//
//   node scripts/vincular-matriculas-contratos.js            -> só mostra o que faria (não grava)
//   node scripts/vincular-matriculas-contratos.js --aplicar  -> grava
//
// Para cada calouro ("Matrícula Nova…") dos semestres do Contratos: vincula ao contrato de mesmo nome
// (sem duplicar) ou cria o contrato; o status segue a situação da matrícula (assinado continua assinado).
// Não imprime nome de aluno.
// ==========================================================================
const path = require('path');
const { db } = require(path.join(__dirname, '..', 'src', 'firebase'));
const { PRIMEIRO_SEMESTRE_SYNC, sincronizarDaMatricula, statusDaMatricula, normNome, acharContrato, nomeParecido } = require(path.join(__dirname, '..', 'src', 'rotas', 'contratos'))._interno;

const aplicar = process.argv.includes('--aplicar');
(async () => {
    const cfg = await db.collection('config').doc('comercial_contratos').get();
    const semestres = ((cfg.exists && cfg.data().semestres) || ['2027.1']).filter(x => x >= PRIMEIRO_SEMESTRE_SYNC);   // 2026.2 fica de fora
    for (const sem of semestres) {
        const [mSnap, cSnap] = await Promise.all([
            db.collection('matriculas_alunos').where('semestre', '==', sem).get(),
            db.collection('comercial_contratos').where('semestre', '==', sem).get()
        ]);
        const contratos = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const nomesContrato = new Set(contratos.map(c => normNome(c.nome)));
        // calouros + quem cancelou/trancou/desistiu e já tem contrato (assinou e depois saiu)
        const calouros = mSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => /^Matrícula Nova/.test(m.situacao || '')
            || (statusDaMatricula(m.situacao, null) === 'desistente' && (contratos.some(c => c.matriculaId === m.id) || contratos.some(c => nomeParecido(c.nome, m.nome)))));
        const r = { calouros: calouros.length, jaVinculados: 0, vincular: 0, parecido: 0, criar: 0, ambiguo: 0, statusMuda: {}, criarPorStatus: {}, completa: {} };
        const usados = new Set();   // um contrato só vincula a uma matrícula
        for (const m of calouros) {
            const v = contratos.find(c => c.matriculaId === m.id);
            const achado = v ? { doc: v } : acharContrato(contratos.filter(c => !usados.has(c.id)), m.nome);
            if (achado.ambiguo) { r.ambiguo++; continue; }
            const c = achado.doc;
            if (c) {
                usados.add(c.id);
                if (v) r.jaVinculados++; else { r.vincular++; if (achado.como === 'parecido') r.parecido++; }
                const novo = statusDaMatricula(m.situacao, c.status);
                if (novo && novo !== c.status) { const k = `${c.status} → ${novo}`; r.statusMuda[k] = (r.statusMuda[k] || 0) + 1; }
            } else {
                const st = statusDaMatricula(m.situacao, null);
                r.criar++; r.criarPorStatus[st] = (r.criarPorStatus[st] || 0) + 1;
            }
            // o que o Comercial já preencheu no contrato completa a matrícula (só o que está vazio lá)
            if (c) {
                const completa = {};
                if (!m.vencimentoBoleto && c.vencimentoBoleto) completa.vencimentoBoleto = c.vencimentoBoleto;
                if (!m.telefone && c.contato) completa.telefone = c.contato;
                if (!m.cidade && c.cidade) completa.cidade = c.cidade;
                Object.keys(completa).forEach(k => { r.completa[k] = (r.completa[k] || 0) + 1; });
                if (aplicar && Object.keys(completa).length) { await db.collection('matriculas_alunos').doc(m.id).update(completa); Object.assign(m, completa); }
            }
            if (aplicar) await sincronizarDaMatricula(m.id, m, 'vínculo inicial', true);
        }
        const semMatricula = contratos.filter(c => !c.matriculaId && !usados.has(c.id)).length;
        console.log(`\n${sem}: ${r.calouros} calouros nas Matrículas · ${contratos.length} contratos`);
        console.log(`  vincular a contrato existente: ${r.vincular} (nome igual ${r.vincular - r.parecido}, nome parecido ${r.parecido})${r.jaVinculados ? ` · já vinculados: ${r.jaVinculados}` : ''}`);
        console.log(`  criar contrato novo: ${r.criar} ${JSON.stringify(r.criarPorStatus)}`);
        console.log(`  status que muda nos vinculados: ${JSON.stringify(r.statusMuda)}`);
        console.log(`  matrículas completadas com dado do contrato (só campo vazio): ${JSON.stringify(r.completa)}`);
        console.log(`  nome repetido (não vincula, conferir à mão): ${r.ambiguo}`);
        console.log(`  contratos sem matrícula correspondente (ficam como estão): ${semMatricula}`);
    }
    console.log(aplicar ? '\nGravado.' : '\nSimulação — nada foi gravado. Para gravar: --aplicar');
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
