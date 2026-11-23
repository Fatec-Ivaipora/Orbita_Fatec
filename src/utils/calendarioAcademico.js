// Calendário Acadêmico (23/11/2026) — regras compartilhadas entre a rota, o script de carga do Edubox e os testes.
// - classificar(): tipo do evento pelo título (cor e se vai pro site por padrão)
// - recortarSemestre(): o calendário do Edubox mistura o fim do semestre anterior e eventos do seguinte;
//   aqui fica só o que é daquele semestre (do fim do anterior até o "ENCERRAMENTO DO SEMESTRE").
// - copiarEventos(): monta o semestre novo a partir de um anterior. Tudo anda em semanas inteiras (mantém o dia
//   da semana); feriado é recalculado pela data do ano novo (Carnaval, Paixão e Corpus Christi pela Páscoa).
// - avisos(): domingo, sábado, cai em feriado, fora do semestre.

const TIPOS = {
    feriado: { rotulo: 'Feriado', site: true },
    recesso: { rotulo: 'Recesso', site: true },
    letivo: { rotulo: 'Período letivo', site: true },
    avaliacao: { rotulo: 'Avaliações', site: true },
    prazo: { rotulo: 'Prazos', site: true },
    evento: { rotulo: 'Eventos acadêmicos', site: true },
    reuniao: { rotulo: 'Reuniões internas', site: false },
    outro: { rotulo: 'Outros', site: true }
};
const CALENDARIOS = { graduacao: 'Graduação', medicina: 'Medicina' };

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const limpa = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();

function classificar(titulo, complemento = '') {
    const t = sem(titulo), c = sem(complemento);
    if (/FERIADO/.test(t)) return 'feriado';
    if (/RECESSO/.test(t)) return 'recesso';
    if (/REUNIAO|CONSELHO|CADD|\bNDE\b|CONSUP|EQUIPE MULTIDISCIPLINAR|PLANEJAMENTO ACADEMICO/.test(t)) return 'reuniao';
    if (/2. CHAMADA|EXAME|PROVA|SEMANA DE AVALIACAO|AVALIACAO BIMESTRAL|AVALIACOES|TESTE DE PROGRESSO|SIMULADO/.test(t)) return 'avaliacao';
    if (/INICIO DO SEMESTRE|ENCERRAMENTO DO SEMESTRE|INICIO DAS AULAS|BIMESTRE/.test(t)) return 'letivo';
    if (/PRAZO|DATA LIMITE|REMATRICULA|PUBLICACAO|EDITAL|ABERTURA DO PROGRAMA|FECHAMENTO DO PROGRAMA|INSCRIC/.test(t)) return 'prazo';
    if (/AVALIACAO INSTITUCIONAL|AVALIACAO DO DESEMPENHO|AVALIACAO DOS 30 DIAS/.test(t)) return 'prazo';
    if (/EVENTO|MOSTRA|SEMINARIO|CERIMONIA|COLACAO|CONNECT|CONVENCAO|ARRAIA|ICAA|SEMANA|JALECO|LAMPADA|ENCONTRO|CICLO|VESTIBULAR|RODADA|COPA|DIA D[OE]|DATA COMEMORATIVA|PROJETO/.test(t + ' ' + c)) return 'evento';
    return 'outro';
}

