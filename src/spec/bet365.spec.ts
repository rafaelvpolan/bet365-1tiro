export default {
    // url:'https://www.bet365.com/#/AVR/B146/R^1/',
    url:'https://www.bet365.bet.br',
    elements:{
        champsList:".vrl-MeetingsHeader_ButtonContainer div",
        champsResultBtn:'.vr-ResultsNavBarButton',
        champsResultTime:'.vrr-FixtureDetails_Event ',
        champsResultScore:'.vrr-HTHTeamDetails_Score ',
        champsResultTeamOne:'.vrr-HTHTeamDetails_TeamOne',
        champsResultTeamTwo:'.vrr-HTHTeamDetails_TeamTwo',
        champsTimes:'.vr-EventTimesNavBar_ButtonContainer vrl-HorizontalNavBarScroller_ScrollContent',
        buttonPlayVideo:'.fpm-PlayButton',
        // Saldo: classe estável bs-Balance_Value (o hrm-* muda sempre).
        money: '.bs-Balance_Value'
    },
    popups:{
        saldo:".llr-3 >> .llr-d"
    },
    locators:{
        menuCategory:"text=Esportes Virtuais >> nth=0",
        // Entra no tile "Futebol" (o "Novo", ao vivo — onde os sinais BRUXAO/ELITE
        // apostam "ambas marcam" no minuto de jogo). Card = .vss-c cujo .vss-4 é exatamente "Futebol".
        pageItem:'.vss-c:has(.vss-4:text-is("Futebol"))',
        champsResultBtn:'.vr-EventTimesNavBar_ButtonContainer >> div >> nth=0',
    },
    loginElements:{
        // Seletor por TEXTO (estável) — a bet365 troca as classes ofuscadas (hrm-*) sempre.
        buttonLogin:'button:has-text("Login")',
        // ⚠️ Campos do MODAL de login: precisam ser remapeados após abrir o modal
        //    (o checker não conseguiu abrir antes). Fallbacks genéricos por enquanto.
        inputLogin:'input[type=text]:visible, input[type=email]:visible',
        inputPass:'input[type=password]:visible'
    }
}