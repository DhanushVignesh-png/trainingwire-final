// Precision fixtures. Step 5 and 7 loosened the appointment and departure
// patterns considerably; these exist to catch the false positives that come
// with that. Run them the same way: node test/run.js --neg [--report]

const RNS_FOOT = `
This information is provided by RNS, the news service of the London Stock Exchange. RNS is approved by the Financial Conduct Authority to act as a Primary Information Provider in the United Kingdom.

END`;

module.exports = [

// Background prose about roles held elsewhere must not read as appointments.
{ name: 'neg-background-prose', expect: [], headline: '', body: `RNS Number : 1111A
Example Holdings plc
01 January 2026

Trading Update

Example Holdings plc today announces a trading update for the year ended 31 December 2025.

Chief Executive Jane Doe said: "Trading has been strong." Prior to being appointed Chief Executive Officer in 2019, Jane served as Chief Financial Officer for six years. She joined the Company from Rival plc, where she held the role of Managing Director of UK Retail.

Revenue grew 8 per cent and the Board expects to report adjusted operating profit ahead of consensus.${RNS_FOOT}` },

// A purely divisional appointment is not a group board change.
{ name: 'neg-divisional-only', expect: [], headline: '', body: `RNS Number : 2222B
Example Holdings plc
02 February 2026

Example Holdings plc ("Example" or the "Group")

Leadership Update

Example Holdings plc announces that Peter Nolan has been appointed Chief Executive Officer of Example Interactive, the Group's online division, with effect from 1 April 2026.

Peter joins from Rival Digital plc. He will report to the Group Chief Executive.${RNS_FOOT}` },

// Committee chair appointments only — suppressed by decision.
{ name: 'neg-committee-chairs-only', expect: [], headline: '', body: `RNS Number : 3333C
Example Trust plc
03 March 2026

Example Trust plc

Committee Changes

Example Trust plc announces that Sandra Powell has been appointed Chairman of the Audit Committee and that Neil Archer has been appointed Chairman of the Remuneration Committee.

Both appointments take effect immediately.${RNS_FOOT}` },

// Routine AGM re-election is not a new appointment.
{ name: 'neg-agm-reelection', expect: [], headline: '', body: `RNS Number : 4444D
Example Holdings plc
04 April 2026

Result of Annual General Meeting

Example Holdings plc announces that all resolutions put to shareholders at the Annual General Meeting held today were duly passed.

Nicholas Willis was reappointed as Senior Independent Director and Douglas Fraser was reappointed as Non-Executive Director.${RNS_FOOT}` },

// Someone else's appointment mentioned as biography.
{ name: 'neg-third-party-bio', expect: [
  'EXAMPLE HOLDINGS PLC: SARAH BRIGHT APPOINTED CFO'
], headline: '', body: `RNS Number : 5555E
Example Holdings plc
05 May 2026

Example Holdings plc ("Example" or the "Company")

Appointment of Chief Financial Officer

Example Holdings plc is pleased to announce the appointment of Sarah Bright as Chief Financial Officer of the Company with effect from 1 July 2026.

Sarah is currently Chief Financial Officer of Unrelated Group plc, a position she has held since 2021. She was previously appointed Finance Director of Another Bidco Limited in 2018 and she currently serves as a Non-Executive Director of Third Party plc.${RNS_FOOT}` },

// A leave of absence is not a departure; the interim cover is the story.
{ name: 'neg-leave-of-absence', expect: [
  'EXAMPLE HOLDINGS PLC: DANIEL REED APPOINTED INTERIM CFO'
], headline: '', body: `RNS Number : 6666F
Example Holdings plc
06 June 2026

Example Holdings plc

Interim CFO

Example Holdings plc announces that its Chief Financial Officer, Frank Mills, is taking a six-month leave of absence, effective immediately. The Board is pleased to appoint Deputy Chief Financial Officer, Daniel Reed, as interim Chief Financial Officer for the duration of Frank's leave.${RNS_FOOT}` },

// Deal path must be untouched by the board work. This expectation is the
// pristine pre-change output, verified identical, not a statement of what the
// ideal deal snap would look like.
{ name: 'neg-deal-path-intact', expect: [
  'TARGET HOLDINGS PLC: TARGET — RECOMMENDED CASH OFFER'
], headline: 'Recommended cash offer for Target Holdings plc', body: `RNS Number : 7777G
Target Holdings PLC
07 July 2026

NOT FOR RELEASE, PUBLICATION OR DISTRIBUTION IN WHOLE OR IN PART IN ANY JURISDICTION WHERE TO DO SO WOULD CONSTITUTE A VIOLATION OF THE RELEVANT LAWS OF SUCH JURISDICTION

7 July 2026

RECOMMENDED CASH OFFER

for

Target Holdings plc ("Target")

by

Bidco Limited ("Bidco")

The boards of Bidco and Target are pleased to announce that they have reached agreement on the terms of a recommended cash offer to be made by Bidco for the entire issued and to be issued ordinary share capital of Target.

Under the terms of the Acquisition, Target Shareholders will be entitled to receive 250 pence in cash for each Target Share, valuing the entire issued and to be issued ordinary share capital of Target at approximately GBP 1.2 billion.${RNS_FOOT}` },

];
