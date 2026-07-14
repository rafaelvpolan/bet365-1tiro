require('dotenv').config()
const { chromium } = require('playwright');
import options from './pw.config'
import bet365Spec from './spec/bet365.spec'
import * as fs from 'fs'
import * as path from 'path'

// ─── VERIFICADOR DE SELETORES DA BET365 ────────────────────────────────────────
// Abre o navegador, navega por TODAS as etapas da aposta e checa se cada seletor
// ainda existe (a bet365 muda as classes e quebra o placeBet). Salva HTML +
// screenshot de cada etapa e imprime um relatório ✅/❌.
// Rodar (no Windows, com Chrome instalado):  npm run checar

const OUT = process.env.CHECK_OUT || path.join(process.env.TEMP || '.', 'bet365-checar')
const ensureOut = () => { if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true }) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Liga do teste (pra checar as abas de campeonato). COPA|EURO|SUPER|PREMIER
const LIGA = String(process.env.CHECK_LIGA ?? 'SUPER').toUpperCase()
const indiceChamps: any = { COPA: 1, EURO: 2, SUPER: 3, PREMIER: 4 }

const resultados: { etapa: string; seletor: string; achou: boolean; qtd: number }[] = []

const run = async () => {
    ensureOut()
    console.log('🔎 VERIFICADOR DE SELETORES — abre o navegador e testa cada etapa.\n   Saída (HTML/prints):', OUT, '\n')

    const userDataDir = path.join(process.env.TEMP || require('os').tmpdir(), `bet365-checar-${Date.now()}`)
    const context = await chromium.launchPersistentContext(userDataDir, {
        ...options,
        geolocation: { latitude: -23.5505, longitude: -46.6333 },
        permissions: ['geolocation'], locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    })
    context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(45000)
    const page = context.pages().length ? context.pages()[0] : await context.newPage()
    await page.setViewportSize({ width: 1620, height: 880 })

    const dump = async (nome: string) => {
        try {
            fs.writeFileSync(path.join(OUT, `${nome}.html`), await page.content())
            await page.screenshot({ path: path.join(OUT, `${nome}.png`) })
            console.log(`   💾 dump: ${nome}`)
        } catch (e: any) { console.log(`   ⚠️ dump ${nome} falhou: ${e?.message?.split('\n')[0]}`) }
    }

    // checa 1 seletor e registra
    const checar = async (etapa: string, seletor: string) => {
        let qtd = 0
        try { qtd = await page.locator(seletor).count() } catch { qtd = -1 }
        const achou = qtd > 0
        resultados.push({ etapa, seletor, achou, qtd })
        console.log(`   ${achou ? '✅' : '❌'} [${etapa}] (${qtd}) ${seletor}`)
        return achou
    }

    // clique best-effort
    const clicar = async (label: string, seletor: string) => {
        try {
            const el = page.locator(seletor)
            if (await el.count() > 0) { await el.first().click({ timeout: 8000 }); console.log(`   👆 cliquei: ${label}`); return true }
            console.log(`   ⚠️ não achei p/ clicar: ${label}`); return false
        } catch (e: any) { console.log(`   ⚠️ clique ${label} falhou: ${e?.message?.split('\n')[0]}`); return false }
    }

    // 1) Home
    console.log('── 1) Home / cookies / login ──')
    try { await page.goto(bet365Spec.url, { waitUntil: 'domcontentloaded' }) } catch (e: any) { console.log('goto:', e?.message?.split('\n')[0]) }
    await sleep(5000); await dump('01-home')
    await clicar('cookies', 'button:has-text("Aceitar todos")')

    // login
    await checar('login', bet365Spec.loginElements.buttonLogin)
    await clicar('abrir login', bet365Spec.loginElements.buttonLogin)
    await sleep(1500); await dump('02-login')
    if (await checar('login-user', bet365Spec.loginElements.inputLogin)) {
        await clicar('campo usuário', bet365Spec.loginElements.inputLogin)
        await page.keyboard.type(String(process.env.BET365_USER ?? '')); await sleep(600)
        await checar('login-pass', bet365Spec.loginElements.inputPass)
        await clicar('campo senha', bet365Spec.loginElements.inputPass)
        await page.keyboard.type(String(process.env.BET365_PASS ?? '')); await sleep(600)
        await page.keyboard.press('Enter'); await sleep(6000)
    }
    await dump('03-poslogin')

    // 2) Saldo + navegação
    console.log('\n── 2) Saldo / menu Esportes Virtuais ──')
    await checar('saldo(popup)', bet365Spec.popups.saldo)
    await checar('saldo(valor)', bet365Spec.elements.money)
    await clicar('popup saldo', bet365Spec.popups.saldo); await sleep(1500)
    await checar('menu Esportes Virtuais', bet365Spec.locators.menuCategory)
    await clicar('menu Esportes Virtuais', bet365Spec.locators.menuCategory); await sleep(2000)
    await dump('04-virtuais')
    await checar('pageItem (jogo)', bet365Spec.locators.pageItem)
    await clicar('pageItem', bet365Spec.locators.pageItem); await sleep(5000)  // matchday demora a carregar
    await dump('05-liga')

    // 3) Abas de campeonato + horários + odds (fluxo do placeBet)
    console.log('\n── 3) Campeonato / horários / mercado (placeBet) ──')
    await checar('abas de liga', '.vrl-MeetingsHeader_ButtonContainer >> div')
    await clicar(`aba ${LIGA}`, `.vrl-MeetingsHeader_ButtonContainer >> div >> nth=${indiceChamps[LIGA]}`)
    await sleep(2500); await dump('06-campeonato')
    await checar('botões de horário', '.vr-EventTimesNavBarButton_Text')
    await clicar('primeiro horário', '.vr-EventTimesNavBarButton_Text >> nth=0'); await sleep(2500)
    await dump('07-mercados')
    await checar('grupos de mercado', '.gl-MarketGroupPod.gl-MarketGroup')
    await checar('odds (Over-atual nth=2)', '.gl-MarketGroupPod.gl-MarketGroup >> nth=2 >> .gl-ParticipantOddsOnly')
    await checar('AMBAS MARCAM (por texto)', 'text=/ambas/i')
    await checar('cabeçalhos de mercado', '.gl-MarketGroupButton, .cm-MarketGroupWithIconsButton, .gl-MarketGroup_Header')

    // 4) Cupom / stake / botão apostar
    console.log('\n── 4) Cupom de aposta ──')
    await clicar('clica 1ª odd (abrir cupom)', '.gl-MarketGroupPod.gl-MarketGroup >> nth=2 >> .gl-ParticipantOddsOnly >> nth=0'); await sleep(1500)
    await dump('08-cupom')
    await checar('caixa de valor (StakeBox)', '.bsf-StakeBox_Wrapper')
    await checar('botão APOSTAR', '.bsf-PlaceBetButton')
    await checar('recibo (Done)', '.bss-ReceiptContent_Done')

    // ── Relatório ──
    const quebrados = resultados.filter(r => !r.achou)
    console.log('\n══════════ RELATÓRIO DE SELETORES ══════════')
    console.log(`Total checados: ${resultados.length} | ✅ OK: ${resultados.length - quebrados.length} | ❌ QUEBRADOS: ${quebrados.length}`)
    if (quebrados.length) {
        console.log('\n❌ SELETORES QUE MUDARAM/NÃO EXISTEM:')
        for (const q of quebrados) console.log(`   [${q.etapa}] ${q.seletor}`)
        console.log('\n→ Veja os .html/.png em', OUT, 'pra descobrir as novas classes.')
    } else {
        console.log('🎉 Todos os seletores ainda existem.')
    }
    fs.writeFileSync(path.join(OUT, 'relatorio-seletores.json'), JSON.stringify(resultados, null, 2))
    console.log('\nRelatório salvo em', path.join(OUT, 'relatorio-seletores.json'))
    console.log('Fechando em 10s (feche a janela quando quiser).')
    await sleep(10000)
    await context.close()
    process.exit(0)
}

run().catch(e => { console.log('💥 Erro fatal:', e?.message || e); process.exit(1) })
