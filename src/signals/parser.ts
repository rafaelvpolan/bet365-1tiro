// ─── PARSER + CLASSIFICADOR DE MENSAGENS (puro, sem estado) ────────────────────
// Módulo compartilhado entre o bot (index.ts) e o coletor (coletor.ts) para que
// a lógica de detecção seja EXATAMENTE a mesma nos dois — nada de drift.

export interface propsBet {
    liga: string | null
    hora: string | null
    minutos: Array<number>
    entrada: Array<string>
}

export const LIGAS = ['EURO', 'COPA', 'PREMIER', 'SUPER'];

export function parseMensagem(texto: string): propsBet {
    // Remove marcadores de formatação (negrito/itálico) que partem números:
    // "⏰ 4**9**" → "⏰ 49"; "24-27-3**0**" → "24-27-30".
    texto = (texto ?? '').replace(/[*_~`]+/g, '');

    // Liga
    const liga = LIGAS.find(l => texto.toUpperCase().includes(l)) || null;

    // Hora (aceita "⏰ H: 12", "H:12", "H: 12h", "Hora: 12")
    const horaMatch = texto.match(/H(?:ora)?\s*:?\s*(\d{1,2})/i);
    const hora = horaMatch ? horaMatch[1] : null;

    // Minutos — dois formatos reais:
    //  A) "⏰ H: 23 ➡ 52 55 58 01"  → minutos depois do ➡ (ROBÔ OVER).
    //  B) "⏰ 52" | "⏰ 42-45" | "⏰ 06-09-12"  → minutos no segmento do ⏰ (BRUXÃO/ELITE),
    //     sem ➡ e sem H:. Os números separados por "-"/espaço são os tiros/gales.
    let minutos: number[] = [];
    const setaIdx = texto.search(/➡/);
    if (setaIdx >= 0) {
        const linha = texto.slice(setaIdx).split('\n')[0];
        minutos = (linha.match(/\d{1,2}/g) ?? []).map(Number).filter(n => n >= 0 && n <= 59);
    } else {
        // BRUXÃO "⏰ 52 / 42-45"  ·  ELITE "🔜TEMPO 08 46"  ·  BRUU "⏱ 01 04".
        // Captura só dígitos/espaço/hífen (não cruza a linha) após ⏰/⏱/TEMPO.
        const m = texto.match(/(?:⏰|⏱|TEMPO)\s*:?\s*([\d \-]+)/i);
        if (m) minutos = (m[1].match(/\d{1,2}/g) ?? []).map(Number).filter(n => n >= 0 && n <= 59);
    }

    // Entrada: todos os minutos formatados como "hora:minuto" (usado como fallback)
    const entrada = minutos.map(min => `${hora}:${String(min).padStart(2, '0')}`);

    return { liga, hora, minutos, entrada };
}

// ─── CLASSIFICAÇÃO: SINAL vs RESULTADO ─────────────────────────────────────────

// É SINAL de entrada se tiver LIGA + MINUTOS. A hora é OPCIONAL: o formato BRUXÃO
// ("SUPER ⏰ 52 AMBAS MARCAM") não traz hora (usa minuto de jogo), só o ROBÔ OVER traz.
export function isSignal(texto: string): boolean {
    if (!texto) return false;
    const m = parseMensagem(texto);
    return !!m.liga && m.minutos.length > 0;
}

// Palavras/emojis que indicam resultado.
export const RE_GREEN = /(green|bateu|ganhou|ganho|✅|✔️|🟢|win\b)/i;
export const RE_RED   = /(\bred\b|perdeu|perda|\bloss\b|stop\s*loss|🔴|❌|🚫)/i;

// Classifica uma mensagem como resultado (green/red). Retorna null se não for.
// `forcar=true` ignora o filtro isSignal (útil para uma msg de sinal EDITADA que
// passou a conter GREEN — ela ainda parseia como sinal, mas agora é resultado).
export function isResultado(texto: string, forcar = false): { green: boolean; red: boolean } | null {
    if (!texto) return null;
    if (!forcar && isSignal(texto)) return null;
    const green = RE_GREEN.test(texto);
    const red   = RE_RED.test(texto);
    if (!green && !red) return null;
    return { green, red };
}

// Extrai a ODD (ex.: "@1.85", "ODD 1,90", "odd: 1.9", ou um decimal solto 1.xx–99.xx).
export function extrairOdd(texto: string): number | null {
    if (!texto) return null;
    const m = texto.match(/(?:odd|@|cota)\s*:?\s*(\d{1,2}[.,]\d{1,2})/i)
        ?? texto.match(/\b(\d{1,2}[.,]\d{1,2})\b/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    return (!isNaN(n) && n > 1 && n < 100) ? n : null;
}

// É um sinal de ODD de FUTEBOL VIRTUAL? (as ligas EURO/COPA/PREMIER/SUPER da bet365
// são exatamente os campeonatos de futebol virtual). Aceita com ou sem odd explícita.
export function isSinalFutebolVirtual(texto: string): boolean {
    return isSignal(texto);
}

// Critério de ARMAZENAMENTO do coletor: menciona a LIGA e os MINUTOS (a hora é
// opcional aqui — nem todo grupo põe o ⏰ H:, mas Liga + minutos já caracteriza o sinal).
export function temLigaEMinutos(texto: string): boolean {
    const m = parseMensagem(texto);
    return !!m.liga && m.minutos.length > 0;
}

// Todos os minutos (0–59) citados num texto — usado p/ casar um GREEN a um sinal.
// Ex.: "⏰ 39-42" → [39,42]; "TEMPO 27 30" → [27,30].
export function extrairMinutosMencionados(texto: string): number[] {
    return [...String(texto ?? '').matchAll(/\b(\d{1,2})\b/g)]
        .map(m => Number(m[1]))
        .filter(n => n >= 0 && n <= 59);
}

// Extrai liga + hora citadas num texto de resultado (para casar com sinal ativo).
export function extrairReferencia(texto: string): { liga: string | null; hora: string | null } {
    texto = texto ?? '';
    const liga = LIGAS.find(l => texto.toUpperCase().includes(l)) || null;
    const horaMatch = texto.match(/H(?:ora)?\s*:?\s*(\d{1,2})/i) ?? texto.match(/\b(\d{1,2})\s*[:h]/i);
    const hora = horaMatch ? horaMatch[1] : null;
    return { liga, hora };
}
