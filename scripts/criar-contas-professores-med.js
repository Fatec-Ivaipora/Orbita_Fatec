// Cria as contas do Órbita dos professores da Medicina que estão no Edubox 2026.2 e ainda não têm acesso (16/11/2026).
// Uso (o final da senha é informado por quem roda; a senha fica <primeiro nome><final>, ex.: "amanda" + final):
//   node scripts/criar-contas-professores-med.js <final-da-senha>
// - cargo professor_medicina, e-mail nome.sobrenome@orbitamedfatec.com.br, troca de senha obrigatória no 1º acesso;
// - pula quem já tem conta (mesmo e-mail no Firebase Auth);
// - acrescenta os logins em CLAUDE\logins-professores-medicina.txt.
// Coordenadores que dão aula na MED (José Henrique, Paulo Góes, Tatiane Borzuk) NÃO entram aqui: usam a conta de
// coordenação + users.professorMedicina e a permissão do usuário banco-med-fatec (menu Medicina com o Banco).
process.chdir(__dirname + '/..');
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { db, auth } = require('../src/firebase');

const PROFESSORES = [
    'Adriano Teixeira Gostinski', 'Amanda Danielle Cruz', 'Amanda Monteiro Bonancea', 'Annika Paula Cecagno',
    'Bruna Helena Gonçalves Esteves', 'Chiara Kerolaine Beletato', 'Fabio da Silva Leao', 'Francielly Fachin',
    'Fredericka Waleska Strickert', 'Ivana Regina da Costa', 'Maria Rita Menegazzo Del Bel', 'Paulo Vitor Vicente Rosado',
    'Polyana de Souza Costa', 'Rodrigo Trindade Limongi Marques de Abreu', 'Sarah Beatriz Obadovski Alves Nascimento'
];
const ARQ_LOGINS = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/logins-professores-medicina.txt';
const semAcento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const LIGA = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
function emailDe(nome) {
    const ws = semAcento(nome).split(/\s+/).filter(w => !LIGA.has(w));
    // "Del Bel" vira um sobrenome só
    const ult = ws.length >= 3 && ws[ws.length - 2] === 'del' ? 'del' + ws[ws.length - 1] : ws[ws.length - 1];
    return `${ws[0]}.${ult}@orbitamedfatec.com.br`;
}

(async () => {
    const final = String(process.argv[2] || '').trim();
    if (final.length < 3) { console.log('Informe o final da senha: node scripts/criar-contas-professores-med.js <final>'); process.exit(1); }
    const agora = new Date().toISOString();
    const criados = [];
    for (const nome of PROFESSORES) {
        const email = emailDe(nome);
        const existe = await auth.getUserByEmail(email).then(() => true).catch(() => false);
        if (existe) { console.log('já existe, pulei:', email); continue; }
        const senha = semAcento(nome.split(' ')[0]) + final;
        const r = await auth.createUser({ email, password: senha, displayName: nome });
        await db.collection('users').doc(r.uid).set({
            uid: r.uid, name: nome, email, role: 'professor_medicina', cursos: [], ativo: true,
            primeiroAcesso: true, primeiroAcessoDesde: agora, createdAt: agora, createdBy: 'script criar-contas-professores-med'
        });
        criados.push({ nome, email, senha });
        console.log('criado:', nome, '<' + email + '>');
    }
    if (criados.length) {
        const linhas = criados.map(c => `${c.nome.padEnd(39)}| ${c.email.padEnd(41)}| ${c.senha}`).join('\n');
        fs.appendFileSync(ARQ_LOGINS, `\n\nContas criadas em 16/11/2026 (professores do Edubox 2026.2 sem acesso):\n${linhas}\n`, 'utf8');
    }
    console.log(`\n${criados.length} conta(s) criada(s); logins acrescentados em ${ARQ_LOGINS}`);
    process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
