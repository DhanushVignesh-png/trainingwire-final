// Training Wire — BOARD regression fixtures.
//
// Each case is a real RNS release (glue artefacts and all — "advisesthat",
// "Groupannounces", "MrMark Tavenerhas" are deliberate, they are what the
// terminal actually hands the engine).
//
// `expect` is the exact list of snaps, in order. [] means "must emit nothing".
// Run:  node test/run.js            compare against expect
//       node test/run.js --report   print what the engine actually produces

module.exports = [

{ name: 'rank-ceo', expect: [
  'RANK GROUP PLC: RICHARD HARRIS APPOINTED CEO'
], headline: 'Appointment of Richard Harris as CEO', body: `RNS Number : 0556M
Rank Group PLC
13 July 2026

The Rank Group Plc ("Rank" or "Group")
LEI: 213800TXKD6XZWOFTE12

13 July 2026

Appointment of Richard Harris as Chief Executive Officer

The Board of The Rank Group Plc (LSE: RNK) ("Rank" or "the Group") is pleased to announce the appointment of Richard Harris as Chief Executive Officer ("CEO"), having served as Interim CEO since 30 January 2026. His appointment is made with immediate effect.

Richard's appointment follows an extensive executive search process, overseen by the Group's Nominations Committee, chaired by John Ott. The process considered both internal and external candidates, and was supported by MWM Consulting, an independent executive search firm.

Richard joined the Rank Board as Chief Financial Officer (CFO) in May 2022. He has extensive knowledge of the business, a track record of driving business performance and the strategic leadership required to maximise shareholder returns.

John H. Ott, Chair of Rank Group plc, said:

"I am delighted to confirm Richard's appointment as CEO of The Rank Group."

Richard Harris, CEO of Rank Group plc, said:

"Rank is an industry-leading business with a strong portfolio of brands."

Ends

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'dominos-ceo-of-filer', expect: [
  "DOMINO'S PIZZA GROUP PLC: NICOLA FRAMPTON APPOINTED CEO"
], headline: '', body: `RNS Number : 7032Y
Domino's Pizza Group PLC
31 March 2026

31 March 2026                LEI: 213800Q6ZKHAOV48JL75

This announcement contains Inside Information

Domino's Pizza Group PLC ("DPG")

Chief Executive Officer ("CEO") Appointment

Domino's Pizza Group ("Domino's" or "DPG") announces the appointment of Nicola Frampton, currently Interim CEO, as permanent CEO of Domino's.

Nicola's appointment comes after a comprehensive external and internal search process, through which the Board determined that she is the outstanding candidate to lead the company on a permanent basis.

Prior to being appointed interim CEO in November 2025, Nicola served as Chief Operating Officer for more than four years, cementing her understanding of Domino's business, customers and stakeholders. She joined Domino's from William Hill plc, where she held the role of Managing Director of UK Retail. She currently serves as a Non-Executive Director and Remuneration Committee Chair of Frasers Group plc. Nicola brings an in-depth knowledge of the UK market, a strong commercial mindset and has a genuine passion for driving the success of the Domino's brand in the UK and Ireland.Nicola and the wider leadership team, including Andrew Andrea who recently joined DPG as Chief Financial Officer, will focus on the strategic priorities that were set out in the company's FY25 results, announced on 10th March 2026.

Ian Bull, Chair, Domino's Pizza Group said:

"I am delighted that Nicola has agreed to become permanent CEO of Domino's."

Nicola Frampton, CEO, Domino's Pizza Group, said:

"I am honoured to be appointed as CEO of Domino's, a business that I am incredibly passionate about."

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'eurocell-feb-will-truman', expect: [
  'EUROCELL PLC: DARREN WATERS WILL STEP DOWN AS CEO',
  'EUROCELL PLC: WILL TRUMAN APPOINTED CEO'
], headline: '', body: `RNS Number : 2839S
Eurocell plc
09 February 2026

9 February 2026

EUROCELL PLC

("Eurocell" the "Group" or the "Company")

Directorate Changes

Eurocell plc, the leading UK manufacturer and distributor of door and window products to the trade, today announces that Darren Waters will step down as Chief Executive Officer (CEO) with immediate effect.   The Board believes that to achieve our strategic objectives in this critical year it is in the best interests of the Company to have surety of leadership and a seamless handover, therefore the Board has appointed Will Truman as CEO commencing immediately.

Will Truman vacates his role as CFO Designate.  Michael Scott has agreed to postpone his retirement and continue as CFO, whilst the Board commences a full and rigorous recruitment process to identify a permanent CFO for the business.

Derek Mapp, Chair, commented:"On behalf of myself and the Board, I would like to thank Darren for his leadership over the last 3 years."

Enquiries:

Eurocell plc

Will Truman, Chief Executive Officer                                    +44 (0) 1773 842 105

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'santander-ceo-of-filer', expect: [
  'SANTANDER UK GROUP HOLDINGS PLC: MAHESH ADITYA APPOINTED CEO'
], headline: '', body: `RNS Number : 0792R
Santander UK Group Holdings PLC
30 January 2026

Santander UK - Appointment of new Chief Executive Officer

The Boards of Santander UK announced today, 30 January 2026, the appointment of Mahesh Aditya as Chief Executive Officer of Santander UK Group Holdings plc and Santander UK plc with effect from 1 March 2026.

Mahesh joins from Banco Santander, where he has been Group Chief Risk Officer since 2023 and prior to that spent six years at Santander in the US, as Chief Risk Officer, Santander US for two years, followed by CEO of Santander Consumer USA from 2019 to 2023.  He has over 30 years' financial services experience having held positions across a range of blue-chip brands including Citi, JPMorgan Chase & Co and Capital One. Mahesh was appointed to the Santander UK Boards (Santander UK Group Holdings plc and Santander UK plc) on 1 October 2025.

- Ends -

Additional information about Santander UK

Santander UK is a financial services provider in the UK that offers a wide range of personal and commercial financial products and services.

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'hollywood-bowl-join-board', expect: [
  'HOLLYWOOD BOWL GROUP PLC: ANTONY SMITH APPOINTED CFO',
  'HOLLYWOOD BOWL GROUP PLC: LAURENCE KEEN WILL STEP DOWN FROM BOARD'
], headline: '', body: `RNS Number : 0348I
Hollywood Bowl Group plc
20 November 2025

20 November 2025

Hollywood Bowl Group plc

("Hollywood Bowl", or the "Group")

Directorate Change

Hollywood Bowl is pleased to announce an update regarding its senior leadership team. Having been the Group's Chief Financial Officer for 12 years, as well as supporting the delivery of the Group's strategic progress, Laurence Keen has informed the Board that he would like to explore the opportunity for a more operational role and step down from the Board. Accordingly, Laurence will be appointed Chief Executive Officer ("CEO") of Canada. Alongside this we are pleased to announce that Antony Smith will join the Board and leadership team as Group Chief Financial Officer ("CFO") on 2 February 2026.

The appointment of Antony brings significant expertise to the Group with his extensive experience in multi-site and consumer businesses. He recently spent five years as Chief Financial Officer of Ten Entertainment Group PLC, the UK's second largest ten pin bowling operator.

Laurence will take on the newly created role of 'Chief Executive Officer - Canada', to help accelerate the Group's growth strategy and support the development of the existing management team in Canada.

Laurence will move to his new role based in Canada, following the effective transition of his responsibilities to Antony and accordingly will not stand for the re-election to the Board at the Annual General Meeting in January 2026.

Stephen Burns, Chief Executive Officer of Hollywood Bowl Group, said:"I'd like to thank Laurence for the immense contribution he has made during his 12-year tenure as CFO."

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'victrex-join-company', expect: [
  'VICTREX PLC: JAMES ROUTH APPOINTED CEO',
  'VICTREX PLC: JAKOB SIGURDSSON WILL STEP DOWN AS CEO'
], headline: '', body: `RNS Number : 1863E
Victrex PLC
21 October 2025

21 October 2025

Victrex plc

CEO succession update

Dr James Routh to start as CEO of Victrex on 1 January 2026

Victrex plc, an innovative world leader in high performance polymer solutions, whose products enable environmental and societal benefit in multiple end-markets, today announces that James Routh will join the Company as Chief Executive Officer with effect from 1 January 2026, succeeding Jakob Sigurdsson. He will join the Board as an Executive Director from the same date.

Jakob Sigurdsson will continue to serve on the Victrex Board as Chief Executive until James joins, to support an orderly transition, and then as an Executive Director. Jakob will step down from the Board at the conclusion of the Company's Annual General Meeting on 6 February 2026.

This announcement follows the CEO succession announcement of 8 July 2025 and is pursuant to UK Listing Rule 6.4.7R.

Victrex plc:

Andrew Hanson, Director of Investor Relations, Corporate Communications & ESG

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'glanbia-retire-role', expect: [
  'GLANBIA PLC: WENDY CHANG SMITH APPOINTED CFO DESIGNATE',
  'GLANBIA PLC: MARK GARVEY WILL RETIRE AS CFO'
], headline: '', body: `RNS Number : 1383U
Glanbia PLC
10 September 2026

Glanbia appoints Wendy Chang Smith as Chief Financial Officer Designate

10 September 2026, Glanbia plc ("Glanbia", the "Group", the "Company", the "plc"), the 'Better Nutrition company', announces that Mark Garvey will retire from the Group following thirteen years as Chief Financial Officer ("CFO").  Mark will step down as CFO and from the Glanbia Board on 30 March 2027 and will retire from the Group on 30 April 2027.

Wendy Chang Smith, currently Chief Digital & Transformation Officer, will be appointed Glanbia CFO and an Executive Director on the Company's Board on 31 March 2027. With effect from today Wendy takes on the role of CFO Designate of Glanbia.

Wendy was previously CFO of Glanbia's Performance Nutrition segment. Before joining Glanbia in 2020, Wendy held senior finance positions with Amazon, Kellogg, Johnson & Johnson and Proctor & Gamble, working in the US, Europe and Asia.

Hugh McGuire, CEO Glanbia said:

"I would like to congratulate Wendy on her appointment as Chief Financial Officer Designate. I would also like to warmly thank Mark for his outstanding leadership and significant contribution to Glanbia over the past thirteen years.Mark leaves Glanbia on a firm financial footing, with an exceptionally strong balance sheet and well positioned for the future."

ENDS

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'wellnex-role-as', expect: [
  'WELLNEX LIFE LIMITED: JOE RINARELLI APPOINTED CFO',
  'WELLNEX LIFE LIMITED: VIVIENNE ZHANG WILL STEP DOWN AS CFO'
], headline: '', body: `RNS Number : 7195S
Wellnex Life Limited
01 September 2026

ASX/AIM Announcement

1 September 2026

Change of Chief Financial Officer

Wellnex Life Limited (ASX/AIM: WNX)("Wellnex Life" or the "Company") advisesthat Ms Vivienne Zhang will step down from her role as Chief Financial Officer ("CFO"), with Mr Joe Rinarelli appointed as the Company's new Chief Financial Officer.

Mr Rinarelli is an experienced Chartered Accountant with more than 15 years of accounting and finance experience.

Mr Rinarelli will commence in the role on 1 September 2026 on a part-time basis.

To support an orderly and seamless handover, Ms Zhang will remain engaged by the Company as a consultant for a transitional period, working closely with Mr Rinarelli and the management team to facilitate the transfer of responsibilities and corporate knowledge.

Commenting on the transition, Wellnex Life Interim Executive Chair Eric Jiang, said:

"On behalf of the Board and everyone at Wellnex, I would like to thank Vivienne for her dedication, commitment and strong work ethic during her tenure as Chief Financial Officer."

--- END ---

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'stonewater-jul-role-of', expect: [
  'STONEWATER FUNDING PLC: KIRSTY SPARK APPOINTED CFO'
], headline: '', body: `RNS Number : 9541N
Stonewater Funding PLC
27 July 2026

RNS Number: [x]

Stonewater Funding PLC

27 July 2026

Stonewater appoints new Chief Financial Officer

Stonewater has appointed Kirsty Spark to the role of Chief Financial Officer, who will join the organisation's Chief Officer Group to lead on Finance, Governance and Assurance.

Kirsty currently serves as Chief Financial Officer at affordable housing provider Accent Group Ltd and is also a Board and Audit committee member of Leeds Federated.

Kirsty will take up her new position as Chief Financial Officer with Stonewater from 24 November 2026.

For further information, please see our website, or contact:

Jonathan Layzell                               Telephone: +44 1202 319119

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'eurocell-apr-possessive', expect: [
  'EUROCELL PLC: MATT WORSTER APPOINTED CFO'
], headline: '', body: `RNS Number : 8252A
Eurocell plc
17 April 2026

17 April 2026

EUROCELL PLC

(the "Company")

Leadership Update - CFO Appointment

Eurocell plc, the leading UK manufacturer and distributor of door and window products to the trade, today announces the following changes to the Board.  Further to the announcement made in February 2026 regarding Michael Scott's delayed retirement from the business, the Company is pleased to announce the appointment of Matt Worster as the company's new CFO, who will succeed Michael in the Autumn and join the Board as an Executive Director.

Matt has held roles within the Travis Perkins Group since 2014, currently as the Finance Director of Travis Perkins General Merchant. He has also held the position of Director of Investor Relations at Travis Perkins PLC and, before that was the Finance Director at CCF.

Commenting on his appointment, Will Truman, CEO, said:

"We are delighted to welcome Matt as Chief Financial Officer. He has significant financial and investor relations experience as well as a strong understanding of the UK construction industry."

Enquiries:

Eurocell plc

Will Truman, Chief Executive Officer                                    +44 (0) 1773 842 105

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'stonewater-mar-leaving-interim', expect: [
  'STONEWATER FUNDING PLC: FRANCESCO ELIA APPOINTED INTERIM CFO',
  'STONEWATER FUNDING PLC: ANNE COSTAIN STEPS DOWN AS CFO'
], headline: '', body: `RNS Number : 6149X
Stonewater Funding PLC
23 March 2026

RNS Number: 6149X

Stonewater Funding PLC

23 March 2026

New Interim CFO appointed at Stonewater

Stonewater has announced that Anne Costain, Chief Financial Officer, is leaving the organisation with immediate effect. Francesco Elia has been appointed as Chief Finance Officer on an interim basis, bringing a wealth of experience in the sector including strategic leadership, financial modelling, governance, ESG, treasury and operational efficiency.

Stonewater CEO, Jonathan Layzell says: "We're delighted to welcome Francesco to our Chief Officer Group. He brings a great deal to the table, including strong capability in strategic planning and investor relations, alongside extensive commercial acumen."

For further information, please contact:
Jonathan Layzell                                             Telephone: +44 1202 319119

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'drax-appoint-role-first', expect: [
  'DRAX GROUP PLC: DANIEL PEACOCK APPOINTED INTERIM CFO'
], headline: '', body: `RNS Number : 3896V
Drax Group PLC
05 March 2026

5 March 2026

Drax Group plc

("Drax"; "The Group"; Symbol: DRX)

Interim CFO

Drax Groupannounces today that its Chief Financial Officer, Frank Lemmink, is taking a six-month leave of absence to support his recovery from a recent health issue, effective immediately. The Company's Board of Directors is pleased to appoint Deputy Chief Financial Officer, Daniel Peacock, as interim Chief Financial Officer for the duration of Frank's leave. In this role, Daniel will report to Will Gardiner, Chief Executive Officer. The composition of the Company's Board of Directors remains unchanged.

Daniel is a Chartered Accountant and, prior to becoming Deputy Chief Financial Officer, was  Director of Business Finance and FP&A since joining the Group in 2019.

Will Gardiner, CEO of Drax Group said, "On behalf of the Board and the entire Drax team, we wish Frank a speedy and full recovery."

Enquiries:

Drax Investor Relations:

Mark Strafford

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'icfg-parenthetical-name', expect: [
  'ICFG LIMITED: TAT CHEUNG WONG APPOINTED CFO'
], headline: '', body: `RNS Number : 2825R
ICFG Limited
02 February 2026

2 February 2026

ICFG LIMITED

("ICFG", "Company" or the "Group")

Appointment of Chief Financial Officer

IFCG Limited (LON: ICFG), the international financial services group,is pleased to announce the appointment of Mr Tat Cheung (Stephen) Wong as Chief Financial Officer ("CFO") of the Company, with immediate effect.

Stephen is a qualified accountant with extensive experience in international corporate financial reporting, fund services, and corporate structuring. He was previously the CFO of Amicorp FS (UK) PLC, a company listed on the Main Market of the London Stock Exchange, a position he held from 2020 until his recent departure.

Ankhbold Bayanmunkh, Chairman of ICFG, commented:

"We are delighted to welcome Stephen to IFCG as CFO."

For further information, please contact:

ICFG Limited

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'satsuma-role-in-headline', expect: [
  'SATSUMA TECHNOLOGY PLC: ANDREW SMITH APPOINTED CFO'
], headline: 'Appointment of Chief Financial Officer', body: `RNS Number : 1913D
Satsuma Technology PLC
14 October 2025

14 October 2025

Satsuma Technology Plc

('Satsuma' or the 'Company')

Appointment of Chief Financial Officer

Satsuma Technology PLC (LSE: SATS) today announces the appointment of Andrew Smith to the board of Satsuma with effect from 1 November 2025.

He was previously CFO of FTSE250 listed technology company, Playtech PLC from 2017 to 2022. During his time there, Andy led the corporate, finance and treasury functions, raising billions in funding in the public markets.

He started his career in 1999 at Ashurst (including an 18-month secondment at the Financial Conduct Authority).

Henry K. Elder, CEO, commented:

"I am thrilled to welcome Andy to the Satsuma board."

Enquiries:

Satsuma Technology PLC

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'tristel-cfo-of-filer', expect: [
  'TRISTEL PLC: ANNA WASYL APPOINTED CFO'
], headline: '', body: `RNS Number : 2969X
Tristel PLC
01 September 2025

TRISTEL plc

("Tristel" or the "Company")

Confirmation of CFO Appointment

Tristel plc (AIM: TSTL), the manufacturer of infection prevention products, confirms the appointment of Anna Wasyl as Chief Financial Officer ("CFO") of Tristel, effective from today.

As previously announced inJuly 2025, Anna joins the Company replacing Liz Dixon who left the business on 30 June 2025, having been with the Group since 2007. Anna brings extensive experience from her previous roles across different sectors including medical devices, robotics, and industrial automation.

Anna Wasyl, Chief Financial Officer of Tristel plc

Matt Sassone, CEO of Tristel plc, said: "Anna has joined at an exciting time for Tristel plc."

For further information please contact:
Tristel plc

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'beacon-rise-honorific-glue', expect: [
  'BEACON RISE HOLDINGS PLC: MARK TAVENER APPOINTED CFO'
], headline: '', body: `RNS Number : 9230V
Beacon Rise Holdings PLC
19 August 2025

19 August 2025

BEACON RISE HOLDINGS PLC

Appointment of Chief Financial Officer

The board of directors (the "Board") of Beacon Rise Holdings Plc (the "Company") is pleased to announce that MrMark Tavenerhas been appointed as Chief Financial Officer ("CFO") of the Company with effect from Monday, 18 August 2025.

As CFO, Mr Tavener will oversee the Company's financial strategy and execution, risk management, capital structure optimisation, investment and financing decisions, budgeting, and financial team leadership.

Mr Tavener is a chartered accountant with over 14 years' experience in a 'Big 4' accountancy practice, both in audit and corporate finance, and has over 5 years' experience as a CFO in an AIM listed company.

Mr Tavener commented:  I am very pleased to be joining Beacon Rise Holdings Plc as their CFO and part of the management team. This is a very exciting venture that will establish new standards of performance in thenewposition.

Enquiries:

Xiaobing Wang, Director

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'seascape-nonexec-chair', expect: [
  'SEASCAPE ENERGY ASIA PLC: GERALDINE MURPHY APPOINTED NON-EXECUTIVE CHAIR',
  'SEASCAPE ENERGY ASIA PLC: HAIDA HAZRI APPOINTED SENIOR INDEPENDENT DIRECTOR',
  'SEASCAPE ENERGY ASIA PLC: JAMES MENZIES STEPS DOWN AS EXECUTIVE CHAIRMAN'
], headline: '', body: `RNS Number : 8230W
Seascape Energy Asia PLC
30 September 2026

THIS ANNOUNCEMENT CONTAINS INSIDE INFORMATION FOR THE PURPOSES OF ARTICLE 7 OF REGULATION 596/2014 AS AMENDED AND TRANSPOSED INTO UK LAW IN ACCORDANCE WITH THE EUROPEAN UNION (WITHDRAWAL) ACT 2018 ("UK MAR").

30 September 2026

Seascape Energy Asia plc

("Seascape Energy", the "Company" or "Seascape")

Board Changes

Seascape Energy, an E&P company focused on Southeast Asia, announces that its Executive Chairman, James Menzies, has stepped down from the board to focus on his continuing recovery from a serious cycling accident in the summer.

Geraldine Murphy, currently Interim Non-Executive Chair, has been appointed Non-Executive Chair on a permanent basis, continuing her strong support of the Company and its growth strategy since inception.

Geraldine has over 35 years of energy investment banking and M&A experience in senior roles at Standard Chartered Bank, Harrison Lovegrove, CIBC and Perella Weinberg Partners. Geraldine joined the Seascape board in June 2024 and has been instrumental in the transformational pivot of the Company to Southeast Asia.

Additionally, Haida Hazri, currently Non-Executive Director, has been appointed Senior Independent Director and Chair of the Audit Committee.

Haida has over 25 years of experience in E&P, LNG and technology within PETRONAS, Sapura Energy and various other energy entities across a wide range of legal and commercial roles.

Geraldine Murphy, Non-Executive Chair, commented:

"Our thoughts remain with James as his recovery continues to progress with the help of his friends and family."

Ends

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'dp-aircraft-committee-chairs', expect: [
  'DP AIRCRAFT I LIMITED: JEREMY THOMPSON APPOINTED CHAIR',
  'DP AIRCRAFT I LIMITED: JON BRIDEL RETIRES FROM BOARD'
], headline: '', body: `RNS Number : 8186U
DP Aircraft I Limited
15 September 2026

15 September 2026

DP Aircraft I Limited

Board Changes

DP Aircraft I Limited (the "Group") announces that, following the retirement of Jon Bridel from the Board with effect from 15 September 2026, Jeremy Thompson has been appointed Chairman of the Board.

Howard Millar has been appointed Chairman of the Audit and Risk Committee.

Harald Brauns has been appointed Chairman of the Nomination Committee and will continue in his existing role as Chairman of the Management Engagement Committee.

The Board would like to thank Jon for his contribution to the Group and wishes him well for the future.

Enquiries

For further information, please contact:

Aztec Financial Services (Guernsey) Limited                       +44(0) 1481 749747

This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END` },

{ name: 'ariana-the-current-appositive', expect: [
  'ARIANA RESOURCES PLC: MICHAEL ATKINS APPOINTED EXECUTIVE CHAIRMAN'
], headline: '', body: `RNS Number : 4811U
Ariana Resources PLC
14 September 2026

RNS Reach

14 September 2026

AIM: AAU

ASX: AA2

Appointment of Executive Chairman

Ariana Resources plc (AIM: AAU, ASX: AA2, “Ariana” or the “Company”), the mineral exploration and development company advancing the 1.6 Moz Dokwe Gold Project in Zimbabwe, is pleased to advise that Mr Michael Atkins, the current Non-Executive Chairman, has been appointed Executive Chairman of the Company with immediate effect.

Dr Kerim Sener, Managing Director, commented:

“The Company is entering an important stage in the advancement of the Dokwe Gold Project. Michael’s progression into an executive role will strengthen the leadership resources available to the Company as we progress the Definitive Feasibility Study.”

As required by LR 3.16.4 the remuneration for this role is an annual fee of £120,000 gross.

- ENDS -

The Board of Ariana Resources plc has approved this announcement and authorised its release.

Contacts:

Ariana Resources plc

Michael Atkins, Non-Executive Chairman

This is a Reach announcement. Reach is an investor communication service aimed at assisting listed and unlisted (including AIM-quoted) companies to distribute media-only/non-regulatory news releases into the public domain.

This information is provided by Reach, the non-regulatory press release distribution service of RNS, part of the London Stock Exchange.

END` },

];
