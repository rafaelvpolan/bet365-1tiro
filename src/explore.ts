require('dotenv').config()
const { chromium } = require('playwright');
import options from './pw.config'
import bet365Spec from './spec/bet365.spec'
import * as fs from 'fs'
import * as path from 'path'

// ─── EXPLORADOR DE DOM (esportes reais) ────────────────────────────────────────
// Loga, abre o Chrome e despeja HTML + screenshots em CADA etapa para mapear os
// seletores dos esportes reais. Timeouts FINITOS e dumps defensivos: mesmo que o
// login falhe, ainda captura a tela. NÃO faz nenhuma aposta.

const OUT = process.env.EXPLORE_OUT || path.join(process.env.TEMP || '.', 'bet365-explore')
const ensureOut = () => { if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true }) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const dump = async (page: any, nome: string) => {
    try {
        const html = await page.content()
        fs.writeFileSync(path.join(OUT, `${nome}.html`), html)
        await page.screenshot({ path: path.join(OUT, `${nome}.png`), fullPage: false })
        console.log(`💾 Dump salvo: ${nome} (url: ${page.url()})`)
    } catch (e: any) {
        console.log(`❌ Erro no dump ${nome}:`, e?.message || e)
    }
}

const clickSafe = async (page: any, locator: any, label: string, timeout = 8000) => {
    try {
        await locator.click({ timeout })
        console.log(`✅ Cliquei: ${label}`)
        return true
    } catch (e: any) {
        console.log(`⚠️ Não cliquei em ${label}:`, e?.message?.split('\n')[0] || e)
        return false
    }
}

const run = async () => {
    ensureOut()
    console.log('📂 Saída em:', OUT)

    // Perfil ÚNICO por execução → evita singleton e lock preso de execuções anteriores.
    const userDataDir = path.join(OUT, `profile-${Date.now()}`)
    const context = await chromium.launchPersistentContext(userDataDir, {
        ...options,
        geolocation: { latitude: -23.5505, longitude: -46.6333 },
        permissions: ['geolocation'],
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
    })
    context.setDefaultTimeout(30000)
    context.setDefaultNavigationTimeout(45000)
    const page = context.pages().length ? context.pages()[0] : await context.newPage()
    await page.setViewportSize({ width: 1620, height: 880 })

    // 1) Carrega a home
    try {
        await page.goto(bet365Spec.url, { waitUntil: 'domcontentloaded' })
        console.log('🌐 Página carregada:', page.url())
    } catch (e: any) {
        console.log('⚠️ goto falhou/timeout (segue mesmo assim):', e?.message?.split('\n')[0] || e)
    }
    await sleep(5000)
    await dump(page, '00-landing')

    // 2) Cookies
    try {
        const cookieButton = page.locator('button', { hasText: 'Aceitar todos' })
        if (await cookieButton.count() > 0) { await clickSafe(page, cookieButton, 'Aceitar cookies') }
    } catch {}

    // 3) Login (best-effort, não trava se seletor mudou)
    try {
        await clickSafe(page, page.locator(bet365Spec.loginElements.buttonLogin), 'botão login')
        await sleep(1500)
        await dump(page, '01-login-aberto')
        if (await clickSafe(page, page.locator(bet365Spec.loginElements.inputLogin), 'campo usuário')) {
            await page.keyboard.type(String(process.env.BET365_USER ?? ''))
            await sleep(800)
            await clickSafe(page, page.locator(bet365Spec.loginElements.inputPass), 'campo senha')
            await page.keyboard.type(String(process.env.BET365_PASS ?? ''))
            await sleep(800)
            await page.keyboard.press('Enter')
            await sleep(7000)
            console.log('🔑 Login enviado')
        }
    } catch (e: any) {
        console.log('⚠️ Falha no login:', e?.message?.split('\n')[0] || e)
    }
    await dump(page, '02-poslogin')

    // 4) Lista termos de esporte visíveis (para achar Futebol/Basquete/CS/LoL)
    try {
        const menus: string[] = await page.$$eval('a, div, span, li', (els: any[]) =>
            els.map(e => (e.innerText || '').trim()).filter(t => t && t.length < 30)
        )
        const alvo = ['Futebol', 'Basquete', 'Basketball', 'Counter', 'CS', 'League of Legends', 'LoL', 'E-Sports', 'eSports', 'Esports', 'Tênis', 'Tenis', 'Ao Vivo', 'Ao-Vivo', 'Esportes']
        const achados = [...new Set(menus.filter(t => alvo.some(a => t.toLowerCase().includes(a.toLowerCase()))))]
        console.log('🔎 Termos de esporte encontrados:', JSON.stringify(achados))
        fs.writeFileSync(path.join(OUT, 'menu-textos.json'), JSON.stringify(achados, null, 2))
    } catch (e: any) {
        console.log('⚠️ Não consegui listar menus:', e?.message?.split('\n')[0] || e)
    }

    console.log('✅ Exploração concluída. Fechando em 8s.')
    await sleep(8000)
    await context.close()
}

run().catch(e => { console.log('💥 Erro fatal:', e?.message || e); process.exit(1) })
