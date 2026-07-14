require('dotenv').config()
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { LogLevel } from "telegram/extensions/Logger";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { SIGNAL_GROUPS, grupoDoChat, grupoPorTitulo } from "./signals/groups";

// ─── DIAGNÓSTICO MÍNIMO ────────────────────────────────────────────────────────
// Só conecta, tenta LER cada canal (getMessages) e SAI. Responde de vez:
//   "getMessages funciona neste ambiente?" e "a conta está nesses canais?"
// Rodar:  npx ts-node src/testar-canais.ts    (ou: npm run testar)

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = String(process.env.TELEGRAM_API_HASH);
const OUT = process.env.SNIFF_OUT || path.join(process.cwd(), "coletor-out");
const ask = (q: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
};

const run = async () => {
    console.log("🔬 DIAGNÓSTICO DE CANAIS — conecta, lê cada canal e sai.\n");
    console.log("apiId:", apiId, "| SESSION definida?", !!process.env.SESSION, "\n");

    const client = new TelegramClient(new StringSession(process.env.SESSION ?? ""), apiId, apiHash, {
        connectionRetries: 5, timeout: 20,
    });
    try { client.setLogLevel(LogLevel.ERROR); } catch {}

    await client.start({
        phoneNumber: async () => process.env.TELEGRAM_MYPHONE as string,
        password: async () => await ask("Senha 2FA (Enter se não tiver): "),
        phoneCode: async () => await ask("Código recebido no Telegram: "),
        onError: (e: Error) => console.log("onError:", e),
    });
    console.log("📡 Conectado:", client.connected);

    const me: any = await client.getMe().catch(e => { console.log("❌ getMe falhou:", e?.message); return null; });
    console.log("👤 Logado como:", me ? `${me.firstName ?? ""} @${me.username ?? "-"} (id ${me.id})` : "??", me?.bot ? "[É BOT!]" : "[user]");

    // 1) Lista os diálogos que casam com os grupos monitorados (prova de membership).
    console.log("\n── Diálogos monitorados encontrados ──");
    try {
        const dialogs: any = await client.getDialogs({ limit: 300 });
        console.log(`(${dialogs?.length ?? 0} diálogos no total)`);
        let achou = 0;
        for (const d of dialogs ?? []) {
            const id = d?.id?.toString?.() ?? d?.entity?.id?.toString?.();
            const titulo = d?.title ?? d?.name ?? d?.entity?.title ?? "";
            const g = grupoDoChat(id) ?? grupoPorTitulo(titulo);
            if (g) { console.log(`  ✅ ${g} → id=${id} título="${titulo}"`); achou++; }
        }
        if (achou === 0) console.log("  ⛔ NENHUM diálogo casou com os grupos! A conta pode não estar nesses canais.");
    } catch (e: any) { console.log("❌ getDialogs falhou:", e?.message); }

    // 2) Tenta LER as últimas mensagens de cada canal configurado.
    console.log("\n── getMessages por canal ──");
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    const linhas: string[] = [];
    for (const [nome, id] of Object.entries(SIGNAL_GROUPS)) {
        let alvo: any = id;
        try { alvo = await client.getEntity(id); } catch (e: any) { console.log(`  ⚠️ getEntity(${nome}) falhou: ${e?.message?.split("\n")[0]}`); }
        try {
            const msgs: any[] = await client.getMessages(alvo, { limit: 5 });
            console.log(`  📥 ${nome} (${id}): ${msgs?.length ?? 0} mensagens`);
            for (const m of msgs ?? []) {
                const txt = (m.rawText ?? m.text ?? m.message ?? "(vazio/mídia)").replace(/\n/g, " ⏎ ").slice(0, 90);
                console.log(`       #${m.id}: ${JSON.stringify(txt)}`);
                linhas.push(JSON.stringify({ nome, id, msgId: m.id, text: m.rawText ?? m.message ?? "" }));
            }
        } catch (e: any) {
            console.log(`  ❌ getMessages(${nome} ${id}) FALHOU: ${e?.message?.split("\n")[0]}`);
        }
    }
    if (linhas.length) {
        fs.writeFileSync(path.join(OUT, "diagnostico-canais.jsonl"), linhas.join("\n") + "\n");
        console.log(`\n💾 ${linhas.length} mensagens salvas em ${path.join(OUT, "diagnostico-canais.jsonl")}`);
    } else {
        console.log("\n⛔ ZERO mensagens lidas de qualquer canal.");
        console.log("   → Se getEntity/getMessages falharam: SESSION inválida (regere) ou conta não está nos canais.");
    }

    await client.disconnect();
    console.log("\n✅ Fim do diagnóstico.");
    process.exit(0);
};

run().catch(e => { console.log("💥 Erro fatal:", e?.message || e); process.exit(1); });
