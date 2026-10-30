/**
 * Conhecimentos Gerais por curso (30/10/2026): até agora a questão de Conhecimentos Gerais ficava SEM
 * curso (um pool só pra todos). Agora cada curso usa as suas, e o simulado só puxa as do curso — então
 * as antigas precisam ganhar um curso, senão somem dos simulados.
 *
 * De onde vem o curso de cada questão antiga:
 *   1. importada do Word: o curso das outras questões do MESMO lote (loteId) — é o curso da importação;
 *   2. cadastrada na mão: o curso de quem cadastrou (users/{createdBy}), se for um curso só;
 *   3. sem como saber: fica listada no fim pra resolver na mão.
 *
 * Uso:
 *   node scripts/conhecimentos-gerais-por-curso.js            (só mostra o que faria)
 *   node scripts/conhecimentos-gerais-por-curso.js --aplicar  (grava)
 */
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const snap = await db.collection('docencia_bp_questoes').where('disciplinaId', '==', 'geral').get();
  const semCurso = snap.docs.filter(d => !d.data().curso);
  console.log(`${snap.size} questão(ões) de Conhecimentos Gerais, ${semCurso.length} sem curso.`);

  const cursoDoLote = {};
  const cursoDoUsuario = {};
  const resolvidas = [];
  const pendentes = [];

  for (const doc of semCurso) {
    const q = doc.data();
    let curso = null, origem = null;
    if (q.loteId) {
      if (!(q.loteId in cursoDoLote)) {
        const irmas = await db.collection('docencia_bp_questoes').where('loteId', '==', q.loteId).get();
        const cursos = [...new Set(irmas.docs.map(d => d.data().curso).filter(Boolean))];
        cursoDoLote[q.loteId] = cursos.length === 1 ? cursos[0] : null;
      }
      curso = cursoDoLote[q.loteId];
      origem = 'lote';
    }
    if (!curso && q.createdBy) {
      if (!(q.createdBy in cursoDoUsuario)) {
        const u = await db.collection('users').doc(q.createdBy).get();
        const d = u.exists ? u.data() : {};
        const cursos = Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
        cursoDoUsuario[q.createdBy] = cursos.length === 1 ? cursos[0] : null;
      }
      curso = cursoDoUsuario[q.createdBy];
      origem = 'quem cadastrou';
    }
    (curso ? resolvidas : pendentes).push({ ref: doc.ref, id: doc.id, curso, origem, q });
  }

  const porCurso = {};
  resolvidas.forEach(r => { porCurso[r.curso] = (porCurso[r.curso] || 0) + 1; });
  console.log(`\nVão ganhar curso: ${resolvidas.length}`);
  Object.entries(porCurso).sort().forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  if (pendentes.length) {
    console.log(`\nSem como saber o curso (resolver na mão): ${pendentes.length}`);
    pendentes.forEach(p => console.log(`  ${p.id} | ${p.q.semestre || 'sem semestre'} | por ${p.q.createdPorNome || '?'} | ${String(p.q.enunciadoHtml || '').slice(0, 70)}`));
  }

  if (!APLICAR) {
    console.log('\nNada gravado. Rode com --aplicar pra gravar.');
    process.exit(0);
  }
  for (let i = 0; i < resolvidas.length; i += 400) {
    const batch = db.batch();
    resolvidas.slice(i, i + 400).forEach(r => batch.update(r.ref, { curso: r.curso, updatedAt: new Date().toISOString() }));
    await batch.commit();
  }
  console.log(`\n✅ ${resolvidas.length} questão(ões) atualizada(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
