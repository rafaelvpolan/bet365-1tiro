// ─── HELPERS DE MENSAGEM (gramjs) ──────────────────────────────────────────────
// Os sinais chegam ENCAMINHADOS num chat "hub" — o grupo real vem do canal de
// origem (fwdFrom), não do chatId onde a mensagem é lida.

import { grupoDoChat, grupoPorTitulo } from "./groups";

export interface FwdInfo {
    fromId: string | null;
    fromName: string | null;
}

// Extrai a origem de um encaminhamento. Para canais, fromId.channelId bate com o
// "bare id" dos nossos grupos (ex.: 1736730131).
export function infoForward(message: any): FwdInfo | null {
    const f = message?.fwdFrom;
    if (!f) return null;
    const p = f.fromId;
    const fromId = p ? (String(p.channelId ?? p.userId ?? p.chatId ?? "") || null) : null;
    return { fromId, fromName: f.fromName ?? null };
}

// Resolve o NOME do grupo de uma mensagem: por chatId, pela origem do forward, ou
// pelo título do chat/origem. Retorna undefined se não for um grupo monitorado.
export async function resolverGrupoDaMensagem(message: any): Promise<string | undefined> {
    const chatId = message?.chatId?.toString?.() ?? null;
    const fwd = infoForward(message);
    let grupo = grupoDoChat(chatId)
        ?? grupoDoChat(fwd?.fromId)
        ?? grupoPorTitulo(fwd?.fromName);
    if (!grupo) {
        try { const chat: any = await message.getChat(); grupo = grupoPorTitulo(chat?.title); } catch { /* ignora */ }
    }
    return grupo;
}
