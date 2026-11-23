// Calendário Acadêmico — carrega o calendário do Edubox (tca_calendario + tca_evento) para o Órbita, como
// MODELO para copiar (não publica nada). Roda aqui no computador (precisa do .env com EDUBOX_*):
//   node scripts/calendario-academico-importar.js 2026.1 2026.2
// Graduação = semcal "2026/1"; Medicina = semcal "2026-1". Se o semestre já existir no Órbita, não mexe
// (use --substituir para apagar e carregar de novo).
require('dotenv').config({ quiet: true });
const { db } = require('../src/firebase');
const { query } = require('../src/db-edubox');
const C = require('../src/utils/calendarioAcademico');

const args = process.argv.slice(2);
const substituir = args.includes('--substituir');
const semestres = args.filter(a => /^\d{4}\.[12]$/.test(a));
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function carregar(semestre, calendario) {
    const [ano, n] = semestre.split('.');
    const semcal = calendario === 'medicina' ? `${ano}-${n}` : `${ano}/${n}`;
    const id = `${semestre}__${calendario}`;
    const ja = await db.collection('calendario_academico_eventos').where('semestre', '==', semestre).get();
    const existentes = ja.docs.filter(d => d.data().calendario === calendario);
    if (existentes.length && !substituir) { console.log(`${id}: já tem ${existentes.length} evento(s) no Órbita — não mexi.`); return; }
    const { rows } = await query(
        `select c.dincal, c.dfical, c.comcal, e.deseve from tca_calendario c join tca_evento e on e.codeve = c.evecal
          where c.semcal = $1 order by c.dincal`, [semcal]);
    if (!rows.length) { console.log(`${id}: o Edubox não tem o calendário ${semcal}.`); return; }
    const todos = rows.map(r => ({ titulo: C.limpa(r.deseve), complemento: C.limpa(r.comcal), inicio: iso(r.dincal), fim: iso(r.dfical || r.dincal) }));
    const { inicio, fim, eventos } = C.recortarSemestre(todos, semestre);
    const agora = new Date().toISOString(), quem = 'carga do Edubox';
    const ops = existentes.map(d => (b) => b.delete(d.ref));
    eventos.forEach(e => {
        const tipo = C.classificar(e.titulo, e.complemento);
        const ref = db.collection('calendario_academico_eventos').doc();
        ops.push((b) => b.set(ref, { semestre, calendario, ...e, tipo, naAgenda: true, noSite: C.TIPOS[tipo].site, observacao: '', publicado: false, conferir: false, origem: `Edubox ${semcal}`, criadoEm: agora, criadoPor: quem, atualizadoEm: agora, atualizadoPor: quem }));
    });
    for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
    await db.collection('calendario_academico_semestres').doc(id).set({ semestre, calendario, status: 'modelo', inicio, fim, origem: `Edubox ${semcal}`, atualizadoEm: agora, atualizadoPor: quem, criadoEm: agora, criadoPor: quem }, { merge: true });
    console.log(`${id}: ${eventos.length} eventos (de ${rows.length} no Edubox ${semcal}) · semestre ${inicio} → ${fim}`);
}

(async () => {
    if (!semestres.length) { console.log('Uso: node scripts/calendario-academico-importar.js 2026.1 2026.2 [--substituir]'); process.exit(1); }
    for (const s of semestres) for (const cal of ['graduacao', 'medicina']) await carregar(s, cal);
    process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
