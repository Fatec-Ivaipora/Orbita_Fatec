// ==========================================================================
// Grafia padrão das cidades (17/11/2026) — a mesma cidade aparecia de vários jeitos nas Matrículas e no
// Comercial ("CANDIDO DE ABREU" x "CÂNDIDO DE ABREU", "Ivaiporã" x "IVAIPORÃ", "CRUZMANTINA"). Toda cidade
// que entra no Órbita (digitada ou vinda do Edubox) passa por cidadeCanonica: sai em MAIÚSCULO, com o
// acento do nome oficial (IBGE). Cidade fora da lista fica como foi digitada, só em maiúsculo.
// Para acrescentar uma cidade, ponha o nome oficial em CIDADES_OFICIAIS.
// ==========================================================================
const CIDADES_OFICIAIS = [
    // Vale do Ivaí e região
    'IVAIPORÃ', 'JARDIM ALEGRE', 'MANOEL RIBAS', 'SÃO JOÃO DO IVAÍ', 'CÂNDIDO DE ABREU', 'FAXINAL', 'LUNARDELLI',
    'LIDIANÓPOLIS', 'ARAPUÃ', 'GRANDES RIOS', 'NOVA TEBAS', 'BORRAZÓPOLIS', 'ARIRANHA DO IVAÍ', 'CRUZMALTINA',
    'GODOY MOREIRA', 'ROSÁRIO DO IVAÍ', 'RIO BRANCO DO IVAÍ', 'SÃO PEDRO DO IVAÍ', 'PITANGA', 'MAUÁ DA SERRA',
    'BARBOSA FERRAZ', 'FÊNIX', 'ORTIGUEIRA', 'RESERVA', 'PALMITAL', 'SANTA MARIA DO OESTE', 'TELÊMACO BORBA',
    'MARUMBI', 'KALORÉ', 'BOM SUCESSO', 'JANDAIA DO SUL', 'MARILÂNDIA DO SUL', 'CALIFÓRNIA', 'ROSÁRIO DO IVAÍ',
    // outras do Paraná
    'APUCARANA', 'ARAPONGAS', 'LONDRINA', 'MARINGÁ', 'CURITIBA', 'PONTA GROSSA', 'GUARAPUAVA', 'CASCAVEL',
    'CAMPO MOURÃO', 'CAMBÉ', 'CAMBARÁ', 'ROLÂNDIA', 'MANDAGUARI', 'MARIALVA', 'CORNÉLIO PROCÓPIO', 'CARLÓPOLIS',
    'PRUDENTÓPOLIS', 'NOVA SANTA BÁRBARA', 'NOVA LONDRINA', 'NOVA PRATA DO IGUAÇU', 'FRANCISCO BELTRÃO', 'GOIOXIM',
    'LAPA', 'LOANDA', 'PONTAL DO PARANÁ', 'SANTA LÚCIA', 'TAGUAÍ', 'GUARACI', 'IGUATEMI', 'PONTO BELO',
    // fora do Paraná
    'GOIÂNIA', 'CUIABÁ', 'ESPÍRITO SANTO', 'CAMPO VERDE', 'MANAUS', 'MACAPÁ', 'BELÉM', 'ITAPEMA', 'RIO PARDO DE MINAS'
];
// erros de digitação já vistos -> nome certo
const APELIDOS = { 'CRUZMANTINA': 'CRUZMALTINA', 'RIO BRANDO DO IVAI': 'RIO BRANCO DO IVAÍ', 'GUARAC': 'GUARACI' };

const chaveCidade = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
const MAPA = new Map(CIDADES_OFICIAIS.map(c => [chaveCidade(c), c]));
Object.entries(APELIDOS).forEach(([errado, certo]) => MAPA.set(chaveCidade(errado), certo));

function cidadeCanonica(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return MAPA.get(chaveCidade(t)) || t.toUpperCase();
}

module.exports = { cidadeCanonica, chaveCidade, CIDADES_OFICIAIS };
