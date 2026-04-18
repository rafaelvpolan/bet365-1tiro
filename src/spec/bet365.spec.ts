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
        money:'header > div > div.hrm-a.hrm-49 > div.hrm-f > button:nth-child(1) > div > div > span.hrm-ba'
    },
    popups:{
        saldo:".llr-3 >> .llr-d"
    },
    locators:{
        menuCategory:"text=Esportes Virtuais >> nth=0",
        pageItem:".wcl-CommonElementStyle_PrematchCenter >> .vss-2 >> div >> nth=1",
        champsResultBtn:'.vr-EventTimesNavBar_ButtonContainer >> div >> nth=0',
    },
    loginElements:{
        buttonLogin:'.hrm-03 >> .hrm-1 >> nth=2',
        inputLogin:'.slm2-1 >> input[type=text]',
        inputPass:'.slm2-4e >> input[type=password]'
    }
}