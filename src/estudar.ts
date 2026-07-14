require('dotenv').config()
const { chromium } = require('playwright');
import options from './pw.config'
import bet365Spec from './spec/bet365.spec'
import * as fs from 'fs'
import * as path from 'path'

// ─── MOTOR DE ESTUDO (somente leitura / análise) ───────────────────────────────
// Abre a home da bet365 (sem login), lê os jogos de futebol com mercado 1 X 2,
// calcula probabilidade implícita e o vig (margem da casa) e ranqueia pela regra
// "menor vig dentro de uma faixa de odd". NÃO faz login e NÃO aposta.

const OUT = process.env.EXPLORE_OUT || path.join(process.env.TEMP || '.', 'bet365-explore')
const ensureOut = () => { if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true }) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// faixa de odd equilibrada (só entram jogos cuja odd escolhida esteja aqui)
const ODD_MIN = Number(process.env.EST_ODD_MIN ?? 1.5)
const ODD_MAX = Number(process.env.EST_ODD_MAX ?? 2.2)

interface Jogo {
    grupo: string
    times: string[]
    mercados: string[]   // ex.: ["1","X","2"]
    odds: number[]
    impliedPct: number[] // probabilidade implícita por seleção (%)
    vigPct: number       // margem da casa (%)
    melhorEscolha: { mercado: string, odd: number } | null // menor odd dentro da faixa
}

const extrair = async (page: any): Promise<Jogo[]> => {
    return await page.$$eval(
        '.gl-MarketGroupContainer.cpm-CouponPodMarketGroup_MarketGroupContainer',
        (grupos: any[]) => {
            const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim()
            const out: any[] = []
            grupos.forEach((g, gi) => {
                const headers = Array.from(g.querySelectorAll('.cpm-MarketOddsHeader'))
                    .map((h: any) => clean(h.innerText)).filter(Boolean)
                const teamNames = Array.from(g.querySelectorAll('.cpm-ParticipantFixtureDetails100_TeamNames'))
                    .map((t: any) => Array.from(t.querySelectorAll('.cpm-ParticipantFixtureDetails100_Team'))
                        .map((x: any) => clean(x.innerText)))
                const colunas = Array.from(g.querySelectorAll('.cpm-MarketOdds'))
                    .map((c: any) => Array.from(c.querySelectorAll('.cpm-ParticipantOdds_Odds'))
                        .map((o: any) => clean(o.innerText)))
                // zip: jogo i -> teams[i], odds = colunas.map(col => col[i])
                const nJogos = teamNames.length
                for (let i = 0; i < nJogos; i++) {
                    const odds = colunas.map(col => col[i]).filter(v => v !== undefined && v !== '')
                    out.push({
                        grupo: `grupo-${gi}`,
                        mercados: headers,
                        times: teamNames[i] || [],
                        oddsRaw: odds,
                    })
                }
            })
            return out
        }
    ).then((rows: any[]) => rows.map((r: any): Jogo => {
        const odds = r.oddsRaw.map((s: string) => parseFloat(String(s).replace(',', '.'))).filter((n: number) => !isNaN(n) && n > 1)
        const implied = odds.map((o: number) => 100 / o)
        const somaImplied = implied.reduce((a: number, b: number) => a + b, 0)
        const vig = somaImplied - 100
        // menor odd (favorito) dentro da faixa configurada
        let melhor: { mercado: string, odd: number } | null = null
        odds.forEach((o: number, idx: number) => {
            if (o >= ODD_MIN && o <= ODD_MAX) {
                if (!melhor || o < melhor.odd) melhor = { mercado: r.mercados[idx] ?? String(idx), odd: o }
            }
        })
        return {
            grupo: r.grupo,
            times: r.times,
            mercados: r.mercados,
            odds,
            impliedPct: implied.map((p: number) => +p.toFixed(2)),
            vigPct: +vig.toFixed(2),
            melhorEscolha: melhor,
        }
    }))
}

const run = async () => {
    ensureOut()
    const userDataDir = path.join(OUT, `profile-est-${Date.now()}`)
    const context = await chromium.launchPersistentContext(userDataDir, {
        ...options,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
    })
    context.setDefaultTimeout(30000)
    context.setDefaultNavigationTimeout(45000)
    const page = context.pages().length ? context.pages()[0] : await context.newPage()
    await page.setViewportSize({ width: 1620, height: 880 })

    try {
        await page.goto(bet365Spec.url, { waitUntil: 'domcontentloaded' })
    } catch (e: any) { console.log('⚠️ goto:', e?.message?.split('\n')[0] || e) }
    await sleep(4000)

    try {
        const cookieButton = page.locator('button', { hasText: 'Aceitar todos' })
        if (await cookieButton.count() > 0) await cookieButton.click({ timeout: 5000 })
    } catch {}

    try {
        await page.waitForSelector('.cpm-ParticipantOdds_Odds', { timeout: 20000 })
    } catch { console.log('⚠️ Cupom de odds não apareceu a tempo.') }
    await sleep(1500)

    const jogos = (await extrair(page))
        .filter(j => j.times.length >= 2 && j.odds.length >= 2)

    fs.writeFileSync(path.join(OUT, 'estudo.json'), JSON.stringify(jogos, null, 2))
    console.log(`\n📊 ${jogos.length} jogos lidos.\n`)

    // aplica a regra: só jogos com uma escolha dentro da faixa, ordenados por menor vig
    const candidatos = jogos
        .filter(j => j.melhorEscolha && j.vigPct > 0)
        .sort((a, b) => a.vigPct - b.vigPct)

    console.log(`🎯 REGRA: menor vig, escolha dentro da faixa ${ODD_MIN}–${ODD_MAX}\n`)
    candidatos.slice(0, 10).forEach((j, i) => {
        const e = j.melhorEscolha!
        console.log(
            `${String(i + 1).padStart(2)}. ${j.times.join(' x ')} | ` +
            `vig ${j.vigPct}% | odds [${j.odds.join(', ')}] | ` +
            `👉 apostaria "${e.mercado}" @ ${e.odd}`
        )
    })

    if (candidatos[0]) {
        const top = candidatos[0]
        console.log(`\n🏆 MELHOR SEGUNDO A REGRA: ${top.times.join(' x ')} → "${top.melhorEscolha!.mercado}" @ ${top.melhorEscolha!.odd} (vig ${top.vigPct}%)`)
        console.log('   (Isto é ESTUDO. Nenhuma aposta foi feita.)')
    } else {
        console.log('Nenhum candidato dentro da faixa agora.')
    }

    await sleep(3000)
    await context.close()
}

run().catch(e => { console.log('💥 Erro fatal:', e?.message || e); process.exit(1) })
