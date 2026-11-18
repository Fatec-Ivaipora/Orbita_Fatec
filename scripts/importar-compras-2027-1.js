// Importação (18/11/2026): levantamentos de materiais 2027/1 dos coordenadores → Financeiro › Licitação,
// licitação "COMPRAS SEMESTRAL 2027.1" (semestre técnico "2027.1", criada em 18/11/2026).
// Lê as planilhas da pasta COMPRAS (modelo "LEVANTAMENTO DE MATERIAIS - SEMESTRE 2027/1": QUANT, UNIDADE DE MEDIDA,
// MATERIAL / DESCRIÇÃO, PROFESSOR RESPONSÁVEL, PERIODICIDADE DE USO, DISCIPLINA/ATIVIDADE, JUSTIFICATIVA/FINALIDADE,
// OBSERVAÇÕES). As planilhas originais NÃO são alteradas.
//
// Regras:
// - Cada linha com material vira um item pendente (sem cotação) — a tela já mostra "FALTA LICITAÇÃO".
// - Quantidade: número puro → quantidade. "15 unidades", "4 galões" (um número + palavra) → quantidade 15 e unidade
//   "unidades". Texto que não dá pra reduzir a um número só ("20 cx P e 10 cx M", "1 litro de cada") → quantidade 1
//   e o texto inteiro vai na UNIDADE, pra quem cota ver exatamente o pedido. Quantidade vazia → 1.
// - linkReferencia: o link do produto (quando a planilha traz um) ou a coluna OBSERVAÇÕES.
// - O item não tem campo de disciplina/justificativa: esses textos ficam só na planilha original.
// - Não duplica: se já existir item no semestre 2027.1 com o mesmo curso + produto, pula.
//
// Dry-run por padrão:  node scripts/importar-compras-2027-1.js        (só mostra)
//                      node scripts/importar-compras-2027-1.js --commit (grava)

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PASTA = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/COMPRAS';
const SEMESTRE = '2027.1';
const COMMIT = process.argv.includes('--commit');
const COL_ITENS = 'financeiro_itens';

// arquivo → curso (id/nome da coleção `courses`, os mesmos já usados nos itens da Licitação)
const CURSOS = [
    { re: /MEDVET/i, cursoId: 'JN24YJ0vBzgCGqA1xSr9', curso: 'MEDICINA VETERINÁRIA' },
    { re: /BIOMED/i, cursoId: 'S34uO1F1RpK1cgv7SCEW', curso: 'BIOMEDICINA' },
    { re: /FISIO/i, cursoId: 'sSxsAcP8hgQ1FXFe3Ugz', curso: 'FISIOTERAPIA' },
    { re: /PEDAGOG/i, cursoId: 'aMmStzcyZMmj9u0bzeDn', curso: 'PEDAGOGIA' }
];

const limpa = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();
const norm = (s) => limpa(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

function quantidadeDe(raw, unidadeCol) {
    if (typeof raw === 'number' && raw > 0) return { quantidade: raw, unidade: unidadeCol };
    const t = limpa(raw);
    if (!t) return { quantidade: 1, unidade: unidadeCol };
    if (/^\d+([.,]\d+)?$/.test(t)) return { quantidade: parseFloat(t.replace(',', '.')), unidade: unidadeCol };
    const m = t.match(/^(\d+(?:[.,]\d+)?)\s*([A-Za-zÀ-ÿ.]+(?:\s+[A-Za-zÀ-ÿ.]+)?)$/); // "15 unidades", "4 galões", "20g"
    if (m && !/\bde\b|\be\b/i.test(m[2])) return { quantidade: parseFloat(m[1].replace(',', '.')), unidade: limpa(`${m[2]}${unidadeCol ? ` (${unidadeCol})` : ''}`) };
    return { quantidade: 1, unidade: unidadeCol ? `${t} — ${unidadeCol}` : t }; // texto composto: vai inteiro na unidade
}

function lerPlanilha(arquivo) {
    const wb = XLSX.read(fs.readFileSync(arquivo), { type: 'buffer' });
    const itens = [];
    wb.SheetNames.forEach(aba => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: '', raw: true });
        const iCab = rows.findIndex(r => r.some(c => norm(c) === 'QUANT') && r.some(c => /MATERIAL/.test(norm(c))));
        if (iCab < 0) return;
        const cab = rows[iCab].map(norm);
        const col = (re) => cab.findIndex(c => re.test(c));
        const c = { qtd: col(/^QUANT/), un: col(/^UNIDADE/), mat: col(/MATERIAL/), prof: col(/^PROFESSOR/), per: col(/^PERIODICIDADE/), disc: col(/^DISCIPLINA/), just: col(/^JUSTIFICATIVA/), obs: col(/^OBSERVA/) };
        rows.slice(iCab + 1).forEach((r, i) => {
            const produto = limpa(r[c.mat]);
            if (!produto) return;
            const q = quantidadeDe(r[c.qtd], limpa(r[c.un]));
            const link = [r[c.just], r[c.obs]].map(limpa).find(x => /^https?:\/\//i.test(x)) || '';
            const obs = limpa(r[c.obs]);
            itens.push({
                linha: iCab + i + 2, produto: produto.toUpperCase(), quantidade: q.quantidade, unidade: q.unidade,
                periodicidade: limpa(r[c.per]), professor: limpa(r[c.prof]),
                linkReferencia: link || (/^https?:\/\//i.test(obs) ? '' : obs),
                qtdOriginal: limpa(r[c.qtd])
            });
        });
    });
    return itens;
}

