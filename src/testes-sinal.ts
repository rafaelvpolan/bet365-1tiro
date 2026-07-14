import * as fs from "fs";
import * as path from "path";
import {
    parseMensagem, isSignal, isResultado, RE_GREEN, RE_RED, extrairReferencia,
    temLigaEMinutos, extrairOdd, extrairMinutosMencionados,
} from "./signals/parser";

// ─── BATERIA DE TESTES DO CLASSIFICADOR (offline, não conecta em nada) ─────────
// Rode:  npx ts-node src/testes-sinal.ts
// Se você já coletou dados, ele também reprocessa o relatório do coletor e mostra
// estatísticas sobre os textos REAIS.

let ok = 0, fail = 0;
const falhas: string[] = [];

const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

function check(nome: string, cond: boolean, extra = "") {
    if (cond) { ok++; console.log(`  ✅ ${nome}`); }
    else { fail++; falhas.push(nome); console.log(`  ❌ ${nome} ${extra}`); }
}

// ─── 1) CASOS SINTÉTICOS ────────────────────────────────────────────────────
// ⚠️ Formatos DEDUZIDOS do parser atual (⏰ H:, ➡, ligas). Ajuste/adicione casos
//    reais assim que o coletor revelar o formato verdadeiro dos seus grupos.

console.log("\n── 1) Casos sintéticos ─────────────────────────────");

const SINAL_1 = "🔥 SUPER LIGA 🔥\n⏰ H: 12\n➡️ 15 30 45";
const SINAL_2 = "COPA\nH:9\n➡ 5 20 35 50";
const NAO_SINAL = "Bom dia galera, hoje tem muita green 🚀";
const RESULT_GREEN_REPLY = "✅ GREEN bateu no primeiro!";
const RESULT_RED = "🔴 RED infelizmente, vamos pro próximo";
const RESULT_GREEN_TEXTO = "GREEN na SUPER das H: 12 ✅";
const SINAL_EDITADO_GREEN = "🔥 SUPER LIGA 🔥\n⏰ H: 12\n➡️ 15 30 45 ✅ GREEN";

// parseMensagem
check("parse SINAL_1 → liga SUPER, hora 12, minutos [15,30,45]",
    eq(parseMensagem(SINAL_1), { liga: "SUPER", hora: "12", minutos: [15, 30, 45], entrada: ["12:15", "12:30", "12:45"] }),
    JSON.stringify(parseMensagem(SINAL_1)));

check("parse SINAL_2 → liga COPA, hora 9, minutos [5,20,35,50]",
    eq(parseMensagem(SINAL_2).minutos, [5, 20, 35, 50]) && parseMensagem(SINAL_2).liga === "COPA" && parseMensagem(SINAL_2).hora === "9",
    JSON.stringify(parseMensagem(SINAL_2)));

// isSignal
check("isSignal(SINAL_1) = true", isSignal(SINAL_1) === true);
check("isSignal(SINAL_2) = true", isSignal(SINAL_2) === true);
check("isSignal(NAO_SINAL) = false", isSignal(NAO_SINAL) === false);
check("isSignal(RESULT_GREEN_REPLY) = false", isSignal(RESULT_GREEN_REPLY) === false);

// isResultado (msg solta)
check("isResultado(GREEN reply) = {green:true}", isResultado(RESULT_GREEN_REPLY)?.green === true);
check("isResultado(RED) = {red:true}", isResultado(RESULT_RED)?.red === true);
check("isResultado(GREEN texto c/ liga) = {green:true}", isResultado(RESULT_GREEN_TEXTO)?.green === true);
check("isResultado(SINAL puro) = null (sinal não é resultado)", isResultado(SINAL_1) === null);
check("isResultado(NAO_SINAL 'green' casual) casa green (limitação regex)", isResultado(NAO_SINAL)?.green === true);

// isResultado com forçar=true (sinal editado que ganhou GREEN)
check("isResultado(SINAL editado c/ GREEN, forcar=true) = {green:true}", isResultado(SINAL_EDITADO_GREEN, true)?.green === true);
check("RE_GREEN pega '✅'", RE_GREEN.test("✅") === true);
check("RE_RED pega '🔴'", RE_RED.test("🔴") === true);
check("RE_GREEN NÃO pega texto sem green", RE_GREEN.test("aposta feita, aguardando") === false);

// extrairReferencia
check("extrairReferencia(GREEN texto) → liga SUPER, hora 12",
    eq(extrairReferencia(RESULT_GREEN_TEXTO), { liga: "SUPER", hora: "12" }),
    JSON.stringify(extrairReferencia(RESULT_GREEN_TEXTO)));

// temLigaEMinutos (critério de armazenamento: Liga + minutos, hora opcional)
check("temLigaEMinutos(SINAL_1) = true", temLigaEMinutos(SINAL_1) === true);
check("temLigaEMinutos('COPA ➡ 10 25') = true (sem hora)", temLigaEMinutos("COPA ➡ 10 25") === true);
check("temLigaEMinutos('só COPA sem minutos') = false", temLigaEMinutos("bom dia, COPA hoje") === false);
check("temLigaEMinutos(NAO_SINAL) = false", temLigaEMinutos(NAO_SINAL) === false);