// ---------- datas (sempre AAAA-MM-DD, sem fuso) ----------
const paraData = (iso) => { const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
const paraIso = (d) => d.toISOString().slice(0, 10);
const somaDias = (iso, n) => { const d = paraData(iso); d.setUTCDate(d.getUTCDate() + n); return paraIso(d); };
const diasEntre = (a, b) => Math.round((paraData(b) - paraData(a)) / 86400000);
const diaSemana = (iso) => paraData(iso).getUTCDay(); // 0 = domingo

// Páscoa (algoritmo de Meeus/Jones/Butcher)
function pascoa(ano) {
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}
// feriado móvel reconhecido pelo texto → dias em relação à Páscoa
const MOVEIS = [
    [/CINZAS/, -46], [/CARNAVAL/, -47], [/PAIXAO|SEXTA.FEIRA SANTA/, -2], [/PASCOA/, 0], [/CORPUS CHRISTI/, 60]
];
function dataDoFeriadoNoAno(evento, ano) {
    const txt = sem(`${evento.titulo} ${evento.complemento}`);
    const movel = MOVEIS.find(([re]) => re.test(txt));
    if (movel) return somaDias(pascoa(ano), movel[1]);
    return `${ano}${String(evento.inicio).slice(4, 10)}`; // feriado de data fixa: mesmo dia e mês
}

// O calendário do Edubox de um semestre ("2026/2") também traz o fim do anterior e, no do 1º semestre,
// eventos do 2º. Fica do dia seguinte ao encerramento anterior até o encerramento deste.
function recortarSemestre(eventos, semestre) {
    const [ano, n] = semestre.split('.');
    const piso = n === '1' ? `${ano}-01-01` : `${ano}-07-01`;
    const inicios = eventos.filter(e => /INICIO DO SEMESTRE LETIVO/.test(sem(e.titulo)) && e.inicio >= piso).map(e => e.inicio).sort();
    const inicio = inicios[0];
    if (!inicio) return { inicio: null, fim: null, eventos };
    const fim = eventos.filter(e => /ENCERRAMENTO DO SEMESTRE/.test(sem(e.titulo)) && e.inicio > inicio).map(e => e.inicio).sort()[0] || null;
    const encAnterior = eventos.filter(e => /ENCERRAMENTO DO SEMESTRE/.test(sem(e.titulo)) && e.inicio < inicio).map(e => e.inicio).sort().pop();
    const de = encAnterior ? somaDias(encAnterior, 1) : somaDias(inicio, -45);
    const ate = fim || somaDias(inicio, 200);
    const dentro = eventos.filter(e => e.inicio >= de && e.inicio <= ate);
    // a secretaria às vezes lança o mesmo evento duas vezes
    const unicos = [...new Map(dentro.map(e => [`${e.inicio}|${e.fim}|${sem(e.titulo)}|${sem(e.complemento)}`, e])).values()];
    return { inicio, fim, eventos: unicos };
}

// Semestre novo a partir de um anterior: desloca em semanas inteiras (de início a início) e recalcula feriados.
// Atualiza anos e semestres citados no texto: em 2026.1 → 2027.1, "2026.1" vira "2027.1", "2025" vira "2026" etc.
function atualizarAnos(texto, semestresAFrente) {
    const anos = Math.round(semestresAFrente / 2);
    return String(texto || '')
        .replace(/\b(20\d{2})\.([12])\b/g, (m, a, n) => { const idx = Number(a) * 2 + Number(n) - 1 + semestresAFrente; return `${Math.floor(idx / 2)}.${(idx % 2) + 1}`; })
        .replace(/\b(20\d{2})\b(?!\.[12]\b)/g, (m, a) => String(Number(a) + anos));
}
function copiarEventos(eventosBase, { inicioBase, inicioNovo, anoNovo, semestresAFrente = 0 }) {
    const semanas = Math.round(diasEntre(inicioBase, inicioNovo) / 7);
    const desloc = semanas * 7;
    return eventosBase.map(e => {
        let inicio = somaDias(e.inicio, desloc), fim = somaDias(e.fim || e.inicio, desloc);
        const duracao = diasEntre(e.inicio, e.fim || e.inicio);
        let regra = `${semanas} semanas depois (mesmo dia da semana)`;
        if (e.tipo === 'feriado') {
            const anoAlvo = Number(inicio.slice(0, 4)) || anoNovo;
            inicio = dataDoFeriadoNoAno(e, anoAlvo); fim = somaDias(inicio, duracao);
            regra = 'feriado recalculado para a data deste ano';
        }
        return { ...e, titulo: atualizarAnos(e.titulo, semestresAFrente), complemento: atualizarAnos(e.complemento, semestresAFrente), inicio, fim, conferir: true, regraCopia: regra };
    });
}

// Avisos de cada evento dentro do semestre (para o diretor conferir)
function avisos(evento, todos, semestre = {}) {
    const lista = [];
    const ds = diaSemana(evento.inicio);
    if (ds === 0) lista.push({ cod: 'domingo', nivel: 'erro', msg: 'Cai num domingo.' });
    else if (ds === 6 && !['feriado', 'recesso'].includes(evento.tipo)) lista.push({ cod: 'sabado', nivel: 'aviso', msg: 'Cai num sábado.' });
    if (evento.fim && evento.fim !== evento.inicio && diaSemana(evento.fim) === 0 && ['prazo', 'avaliacao'].includes(evento.tipo)) lista.push({ cod: 'fim-domingo', nivel: 'aviso', msg: 'O prazo termina num domingo.' });
    if (!['feriado', 'recesso'].includes(evento.tipo)) {
        // período longo que só "passa" por um feriado é normal: avisa quando começa ou termina nele (ou é de um dia)
        const noFeriado = (d, f) => d >= f.inicio && d <= (f.fim || f.inicio);
        const feriado = todos.find(f => f.id !== evento.id && f.calendario === evento.calendario && f.tipo === 'feriado' && (noFeriado(evento.inicio, f) || noFeriado(evento.fim || evento.inicio, f)));
        if (feriado) lista.push({ cod: 'feriado', nivel: 'erro', msg: `Cruza com o feriado de ${feriado.inicio.split('-').reverse().slice(0, 2).join('/')} (${limpa(feriado.complemento || feriado.titulo)}).` });
    }
    if (semestre.inicio && semestre.fim && (evento.fim < somaDias(semestre.inicio, -60) || evento.inicio > somaDias(semestre.fim, 15))) lista.push({ cod: 'fora', nivel: 'aviso', msg: 'Fora do período do semestre.' });
    if (evento.tipo === 'recesso' && evento.conferir) lista.push({ cod: 'recesso', nivel: 'aviso', msg: 'Recesso copiado: confira se ainda acompanha o feriado.' });
    return lista;
}

// ---------- DIAS LETIVOS (23/11/2026) — mesma conta da planilha "DIAS LETIVOS - CALENDÁRIO 2025" ----------
// Conta segunda a sábado entre o primeiro e o último dia letivo, sem os dias de feriado e de recesso
// (evento do tipo feriado/recesso, ou que diga RECESSO no texto). Domingo nunca conta.
const naoLetivo = (e) => e.tipo === 'feriado' || e.tipo === 'recesso' || /RECESSO/.test(sem(e.titulo + ' ' + (e.complemento || '')));
function limitesLetivos(eventos) {
    const t = (re) => eventos.filter(e => re.test(sem(e.titulo))).map(e => e.inicio).sort();
    const de = t(/INICIO DAS AULAS/)[0] || t(/INICIO DO SEMESTRE LETIVO/)[0] || null;
    const ate = t(/TERMINO DO 2. ?BIMESTRE/).filter(d => !de || d > de).pop() || t(/ENCERRAMENTO DO SEMESTRE/).filter(d => !de || d > de)[0] || null;
    return { de, ate };
}
function diasLetivos(eventos, de, ate) {
    const fora = new Map();
    eventos.filter(naoLetivo).forEach(e => { for (let d = e.inicio; d <= (e.fim || e.inicio); d = somaDias(d, 1)) if (!fora.has(d)) fora.set(d, limpa(e.complemento || e.titulo)); });
    const porMes = {}, descontados = [];
    let total = 0;
    if (de && ate && de <= ate) for (let d = de; d <= ate; d = somaDias(d, 1)) {
        const ds = diaSemana(d); if (ds === 0) continue;
        if (fora.has(d)) { descontados.push({ data: d, motivo: fora.get(d) }); continue; }
        const mes = d.slice(0, 7); (porMes[mes] = porMes[mes] || [0, 0, 0, 0, 0, 0])[ds - 1]++; total++;
    }
    return { de, ate, porMes, total, descontados };
}

module.exports = { diasLetivos, limitesLetivos, atualizarAnos, TIPOS, CALENDARIOS, classificar, recortarSemestre, copiarEventos, avisos, pascoa, somaDias, diasEntre, diaSemana, limpa, sem };
