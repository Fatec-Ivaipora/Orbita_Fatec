// Uma pessoa só pode ter UMA matrícula por semestre (Fatec ou Medicina) — pedido do usuário, 09/11/2026.
// Pra trocar de curso/corrigir, edita-se a matrícula que já existe. Vale pro cadastro manual, edição do nome,
// virada de semestre e diferenças do Edubox. Compara pelo nome normalizado (sem acento, maiúsculo, espaços
// simples), gravado em cada matrícula no campo nomeNorm (as antigas: scripts/matriculas-nome-norm.js).
const { db } = require('../firebase');

const COL_ALUNOS = 'matriculas_alunos';
const nomeNorm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// devolve a matrícula que já existe pra esse nome no semestre (ignorando ignorarId), ou null
async function matriculaDuplicada(semestre, nome, ignorarId = null) {
    const n = nomeNorm(nome);
    if (!semestre || !n) return null;
    const snap = await db.collection(COL_ALUNOS).where('semestre', '==', semestre).where('nomeNorm', '==', n).limit(3).get();
    const d = snap.docs.find(x => x.id !== ignorarId);   // (homônimo confirmado ainda conta: quem cadastra confirma de novo)
    return d ? { id: d.id, ...d.data() } : null;
}

const mensagemDuplicada = (d) => `Já existe matrícula de ${d.nome} em ${d.semestre} (${d.modulo === 'medicina' ? 'Medicina' : d.curso} ${d.periodo || ''} — ${d.situacao}). `
    + 'Uma pessoa só pode ter uma matrícula por semestre: pra trocar de curso ou corrigir, edite a matrícula que já existe.';

module.exports = { nomeNorm, matriculaDuplicada, mensagemDuplicada };