// extrairOdd
check("extrairOdd('@1.85') = 1.85", extrairOdd("entrada @1.85") === 1.85);
check("extrairOdd('ODD 1,90') = 1.9", extrairOdd("ODD 1,90") === 1.9);
check("extrairOdd('sem odd') = null", extrairOdd("sem cotação aqui") === null);

// ── 1b) DADOS REAIS (do coletor) ────────────────────────────────────────────
console.log("\n── 1b) Formatos REAIS capturados ───────────────────");

const REAL_SINAL = "🤖 **Robô Over 2** 🤖\n🏆 SUPER ⏰ H: 23 ➡  ✅52 55 58 01\n\n✔ **Entrada:** Over 2.5 \n✅ ODD: 2.";
const REAL_GREEN_5 = "**PREMIER      🏆\n\n⏰ 39-42**✅**\n\nAMBAS MARCAM\n\n✅✅✅✅✅✅✅";
const REAL_GREEN_7 = "**📌****PREMIER\n\n****🔜****TEMPO 27 30****✔️****\n**\nAMBAS✔️\n\nPOSSÍVEL 3.5✔️";

// Bug corrigido: ➡ ✅52 55 58 01 → [52,55,58,1] (antes virava [0])
check("REAL_SINAL minutos = [52,55,58,1] (bug do minuto 0 corrigido)",
    eq(parseMensagem(REAL_SINAL).minutos, [52, 55, 58, 1]),
    JSON.stringify(parseMensagem(REAL_SINAL)));
check("REAL_SINAL isSignal = true (SUPER, H:23)", isSignal(REAL_SINAL) === true);
check("REAL_SINAL isResultado(sem forçar) = null (✅ é template, não green)",
    isResultado(REAL_SINAL) === null);

// REAL_GREEN_5/7 são SINAIS JÁ GREENED (PREMIER ⏰ 39-42 / TEMPO 27 30 com ✅/✔️).
// Com o parser novo, o ⏰ vira minutos → isSignal = true (é sinal, greened).
check("REAL_GREEN_5 isSignal = true (PREMIER ⏰ 39-42)", isSignal(REAL_GREEN_5) === true);
check("REAL_GREEN_5 minutos = [39,42]", eq(parseMensagem(REAL_GREEN_5).minutos, [39, 42]),
    JSON.stringify(parseMensagem(REAL_GREEN_5).minutos));
check("REAL_GREEN_5 liga = PREMIER", parseMensagem(REAL_GREEN_5).liga === "PREMIER");

// Formato BRUXÃO real: "SUPER 🏆 ⏰ 52 AMBAS MARCAM" (sem ➡, sem H:)
const BRUXAO_52 = "**SUPER      🏆\n\n⏰ 52**\n\nAMBAS MARCAM 🧙‍♂️";
const BRUXAO_RANGE = "PREMIER**     🏆\n\n⏰ 42-45**\n\nAMBAS MARCAM 🧙‍♂️";
const BRUXAO_GALE = "PREMIER**     🏆\n\n⏰ 06-09-12**\n\nAMBAS MARCAM 🧙‍♂️";
const BRUXAO_GREENED = "**SUPER      🏆\n\n⏰ 52**✅**\n\nAMBAS MARCAM 🧙‍♂️\n**✅✅✅✅✅✅✅✅";
const BRUXAO_PAGA = "**PAGA PRA TROPA DO BRUXÃO ****🧙‍♂️****✅****🥇**";

check("BRUXAO_52 → SUPER, minutos [52]", eq(parseMensagem(BRUXAO_52), { liga: "SUPER", hora: null, minutos: [52], entrada: ["null:52"] }), JSON.stringify(parseMensagem(BRUXAO_52)));
check("BRUXAO_52 isSignal = true (sem hora)", isSignal(BRUXAO_52) === true);
check("BRUXAO_RANGE minutos = [42,45]", eq(parseMensagem(BRUXAO_RANGE).minutos, [42, 45]), JSON.stringify(parseMensagem(BRUXAO_RANGE).minutos));
check("BRUXAO_GALE minutos = [6,9,12]", eq(parseMensagem(BRUXAO_GALE).minutos, [6, 9, 12]), JSON.stringify(parseMensagem(BRUXAO_GALE).minutos));
check("BRUXAO_GALE temLigaEMinutos = true", temLigaEMinutos(BRUXAO_GALE) === true);
check("BRUXAO_GREENED isSignal = true (sinal greened)", isSignal(BRUXAO_GREENED) === true);
check("BRUXAO_PAGA isSignal = false (só confirmação)", isSignal(BRUXAO_PAGA) === false);
check("BRUXAO_PAGA isResultado.green = true", isResultado(BRUXAO_PAGA)?.green === true);