(async () => {
    const lic = await db.collection('financeiro_licitacoes').where('semestre', '==', SEMESTRE).get();
    if (lic.empty) throw new Error(`Não existe licitação com semestre ${SEMESTRE}.`);
    console.log(`Licitação: ${lic.docs[0].data().nome} (${SEMESTRE}) — ${COMMIT ? 'GRAVANDO' : 'DRY-RUN (nada é gravado)'}\n`);

    const jaSnap = await db.collection(COL_ITENS).where('semestre', '==', SEMESTRE).get();
    const ja = new Set(jaSnap.docs.map(d => `${d.data().cursoId}|${norm(d.data().produto)}`));

    const arquivos = fs.readdirSync(PASTA).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
    let total = 0, pulados = 0;
    const gravar = [];
    for (const f of arquivos) {
        const curso = CURSOS.find(x => x.re.test(f));
        if (!curso) { console.log(`?? ${f}: curso não reconhecido — pulado`); continue; }
        const itens = lerPlanilha(path.join(PASTA, f));
        console.log(`== ${f} → ${curso.curso}: ${itens.length} itens`);
        itens.forEach(it => {
            const k = `${curso.cursoId}|${norm(it.produto)}`;
            const dup = ja.has(k);
            if (dup) pulados++; else { ja.add(k); gravar.push({ ...curso, ...it }); total++; }
            const qtdTxt = it.qtdOriginal && String(it.quantidade) !== it.qtdOriginal ? ` [planilha: "${it.qtdOriginal}"]` : '';
            console.log(`  ${dup ? 'JÁ EXISTE ' : ''}L${it.linha}: ${it.quantidade} ${it.unidade || '-'} · ${it.produto.slice(0, 70)} · ${it.professor || '-'} · ${it.periodicidade || '-'}${qtdTxt}${it.linkReferencia ? ` · obs/link: ${it.linkReferencia.slice(0, 40)}` : ''}`);
        });
    }
    console.log(`\nNovos: ${total} · já existentes (pulados): ${pulados}`);
    if (!COMMIT) { console.log('Dry-run: rode com --commit para gravar.'); process.exit(0); }

    const agora = new Date().toISOString();
    for (let i = 0; i < gravar.length; i += 400) {
        const batch = db.batch();
        gravar.slice(i, i + 400).forEach(it => batch.set(db.collection(COL_ITENS).doc(), {
            cursoId: it.cursoId, curso: it.curso, semestre: SEMESTRE, produto: it.produto, quantidade: it.quantidade,
            unidade: it.unidade, periodicidade: it.periodicidade, professor: it.professor, linkReferencia: it.linkReferencia,
            status: 'pendente', cotacoes: [], createdAt: agora, createdBy: 'importacao-planilha-2027.1', updatedAt: agora
        }));
        await batch.commit();
    }
    console.log(`Gravados ${gravar.length} itens.`);
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