// Markdown cortando números: "⏰ 4**9**" → 49 (não [4,9]); "24-27-3**0**" → [24,27,30]
check("markdown '⏰ 4**9**' → minutos [49]", eq(parseMensagem("SUPER ⏰ 4**9**").minutos, [49]), JSON.stringify(parseMensagem("SUPER ⏰ 4**9**").minutos));
check("markdown '⏰ 24-27-3**0**' → [24,27,30]", eq(parseMensagem("PREMIER ⏰ 24-27-3**0**").minutos, [24, 27, 30]), JSON.stringify(parseMensagem("PREMIER ⏰ 24-27-3**0**").minutos));

// Formato ELITE real: "📌EURO 🔜TEMPO 08✔️ AMBAS✔️ POSSÍVEL 3.5"
const ELITE_1 = "📌EURO\n\n🔜TEMPO 08✔️\n\nAMBAS✔️\n\nPOSSÍVEL 3.5";
const ELITE_RED = "📌SUPER\n\n🔜TEMPO 55❌";
check("ELITE_1 → EURO, minutos [8]", eq(parseMensagem(ELITE_1).liga, "EURO") && eq(parseMensagem(ELITE_1).minutos, [8]), JSON.stringify(parseMensagem(ELITE_1)));
check("ELITE_1 isSignal = true (TEMPO)", isSignal(ELITE_1) === true);
check("ELITE_RED → SUPER, minutos [55], isSignal true", parseMensagem(ELITE_RED).liga === "SUPER" && eq(parseMensagem(ELITE_RED).minutos, [55]));
check("ELITE_1 NÃO cruza linha p/ pegar 3 (POSSÍVEL 3.5)", !parseMensagem(ELITE_1).minutos.includes(3));

// ── ENTRADAS REAIS confirmadas pelo usuário (msgs 203045/203035/102123) ──────
const ENT_203045 = "📌COPA\n\n🔜TEMPO 13✔️\n\nAMBAS✔️\n\nPOSSÍVEL 3.5";
const ENT_203035 = "📌PREMIER\n\n🔜TEMPO 36✔️\n\nAMBAS✔️\n\nPOSSÍVEL 3.5";
const ENT_102123 = "PREMIER     🏆\n\n⏰ 30-33✅\n\nAMBAS MARCAM 🧙‍♂️\n✅✅✅✅✅";
check("ENT #203045 → COPA, minutos [13]", isSignal(ENT_203045) && parseMensagem(ENT_203045).liga === "COPA" && eq(parseMensagem(ENT_203045).minutos, [13]));
check("ENT #203035 → PREMIER, minutos [36]", isSignal(ENT_203035) && parseMensagem(ENT_203035).liga === "PREMIER" && eq(parseMensagem(ENT_203035).minutos, [36]));
check("ENT #102123 → PREMIER, minutos [30,33]", isSignal(ENT_102123) && parseMensagem(ENT_102123).liga === "PREMIER" && eq(parseMensagem(ENT_102123).minutos, [30, 33]));

// ─── 2) REPROCESSAR RELATÓRIO REAL (se existir) ─────────────────────────────
console.log("\n── 2) Relatório real do coletor ────────────────────");

const REPORT = process.env.SNIFF_OUT
    ? path.join(process.env.SNIFF_OUT, "coletor-relatorio.json")
    : path.join(process.cwd(), "coletor-out", "coletor-relatorio.json");

if (fs.existsSync(REPORT)) {
    try {
        const rel = JSON.parse(fs.readFileSync(REPORT, "utf-8"));
        const evs: any[] = rel.eventos ?? [];
        console.log(`  📄 ${evs.length} eventos carregados de ${REPORT}`);
        let sinais = 0, results = 0, edits = 0, replies = 0, editSemHistorico = 0, emojiEntidade = 0;
        for (const e of evs) {
            if (e.classificacao?.isSignal) sinais++;
            if (e.classificacao?.isResultado) results++;
            if (e.tipo === "edit") { edits++; if (e.textoAnterior === null) editSemHistorico++; }
            if (e.isReply) replies++;
            if (e.temEntidades && !e.classificacao?.greenRegex && !e.classificacao?.redRegex &&
                (e.entidades ?? []).some((x: any) => /Emoji/i.test(x.tipo))) emojiEntidade++;
        }
        console.log(`  → sinais: ${sinais} | resultados: ${results} | edições: ${edits} (sem histórico: ${editSemHistorico}) | replies: ${replies}`);
        console.log(`  → msgs com emoji só em entidade (regex cega): ${emojiEntidade}`);
        if (edits > 0 && editSemHistorico === edits) console.log("  ⚠️  TODAS as edições vieram sem histórico → o coletor precisa rodar ANTES do sinal.");
        if (emojiEntidade > 0) console.log("  🔎 Há GREEN/RED como custom emoji: a detecção precisa ler `entities`, não só o texto.");
    } catch (e: any) {
        console.log("  ⚠️  Não consegui ler o relatório:", e?.message || e);
    }
} else {
    console.log(`  (sem relatório ainda — rode o coletor: npm run coletor)`);
    console.log(`  esperado em: ${REPORT}`);
}

// ─── RESULTADO ──────────────────────────────────────────────────────────────
console.log(`\n════════ ${ok} passaram, ${fail} falharam ════════`);
if (fail > 0) { console.log("Falhas:", falhas.join(" | ")); process.exit(1); }
process.exit(0);
