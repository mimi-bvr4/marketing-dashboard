# Nashville Metro Nonprofit Gala & Fundraiser Research

**Prepared for:** Mimi Beaver, Infinity Hospitality Group  
**Research run:** 10.08.2026 · **This write-up:** 11.05.2026  
**Area:** Davidson, Williamson, Rutherford, Sumner and Wilson counties

## Summary

- **164 recurring nonprofit galas, balls, luncheons, auctions and signature fundraisers**, each with a source link and grouped by month. Confidence breakdown: 80 high, 61 medium, 23 low.
- **10,498 registered 501(c)(3)s** in the five counties checked against their IRS 990 filings. **524** report fundraising events.
- **282 organizations** reported $75,000+ in event gross receipts on their latest Schedule G. **99** calendar events now carry an IRS-reported size. **220** large event filers are not on the calendar yet: these are leads that still need dates.
- **Deliverables:** an interactive calendar page (Artifact), a standalone HTML copy for sharing, and this report.

## What was asked

List every nonprofit fundraiser, gala and outreach event in metro Nashville. The proposed method was to start from the full list of registered 501(c)(3)s, check each org's website for events, cross-reference newspapers and society magazines, and organize the results by time of year. Requests added during the session:

- Look for public event filings on nashville.gov
- Include the largest school fundraisers
- Find more ways to surface events

## How the research was done

### Change of approach
Crawling the website of every registered 501(c)(3) wasn't practical. The metro has over 10,000 of them, and most never hold an event. The research worked from two directions instead:

1. **Press and organization sweeps:** society coverage and the calendars of large orgs. This finds events and dates.
2. **An IRS 990 sweep of every registered 501(c)(3):** this finds which orgs actually hold events and how big they are. It covers your "every 501(c)(3)" idea, using the IRS filing in place of each org's website.

### Phase 1: Press and organization sweeps (7 parallel research passes)

| Pass | Scope | Rows returned |
|---|---|---|
| Arts & culture | Symphony, Frist, Cheekwood, TPAC, Ballet, Opera, Rep, historic sites, library, Williamson/Rutherford arts | 29 |
| Health & medical | Hospital foundations, disease orgs, hospice, Gilda's Club, RMHC, Make-A-Wish, Nashville CARES | 26 |
| Youth & education | BGCMT, BBBS, Girl & Boy Scouts, PENCIL, NPEF, Oasis, JA, Zoo | 30 |
| Human services & community | Hunger, housing, women, DV, veterans, animals, parks/environment, sports foundations | 29 |
| Society calendar sweep | Nfocus, Nashville Lifestyles, Nashville Guru, Williamson Herald/Scene, Southern Exposure | 56 |
| Schools & universities | Private school auctions and galas, parent associations, university scholarship galas | 22 |
| Gap fill | ~45 large orgs the earlier passes ran out of searches before reaching | 27 |

Rules for every pass:

- Each event recurs (2+ years).
- Each row cites a source URL.
- No guessed dates or venues. Anything unconfirmed is marked "unverified".

After de-duplication: **164 events**.

### Phase 2: Government records (blocked from here)

| Source | What it is | Result |
|---|---|---|
| Metro Nashville special event permits (nashville.gov) | Permits for street closures, parks and outdoor events | Site blocked to this workspace. Would mostly miss hotel/ballroom galas anyway. |
| Metro Beer Permit Board agendas | Temporary/special-event beer permits by applicant | Site blocked. Worth pulling 2025–2026 agenda PDFs by hand. |
| TN ABC Special Occasion Licenses | Alcohol licenses issued **only** to nonprofits for events | tn.gov blocked. Best route is a Tennessee Public Records Act request (5 counties, 2024–2026). Closest thing to a nonprofit-only event list. |
| Franklin / Brentwood permits & beer boards | Same, for Williamson County | Sites wouldn't load. |

### Phase 3: IRS 990 Schedule G sweep

Run in a Chrome tab through ProPublica Nonprofit Explorer.

1. **Enumerate:** searched 501(c)(3)s by city: 27 metro cities, with Mt. Juliet run under both spellings (Nashville, Antioch, Hermitage, Madison, Old Hickory, Goodlettsville, Whites Creek, Joelton, Franklin, Brentwood, Nolensville, Thompson's Station, Spring Hill, College Grove, Fairview, Murfreesboro, Smyrna, La Vergne, Eagleville, Gallatin, Hendersonville, Portland, White House, Westmoreland, Lebanon, Mt. Juliet, Watertown). **10,498 orgs.**
2. **Screen:** pulled each org's filings from 2021 on and kept any with fundraising-event gross income. **524 orgs.**
3. **Schedule G:** read Part II (Fundraising Events) of each org's latest available return: names of the two largest events, count of other events, gross receipts, venue/rent and food & beverage spend. **462 retrieved.**
4. **Filter:** kept orgs with $75,000+ in total event gross receipts, and dropped rows that weren't real events (thrift stores, raffles, concessions, year-end campaigns). **282 orgs.**
5. **Match:** linked filers to calendar orgs, checking by hand and removing wrong matches (e.g., the Steeplechase files under Volunteer State Horsemen's Foundation, not VUMC). **62 filers matched; 99 calendar events sized.**

## Key findings

- **When the season peaks:** fall is the densest season, then spring. September, October and November carry the most events. Summer and January–February are the lightest.
- **Where events are held:** a short list of rooms hosts most big galas: Four Seasons, JW Marriott, Omni, Music City Center, Schermerhorn, Country Music Hall of Fame, City Winery, Marathon Music Works. For Williamson County, add Liberty Hall at The Factory and Harlinsdale Farm.
- **Largest calendar events by IRS gross (single event):**
  - Literary Award Gala (Nashville Public Library Foundation): $1,051,525, TY2024
  - Big Breakfast (Big Brothers Big Sisters of Middle Tennessee): $996,303, TY2024
  - Symphony Fashion Show (Nashville Symphony (Symphony League)): $942,943, TY2024
  - Dancing for Safe Haven (Safe Haven Family Shelter): $919,315, TY2024
  - Iroquois Steeplechase (Volunteer State Horsemen's Foundation (benefits Monroe Carell Jr. Children's Hospital)): $913,166, TY2025
  - Symphony Ball (Nashville Symphony): $907,850, TY2024
  - Sunday in the Park (Friends of Warner Parks): $863,675, TY2024
  - Great Futures Gala (Boys & Girls Clubs of Middle Tennessee): $781,915, TY2024
  - River Swing (Harpeth Conservancy): $766,624, TY2024
  - Wine Women & Shoes (YWCA Nashville & Middle Tennessee): $713,206, TY2024
- **Largest event filers not on the calendar yet:**
  - The Brett Boyer Foundation Inc: REDBIRD GAMES / GOLF TOURNAMENT, $4,646,433 all events
  - Union Sportsmens Alliance: GALA / CLAY SHOOT # 1, $3,733,757 all events
  - Acm Lifting Lives: GOLF EVENT / KICKOFF FOR A C, $2,148,985 all events
  - The Community Fdn Of Middle Tn Inc: DELEK TOURNAMENT OF HOPE / CFRC RODEO, $1,957,435 all events
  - Scott Hamilton Cares Foundation Inc: AN EVENING WITH SCOTT / SK8 TO ELIMIN8 CANCER, $1,757,657 all events
  - Mission Lazarus: SONGS ON A MISSION, $1,332,861 all events
  - Shikar-safari Club International: Auction, $1,261,870 all events
  - Love Is A Gift Incorporated: THE HOMESTEAD F, $1,197,366 all events
  - Daystar Counseling Ministries Inc: EVENING IN DECEMBER / OCTOBER THING, $1,116,604 all events
  - Brightstone Inc: BENEFITS / CRAFT FAIRS, $1,074,652 all events
- **Swan Ball:** after the 2024 split from Cheekwood, it benefits Friends of Warner Parks. Cheekwood has not announced a replacement gala.

## The calendar

Confidence key:

- **High:** date and recurrence confirmed.
- **Medium:** recurs, but this year's date or venue isn't confirmed.
- **Low:** last seen 1+ years ago, or a thin source.

The "990 gross" column is from the latest Schedule G. It includes sponsorship and contributions given at the event, not just tickets. "All events" means the IRS figure covers all of that org's events combined.

### January · Winter (2)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 01.09.2026 | **Antiques & Garden Show of Nashville** | Cheekwood + ECON Charities | Music City Center | show | high | $305,329 (all events) | [link](https://cheekwood.org/calendar-events/antiques-garden-show-of-nashville/) |
| TBD | **Grand Night** | Nashville Children's Theatre | Nashville Children's Theatre | gala | medium | $100,223 | [link](https://nashvillechildrenstheatre.org/a-grand-night-for-nct/) |

### February · Winter (8)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 02.04.2026 | **Tocqueville Society Kickoff** | United Way of Greater Nashville | HCA Healthcare Impact Center | other | low |  | [link](https://www.unitedwaygreaternashville.org/wp-content/uploads/2026/01/2026-Board-Event-Calendar-01.12.26-v2.pdf) |
| 02.06.2026 | **Bottles for BizTown** | Junior Achievement of Middle Tennessee | JA BizTown | other | medium | $663,970 (all events) | [link](https://nashville.ja.org/events) |
| 02.19.2026 | **Shade Tree Clinic Benefit Dinner & Silent Auction** | Shade Tree Clinic (Vanderbilt) | Vanderbilt Student Life Center | auction | high |  | [link](https://news.vumc.org/2025/11/14/shade-tree-benefit-dinner-set-for-feb-19/) |
| 02.21.2026 | **Middle Tennessee Heart Gala** | American Heart Association | JW Marriott Nashville | gala | high |  | [link](https://www2.heart.org/site/DocServer/S26_SE_TN_Nashville_HB_Program.pdf) |
| 02.23.2026 | **Friends & Fashion** | Friends of Monroe Carell Jr. Children's Hospital at Vanderbilt | The Pinnacle | luncheon | high | $264,247 | [link](https://news.vumc.org/2025/11/14/tickets-available-for-friends-fashion-2026/) |
| 02.25.2026 | **Conversations at OZ** | OZ Arts Nashville | unverified | other | high | $129,650 | [link](https://www.ozartsnashville.org/conversations-2026/) |
| TBD | **Consignment Sale** | Oak Hill School | Oak Hill Enrichment Center | other | medium | $485,356 | [link](https://sites.google.com/oakhillschool.org/consignment/home) |
| TBD | **La Bella Notte** | Nashville Opera | unverified (2025: 1 Hotel Nashville) | gala | medium | $367,156 | [link](https://nashvilleopera.org/labellanotte) |

### March · Spring (13)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 03.03.2026 | **Second Harvest Chefs' Dinner** | Second Harvest Food Bank of Middle Tennessee | unverified | gala | high | $812,156 (all events) | [link](https://www.secondharvestmidtn.org/events/) |
| 03.05.2026 | **Alive & The Bluebird in the Boro** | Alive Hospice | Copper Ridge Event Venue (Rutherford Co.) | concert | medium |  | [link](https://alivehospice.org/news-events/alive-the-bluebird-in-the-boro-celebrates-10-years-of-music-community-and-compassionate-end-of-life-care-in-rutherford-county/) |
| 03.06.2026 | **Masquerade Gala of Music City** | The Aloe Family | Marathon Music Works | gala | medium | $45,720 | [link](https://nashvilleguru.com/89728/masquerade-gala-of-music-city) |
| 03.06.2027 | **Thin Mint Sprint** | Girl Scouts of Middle Tennessee | Cornelia Fort Airpark | race | high | $239,647 (all events) | [link](https://www.gsmidtn.org/en/support-us/signature-events.html) |
| 03.07.2026 | **Ballet Ball** | Nashville Ballet | Schermerhorn Symphony Center | ball | high | $466,387 | [link](https://www.nashvilleballet.com/news/2026-ballet-ball-swan-lake-theme) |
| 03.21.2026 | **Wine Women & Shoes** | YWCA Nashville & Middle Tennessee | Music City Center | show | high | $713,206 | [link](https://www.ywcanashville.com/news-blog/wine-women-amp-shoes-steps-back-into-nashville-on-march-21) |
| 03.24.2026 | **Reclaiming Lives Luncheon** | Centerstone | Four Seasons Hotel Nashville | luncheon | high |  | [link](https://centerstone.org/reclaiming-lives-luncheon/) |
| 03.26.2018 | **Nashville Honors Gala** | T.J. Martell Foundation | Omni Nashville Hotel (2018) | gala | low |  | [link](https://musicrow.com/?p=275211) |
| 03.28.2026 | **TPAC Gala (+ Late Party)** | Tennessee Performing Arts Center | Four Seasons Hotel Nashville | gala | high | $702,457 | [link](https://www.tpac.org/support/fundraising-events/gala) |
| 03.28.2026 | **Tiger Night** | Ensworth Parent Association | Fisher Center, Belmont University | auction | high | $822,096 (all events) | [link](https://www.ensworth.com/community/parent-association/tiger-night) |
| 03.31.2027 | **Friends of Scouting Patron Luncheon** | Middle Tennessee Council, Scouting America | Music City Center | luncheon | high | $313,109 (all events) | [link](https://www.mtcscouting.org/patronluncheon) |
| TBD | **A Red Carpet Evening** | Belcourt Theatre | Belcourt Theatre | gala | medium | $221,918 | [link](https://nashvilleguru.com/89869/a-red-carpet-evening-belcourt-theatre) |
| TBD | **Tennessee Flavors** | Nashville State Community College Foundation | Nashville State Southeast Campus (2024) | other | medium |  | [link](https://www.nscc.edu/about/foundation/campaigns.php) |

### April · Spring (14)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 04.07.2026 | **Generous Helpings** | Second Harvest Food Bank of Middle Tennessee | unverified | other | high | $113,336 | [link](https://www.secondharvestmidtn.org/events/) |
| 04.12.2025 | **Backstage Bash** | The Center for the Arts (Murfreesboro) | Downtown Murfreesboro (tent) | other | medium |  | [link](https://www.classy.org/event/backstage-bash-2025/e663147) |
| 04.16.2026 | **Amplify Nashville** | Siloam Health | unverified | gala | low | $88,476 | [link](https://siloamhealth.org/amplify2026) |
| 04.17.2025 | **Jazz Empowers Gala** | Jazz Empowers | Analog at Hutton Hotel | gala | low |  | [link](https://www.musiccityreview.com/events/jazz-empowers-2025-gala) |
| 04.18.2026 | **Frist Gala** | Frist Art Museum | Frist Art Museum | gala | high |  | [link](https://fristartmuseum.org/frist-gala/) |
| 04.22.2026 | **Cafecito Brunch** | Conexión Américas | unverified | other | medium |  | [link](https://www.conexionamericas.org/events/) |
| 04.24.2025 | **Safe City Breakfast** | Sexual Assault Center | 14TENN | other | medium | $105,351 | [link](https://sexual-assault-center.networkforgood.com/events/79693-2025-safe-city-breakfast) |
| 04.25.2026 | **Greatest Wishes on Earth Gala** | Make-A-Wish Middle Tennessee | Four Seasons Hotel Nashville | gala | medium | $437,304 | [link](https://wish.org/node/65096) |
| 04.25.2026 | **Nashville Promise Gala** | Breakthrough T1D (formerly JDRF) Tennessee | unverified (2025: Omni Nashville) | gala | high |  | [link](https://www.breakthrought1d.org/tennessee/events/breakthrough-t1d-nashville-promise-gala-2026) |
| 04.28.2026 | **Symphony Fashion Show** | Nashville Symphony (Symphony League) | Schermerhorn Symphony Center | show | high | $942,943 | [link](https://nashvilleguru.com/177410/symphony-fashion-show) |
| 04.29.2027 | **Harding Art Show** | Harding Academy | Harding Academy | show | high | $1,906,052 (all events) | [link](https://www.thehardingartshow.com/about) |
| 04.30.2026 | **Dining Out for Life** | Nashville CARES | Participating restaurants citywide | other | high | $148,290 | [link](https://www.nashvillescene.com/food_drink/bites/dining-out-for-life-2026/article_31f18b4d-ff7e-4dbe-bda0-ea0b41f5cd2b.html) |
| TBD | **A Vintage Affair / Vintner's Cup** | A Vintage Affair (Williamson Co. women & children charities) | Liberty Hall, The Factory at Franklin | auction | medium | $466,016 (all events) | [link](https://www.southernexposuremagazine.com/online_features/community_cares/) |
| TBD | **Best Buddies Friendship Walk** | Best Buddies Tennessee | Geodis Park | race | medium |  | [link](https://www.bestbuddiesfriendshipwalk.org/nashville/) |

### May · Spring (10)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 05.01.2026 | **Great Futures Gala** | Boys & Girls Clubs of Middle Tennessee | Omni Nashville Hotel | gala | high | $781,915 | [link](https://cbo.io/app/public/bidapp/bgcmtgala26) |
| 05.04.2026 | **A Little Night of Music** | PENCIL | Grand Ole Opry House | concert | medium | $363,337 | [link](https://pencilforschools.org/meet-the-2026-chairs-for-a-little-night-of-music/) |
| 05.07.2026 | **Strobel Volunteer Awards** | Hands On Nashville / United Way of Greater Nashville | 14TENN Nations | other | high |  | [link](https://www.unitedwaygreaternashville.org/wp-content/uploads/2026/01/2026-Board-Event-Calendar-01.12.26-v2.pdf) |
| 05.09.2026 | **Iroquois Steeplechase** | Volunteer State Horsemen's Foundation (benefits Monroe Carell Jr. Children's Hospital) | Percy Warner Park | race | high | $913,166 | [link](https://www.wkrn.com/news/local-news/nashville/2026-iroquois-steeplechase-sees-record-high-attendance-total-purse/amp/) |
| 05.09.2026 | **NAMIWalks Middle Tennessee** | NAMI Davidson County | unverified | race | medium |  | [link](https://namidavidson.org/get-involved/namiwalks/) |
| 05.10.2027 | **Trefoil Tournament** | Girl Scouts of Middle Tennessee | Hermitage Golf Course | golf | high | $239,647 (all events) | [link](https://www.gsmidtn.org/en/support-us/signature-events.html) |
| 05.13.2026 | **Spring Outing** | Andrew Jackson Foundation (The Hermitage) | The Hermitage | luncheon | high |  | [link](https://www.visitmusiccity.com/media/press-release/2026/andrew-jacksons-hermitage-announces-norah-odonnell-and-kate-andersen) |
| 05.28.2026 | **Hellbender on the River** | Cumberland River Compact | The Platz at Neuhoff | other | high |  | [link](https://cumberlandrivercompact.org/event/hellbender-on-the-river-2026/) |
| 05.29.2026 | **Spring Garden Event** | Belmont Mansion | Private home + Belmont Mansion | other | high |  | [link](https://www.belmontmansion.com/springgardenevent) |
| TBD | **Jockeys & Juleps** | Downtown Franklin Rotary Club | Liberty Hall, The Factory at Franklin | other | medium | $186,532 | [link](https://www.southernexposuremagazine.com/online_features/community_cares/) |

### June · Summer (10)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 06.01.2026 | **Rock 'N Jock Celebrity Softball Game** | Folds of Honor Tennessee | First Horizon Park | other | high | $266,890 | [link](https://shorefire.com/releases/entry/folds-of-honor-tennessee-announces-sixth-annual-rock-n-jock-celebrity-softball-game-set-for-june-1st-at-nashvilles-first-horizon-park) |
| 06.02.2026 | **Stars for Second Harvest** | Second Harvest Food Bank of Middle Tennessee | Ryman Auditorium | concert | high | $343,698 | [link](https://www.secondharvestmidtn.org/events/) |
| 06.06.2026 | **Phoenix Ball** | Cumberland University (Lebanon) | Cumberland University | gala | high | $395,405 | [link](https://www.phoenixball.com/) |
| 06.06.2026 | **Swan Ball** | Swan Ball Inc. (2026 beneficiary: Friends of Warner Parks; Cheekwood until 2024) | Harpeth Meadows, Edwin Warner Park | ball | high |  | [link](https://www.swanball.com/calendar) |
| 06.11.2026 | **JA Golf Classic** | Junior Achievement of Middle Tennessee | Gaylord Springs Golf Links | golf | high | $207,298 | [link](https://nashville.ja.org/events) |
| 06.14.2026 | **Check Out Nashville** | Nashville Public Library Foundation (Next Chapter Society) | Partner businesses citywide | other | medium | $1,051,525 (all events) | [link](https://nplf.org/check-out-nashville-2026/) |
| 06.27.2026 | **Legacy Ball** | R.H. Boyd Family Endowment Fund | Schermerhorn Symphony Center | ball | high |  | [link](https://pr.pioneerpublishers.com/article/RH-Boyd-Hosts-The-Fifth-Annual-Celebration-of-The-Legacy-Ball/6a3151dd45b635ab6be4e9d1) |
| 06.27.2026 | **One Night Only** | Studio Tenn | Liberty Hall, The Factory at Franklin | gala | high | $173,447 (all events) | [link](https://www.williamsonherald.com/communities/studio-tenn-s-annual-fundraising-gala-one-night-only-set-for-june-27-at-the/article_3243c44c-918a-493f-a415-8eafec3cccfc.html) |
| 06.28.2026 | **St. Jude Dream Home Giveaway** | ALSAC / St. Jude | unverified | other | high |  | [link](https://www.stjude.org/give/dream-home/nashville.html) |
| TBD | **Ode to Otha** | Second Harvest Food Bank of Middle Tennessee | unverified | other | medium | $812,156 (all events) | [link](https://www.secondharvestmidtn.org/events/) |

### July · Summer (4)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 07.13.2026 | **BGCMT Golf Classic** | Boys & Girls Clubs of Middle Tennessee | Golf Club of Tennessee, Kingston Springs | golf | high | $1,040,422 (all events) | [link](https://charitygolftoday.com/bgcmidtngolfclassic) |
| 07.16.2026 | **Nourish** | The Nashville Food Project | Marathon Music Works | other | high |  | [link](https://www.nashvillescene.com/food_drink/bites/nashville-food-project-nourish-2026/article_054256c4-e9f7-40ac-a498-54325cad89bb.html) |
| 07.31.2023 | **Folds of Honor Celebrity Golf Tournament** | Folds of Honor Tennessee | The Governors Club, Brentwood | golf | low | $872,818 (all events) | [link](https://countrynow.com/golfing-for-good-kane-brown-raelynn-jordan-davis-more-support-folds-of-honor-at-3rd-annual-celebrity-golf-tournament/) |
| TBD | **An Evening with Friends** | Williamson County Animal Center | The Barn at Sycamore Farms, Arrington | gala | medium | $96,717 | [link](https://www.williamsonherald.com/features/w_life/williamson-county-animal-center-holds-annual-fundraiser-for-good-paws/article_8ba42ffe-4b47-11ef-81de-9f7e8f5e6fa2.html) |

### August · Summer (8)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 08.01.2026 | **l'Eté du Vin Dinner & Auction** | Nashville Wine Auction (13 cancer nonprofits) | JW Marriott Nashville | auction | high |  | [link](https://nashvilleguru.com/35604/lete-du-vin) |
| 08.05.2027 | **Outside The Box** | Girl Scouts of Middle Tennessee | Tennessee State Museum | other | medium | $239,647 (all events) | [link](https://www.gsmidtn.org/en/support-us/signature-events.html) |
| 08.15.2026 | **Sporting Clays Fun Shoot** | Middle Tennessee Council, Scouting America | Nashville Gun Club | other | high | $313,109 (all events) | [link](https://www.mtcscouting.org/claysfunshoot) |
| 08.18.2025 | **Annual Campaign Celebration** | Jewish Federation of Greater Nashville | Gordon JCC | other | low |  | [link](https://www.jewishnashville.org/campaigncelebration) |
| 08.27.2026 | **Public Schools Hall of Fame Luncheon** | Nashville Public Education Foundation | Music City Center | luncheon | high | $427,652 | [link](https://nashvillepef.org/hall-of-fame/) |
| 08.29.2026 | **Notes for Nurses Gala** | Cumberland University | Tucker's Gap Event Center | gala | high | $395,405 (all events) | [link](https://www.cumberland.edu/cumberland-universitys-sold-out-notes-for-nurses-gala-returns-august-29-to-support-next-gen-healthcare-heroes/) |
| 08.31.2026 | **SCA Golf Classic** | St. Cecilia Academy | Old Natchez Country Club | golf | high |  | [link](https://www.stcecilia.edu/giving) |
| TBD | **Broadway Brunch** | Nashville Repertory Theatre | Category 10 (10th edition) | luncheon | medium | $424,064 | [link](https://nashvillerep.org/broadway-brunch) |

### September · Fall (25)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 09.03.2026 | **Champions Luncheon** | Martha O'Bryan Center | unverified | luncheon | medium |  | [link](https://www.marthaobryan.org/events) |
| 09.08.2025 | **Gilda's Club Golf Classic** | Gilda's Club Middle Tennessee | The Golf Club of Tennessee, Kingston Springs | golf | high | $144,458 | [link](https://www.visitmusiccity.com/media/press-release/2025/gildas-club-middle-tennessee-will-host-19th-annual-golf-tournament) |
| 09.10.2026 | **Hall of Fame Gala** | Tennessee Justice Center | Music City Center | gala | medium |  | [link](https://www.tnjustice.org/event-details/2026-hall-of-fame-gala-1) |
| 09.12.2026 | **American Brain Foundation Gala** | American Brain Foundation | Four Seasons Hotel Nashville | gala | high |  | [link](https://www.americanbrainfoundation.org/gala2026/) |
| 09.12.2026 | **Heritage Ball** | Heritage Foundation of Williamson County | Harlinsdale Farm, Franklin | ball | high | $711,052 | [link](https://williamsonheritage.org/event/53rd-heritage-ball/) |
| 09.14.2026 | **Brent Peterson Golf Classic** | Nashville Predators Foundation / Peterson Foundation | GreyStone Golf Club, Dickson | golf | medium | $1,614,849 (all events) | [link](https://www.nhl.com/predators/community/foundation/annual-events) |
| 09.18.2026 | **Spaghetti Supper** | Montgomery Bell Academy Mothers Club | Burkholder Wellness Center, MBA | other | high |  | [link](https://www.montgomerybell.edu/special-events-mothers-club) |
| 09.18.2026 | **Sunset Safari** | Nashville Zoo | Nashville Zoo at Grassmere | gala | high | $4,012,984 (all events) | [link](https://www.nashvillezoo.org/sunset-safari) |
| 09.19.2026 | **River Swing** | Harpeth Conservancy | River Circle Farm, Franklin | concert | high | $766,624 | [link](https://harpethconservancy.org/river-swing-2026/) |
| 09.20.2024 | **Chic Awearness** | Vanderbilt-Ingram Cancer Center (ovarian cancer) | W Nashville | show | medium |  | [link](https://momentum.vicc.org/2024/08/chic-awearness) |
| 09.21.2026 | **Fall Golf Classic** | Middle Tennessee Council, Scouting America | The Governors Club, Brentwood | golf | high | $99,290 | [link](https://www.mtcscouting.org/golf) |
| 09.21.2026 | **Houses of Hope Luncheon** | Habitat for Humanity of Greater Nashville | Music City Center | luncheon | medium | $403,412 (all events) | [link](https://habitatnashville.org/sponsor-an-event/) |
| 09.22.2026 | **Breakfast Celebration** | Book'em | unverified | other | medium |  | [link](https://bookem-kids.org/events-directory/) |
| 09.24.2025 | **Beyond Bourbon** | OZ Arts Nashville | OZ Arts Nashville | other | medium | $239,094 | [link](https://www.musiccityreview.com/2025/09/01/ozs-annual-beyond-bourbon-is-coming-up/) |
| 09.24.2026 | **Only in Nashville** | Oasis Center | Marathon Music Works | other | high | $170,995 | [link](https://oasiscenter.org/only-in-nashville) |
| 09.25.2026 | **Girl Scout Luncheon: Amplify Her Voice** | Girl Scouts of Middle Tennessee | City Winery Nashville | luncheon | high | $151,492 | [link](https://www.gsmidtn.org/en/support-us/signature-events.html) |
| 09.26.2026 | **Mad Hatter Gala** | Sexual Assault Center | Conrad Nashville | gala | high | $375,201 | [link](https://sexual-assault-center.networkforgood.com/events/93080-mad-hatter-2026) |
| 09.26.2026 | **Titans Foundation 5K** | Titans Foundation | Nissan Stadium | race | high |  | [link](https://www.tennesseetitans.com/5k/) |
| 09.28.2026 | **CPA Golf Classic** | Christ Presbyterian Academy | Old Natchez Country Club | golf | high |  | [link](https://www.cpalions.org/giving/annual-golf-tennis-classics) |
| 09.30.2026 | **Cause for Paws** | Nashville Humane Association | unverified (2025: Belle Meade Country Club) | luncheon | high | $472,120 (all events) | [link](https://nashvillehumane.org/events/cause-for-paws/) |
| TBD | **Barry Coggins FiftyForward Fresh Golf Tournament** | FiftyForward | Nashboro Golf Club | golf | medium |  | [link](https://www.fiftyforward.org/events) |
| TBD | **Hermitage Gala** | Andrew Jackson Foundation (The Hermitage) | The Hermitage | gala | low |  | [link](https://thehermitage.com/news) |
| TBD | **Nashville AIDS Walk & 5K Run** | Nashville CARES | unverified | race | medium | $114,820 | [link](https://www.nashvillecares.org/events) |
| TBD | **Petey's Preds Party** | Nashville Predators Foundation | Bridgestone Arena | auction | medium | $281,827 | [link](https://www.nhl.com/predators/news/preds-foundation-to-kick-off-annual-weekend-of-giving-on-sept-10-2026-0-08) |
| TBD | **Relay For Life** | Father Ryan High School | Giacosa Stadium, Father Ryan | other | medium |  | [link](https://www.fatherryan.org/faith-service/relay-for-life) |

### October · Fall (24)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 10.03.2026 | **More Than Pink Walk** | Susan G. Komen | Nashville Yards | race | high |  | [link](https://www.newschannel5.com/plus/morningline/2026-komen-nashville-more-than-pink-walk) |
| 10.05.2026 | **Champions Golf Classic** | Williamson Health Foundation | Nashville Golf & Athletic Club | golf | high |  | [link](https://www.williamsonhealth.org/foundation) |
| 10.05.2027 | **Wirtgen America Charity Golf Classic** | W.O. Smith Music School | unverified | golf | high | $275,561 | [link](https://www.wosmith.org/fundraising-events) |
| 10.06.2025 | **Induction & Awards Gala** | Nashville Songwriters Hall of Fame | Music City Center | gala | medium |  | [link](https://www.941wnnf.com/?p=1173739) |
| 10.07.2026 | **Music Teachers of Excellence** | CMA Foundation | The Pinnacle | gala | medium |  | [link](https://cmafoundation.org/music-teachers-of-excellence-event-details/) |
| 10.10.2026 | **Saturday in the Park** | Friends of Warner Parks | Warner Park Nature Center | other | high | $1,524,350 (all events) | [link](https://warnerparks.org/event/saturday-in-the-park-2/) |
| 10.11.2022 | **Forgiveness Luncheon** | Dismas House of Nashville | Renaissance Nashville Hotel | luncheon | medium | $248,738 | [link](https://www.pr.com/press-release/865364) |
| 10.12.2026 | **Golf Ball Tournament** | Ronald McDonald House Charities of Nashville | unverified | golf | high | $395,693 (all events) | [link](https://rmhcnashville.com/events/) |
| 10.17.2026 | **Dog Day** | Nashville Humane Association | Centennial Park | other | low | $126,075 | [link](https://www.nashvillehumane.org/events) |
| 10.21.2026 | **Academy for Women of Achievement** | YWCA Nashville & Middle Tennessee | Renaissance Nashville Hotel | luncheon | high | $283,169 | [link](https://www.ywcanashville.com/) |
| 10.22.2026 | **Artclectic** | University School of Nashville | Sperling Gym, USN | show | high | $432,598 | [link](https://www.artclectic.org/) |
| 10.22.2026 | **Constellation Golf Tournament** | Operation Stand Down Tennessee | Pine Creek Golf Club, Mt. Juliet | golf | high | $464,833 (all events) | [link](https://www.osdtn.org/constellationgolf) |
| 10.23.2026 | **Music City Sporting Clays Tournament** | Ronald McDonald House Charities of Nashville | Nashville Gun Club | other | low | $110,705 | [link](https://rmhcnashville.com/events/) |
| 10.24.2025 | **Hard Bargain Association Dinner** | Hard Bargain Association (Franklin) | Embassy Suites Cool Springs, Franklin | other | high | $79,357 | [link](https://www.southernexposuremagazine.com/current_issue/the-events---october-november/article_2747538c-f54d-4409-b6ae-ac74391fc134.html) |
| 10.24.2026 | **Nashville Praise Symphony Benefit Concert** | Nashville Rescue Mission | Linda & Mike Curb Men's Center | concert | high |  | [link](https://nashvillerescuemission.org/upcoming-events/) |
| 10.24.2026 | **Once in a Blue Moon** | The Land Trust for Tennessee | Glen Leven Farm | gala | high | $593,997 | [link](https://www.landtrusttn.org/bluemoon) |
| 10.24.2026 | **Red Door Bash** | Gilda's Club Middle Tennessee | Omni Nashville Hotel | gala | high | $310,326 | [link](https://gildasclubmiddletn.org/special-events/red-door-bash) |
| 10.27.2026 | **Salute to Excellence Awards** | Center for Nonprofit Excellence | Music City Center | luncheon | high |  | [link](https://www.cnemt.org/2026-salute-to-excellence-new/) |
| 10.28.2026 | **Predators Alumni Clay Shoot** | Nashville Predators Foundation | Nashville Gun Club | other | medium | $1,614,849 (all events) | [link](https://www.nhl.com/predators/community/foundation/annual-events) |
| 10.29.2026 | **JA Nashville Business Hall of Fame** | Junior Achievement of Middle Tennessee | Music City Center | gala | high | $663,970 (all events) | [link](https://nashville.ja.org/events) |
| TBD | **A Tennessee Waltz** | Tennessee State Museum | Tennessee State Capitol | ball | medium | $417,978 | [link](https://www.nfocusmagazine.com/events/tennessee-waltz-2025-celebrates-state-museum/collection_142a9aee-9b72-47f3-8c63-61c285feefeb.html) |
| TBD | **Harding Academy Golf Classic** | Harding Academy Alumni Association | Old Natchez Country Club | golf | medium | $1,906,052 (all events) | [link](https://www.hardingacademy.org/alumni/harding-academy-golf-classic) |
| TBD | **Saints Cup** | St. Paul Christian Academy | unverified | golf | medium |  | [link](https://www.stpaulchristianacademy.org/support/saints-cup) |
| TBD | **TSU Scholarship Gala** | Tennessee State University | Music City Center (2018) | gala | medium |  | [link](https://tnstatenewsroom.com/tsu-scholarship-gala/) |

### November · Fall (16)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 11.01.2025 | **Discovery Ball** | American Cancer Society | Four Seasons Hotel Nashville | gala | high |  | [link](https://www.wsmv.com/2025/09/25/american-cancer-society-discovery-ball-returns-nashville-its-5th-year) |
| 11.01.2026 | **Sunday in the Park** | Friends of Warner Parks | Ridge Field, Edwin Warner Park | luncheon | high | $863,675 | [link](https://warnerparks.org/event/sunday-in-the-park/) |
| 11.05.2026 | **MBA Art Show** | Montgomery Bell Academy Mothers Club | unverified | show | medium |  | [link](https://www.montgomerybell.edu/special-events-mothers-club) |
| 11.05.2026 | **Nashville Heroes Breakfast** | Operation Stand Down Tennessee | Music City Center | other | high | $464,833 (all events) | [link](https://www.osdtn.org/events) |
| 11.07.2026 | **Literary Award Gala** | Nashville Public Library Foundation | Main Library, Grand Reading Room | gala | high | $1,051,525 | [link](https://nplf.org/wp-content/uploads/2026/06/2026-Literary-Award-Weekend-Sponsor-Packet.pdf) |
| 11.07.2026 | **Wine Down Main Street** | Boys & Girls Clubs of Middle Tennessee | Historic Main Street, Franklin | other | high | $117,527 | [link](https://bgcmt.org/WDMS) |
| 11.11.2026 | **Extravaganza Auction** | Middle Tennessee Council, Scouting America | City Winery Nashville | auction | high | $313,109 (all events) | [link](https://www.mtcscouting.org/extravaganza) |
| 11.12.2026 | **Big Breakfast** | Big Brothers Big Sisters of Middle Tennessee | unverified (17th: Music City Center) | other | high | $996,303 | [link](https://mentorakid.org/events/) |
| 11.13.2025 | **Harvest Homecoming** | Mercy Community Healthcare | Williamson County Enrichment Center | other | low |  | [link](https://www.southernexposuremagazine.com/current_issue/the-events---october-november/article_2747538c-f54d-4409-b6ae-ac74391fc134.html) |
| 11.16.2023 | **Nashville Bourbon Auction** | Rotating beneficiaries | Electric Jane | auction | medium |  | [link](https://www.nfocusmagazine.com/events/nashville-bourbon-auction-five-years-fundraiser/collection_11ced839-2972-4535-88e5-10ba2f56f2f7.html) |
| 11.17.2026 | **Light the Way Luncheon** | Thistle Farms | Hilton Nashville Green Hills | luncheon | medium |  | [link](https://thistlefarms.org/pages/light-the-way-luncheon) |
| 11.18.2026 | **Songwriters Night** | Ronald McDonald House Charities of Nashville | 3rd & Lindsley | concert | low | $395,693 (all events) | [link](https://rmhcnashville.com/events/) |
| 11.24.2026 | **Mission:Possible Turkey Fry + Tracy Lawrence Benefit Concert** | Nashville Rescue Mission | The Fairgrounds Nashville / Category 10 | concert | high |  | [link](https://nashvillerescuemission.org/upcoming-events/) |
| TBD | **Fall for NAHT** | Nashville Anti-Human Trafficking Coalition | Five Stones Farm, Franklin (2025) | gala | medium | $670,597 (all events) | [link](https://www.nfocusmagazine.com/events/fall-for-naht-2025-supports-trafficking-survivors/collection_e442631e-4a46-4de9-90ce-7e214dfe390b.html) |
| TBD | **Somm Showdown** | Nashville Wine Auction | GEODIS Park | other | medium |  | [link](https://nashvillewineauction.com/) |
| TBD | **awaken: Wonder** | Adventure Science Center | Adventure Science Center | gala | low | $176,003 (all events) | [link](https://nashvillelifestyles.com/people/community-pics/adventure-science-center/) |

### December · Winter (6)

| Date found | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| 12.01.2026 | **Preds & Pins Bowling Tournament** | Nashville Predators Foundation | unverified | other | medium | $1,614,849 (all events) | [link](https://www.nhl.com/predators/community/foundation/annual-events) |
| 12.03.2026 | **Creative Nation Benefit Concert** | Preston Taylor Ministries | City Winery Nashville | concert | high | $178,043 | [link](https://www.prestontaylorministries.org/songwriters-night) |
| 12.05.2025 | **Annual Christmas Dinner** | Oaklands Mansion (Murfreesboro) | Oaklands Mansion | other | high | $24,525 | [link](https://www.oaklandsmansion.org/christmas-dinner/) |
| 12.09.2025 | **Nashville Unlimited Christmas Concert** | Room In The Inn | Christ Church Cathedral | concert | high |  | [link](https://roomintheinn.org/stories/nashvilleunlimited) |
| 12.12.2026 | **Symphony Ball** | Nashville Symphony | Schermerhorn Symphony Center | ball | high | $907,850 | [link](https://nashvillesymphony.org/contribute/galas-events/symphony-ball/) |
| TBD | **Nutcracker Tea** | Nashville Ballet | Belmont University Fisher Center (2025) | other | medium | $204,604 | [link](https://www.nfocusmagazine.com/events/best-parties-in-nashville-2025-charity-events-galas/article_9f96921a-1ef9-4c09-a853-51ebccd959a1.html) |

### Month not confirmed (24)

| Timing | Event | Organization | Venue | Format | Conf. | 990 gross | Source |
|---|---|---|---|---|---|---|---|
| Fall | **Bootlegger's Bash** | Battle of Franklin Trust (Carnton / Carter House) | Carnton, Franklin | other | low |  | [link](https://www.williamsonherald.com/features/entertainment/10th-bootlegger-s-bash-treats-crowd-to-tastings-dueling-pianos/article_90447af0-208e-11ec-ab38-97c53202dcf6.html) |
| unverified | **Bright Soles Bash** | Jonathan's Path | unverified | other | low |  | [link](https://www.nfocusmagazine.com/events/best-parties-in-nashville-2025-charity-events-galas/article_9f96921a-1ef9-4c09-a853-51ebccd959a1.html) |
| unverified | **Centennial Circle Dinner** | Centennial Park Conservancy | The Parthenon | other | low |  | [link](https://www.nfocusmagazine.com/people-places/centennial-park-conservancy-centennial-circle-philanthropy-nashville/article_88e5c7d5-bc20-4e95-aa13-104987bfb002.html) |
| unverified | **Cheekwood Society Dinner** | Cheekwood Estate & Gardens | Swan Lawn, Cheekwood | other | medium | $305,329 (all events) | [link](https://www.nfocusmagazine.com/events/cheekwood-society-dinner-2026/collection_4940bfb4-c684-480b-827f-110d9a68dd5c.html) |
| unverified | **Dancing for Safe Haven** | Safe Haven Family Shelter | unverified | show | low | $919,315 | [link](https://www.nfocusmagazine.com/n_good_company/n-good-company-episode-5-october-6-2025/video_d1aecce9-1edd-4658-b754-d6614621adde.html) |
| unverified | **Denim & Diamonds** | Battle Ground Academy Parent Association | unverified | auction | medium | $448,745 | [link](https://www.battlegroundacademy.org/bga-community/bga-parents/parent-association) |
| Fall | **Dinner by the Bridge** | Greenways for Nashville | Musicians Hall of Fame (2024) | other | medium | $365,727 | [link](https://www.nfocusmagazine.com/events/dinner-by-the-bridge-celebrates-30-years-of-greenways-for-nashville/collection_b26b14ca-92e3-11ef-a5f2-933b56df1e3f.html) |
| unverified | **Dreamscape Gala** | Nashville CARES | Country Music Hall of Fame and Museum | gala | medium | $263,110 (all events) | [link](https://www.nashvillecares.org/events) |
| Spring | **Friends of Warner Parks Spring Luncheon** | Friends of Warner Parks | Warner Park Nature Center (tent) | luncheon | medium | $1,524,350 (all events) | [link](https://www.nfocusmagazine.com/events/friends-of-warner-parks-spring-luncheon-2026/collection_86626db7-dce5-4b21-b48f-b628263bd779.html) |
| unverified | **Glitz & Glamour Gala** | Tennessee Kidney Foundation | Omni Hotel Nashville | gala | low | $605,213 (all events) | [link](https://www.nfocusmagazine.com/events/tennessee-kidney-foundation-gala-2026/collection_ad3fb050-7811-4d29-9a0a-2d1c9a4b14d1.html) |
| Fall | **Goodwill Impact Luncheon** | Goodwill Industries of Middle Tennessee | unverified | luncheon | low |  | [link](https://www.nfocusmagazine.com/n_good_company/n-good-company-episode-5-october-6-2025/video_d1aecce9-1edd-4658-b754-d6614621adde.html) |
| unverified | **Jack C. Massey Leadership Award** | Mental Health America of the MidSouth | unverified | other | low | $243,609 | [link](https://www.mhamidsouth.org/events) |
| unverified | **Legacy Gala** | Father Ryan High School | unverified | gala | medium |  | [link](https://www.fatherryan.org/give/gala/legacy-gala-sponsors) |
| Fall | **Lights on the Lawn** | Mary Parrish Center | unverified | concert | low | $91,630 (all events) | [link](https://www.gofundme.com/f/lotl15) |
| unverified | **Nashville Opera Jukebox Live** | Nashville Opera | Noah Liff Opera Center | concert | medium | $367,156 (all events) | [link](https://www.nfocusmagazine.com/events/nashville-opera-s-jukebox-live-supports-community-outreach/collection_7a8ff814-9fb1-4c43-a2b4-5f298039227f.html) |
| unverified | **Nashvillian of the Year** | Easterseals Tennessee | Hilton Nashville Downtown, Volunteer Ballroom | other | medium |  | [link](https://tn.easterseals.com/take-action/attend-an-event/nashvillian-of-year) |
| Spring | **Power of the Purse** | The Women's Fund | OZ Arts Nashville (2025) | auction | medium |  | [link](https://www.nfocusmagazine.com/events/the-everlasting-power-of-the-purse/article_a6d23c86-0dd8-4c1f-8296-6e94c2397f95.html) |
| unverified | **Recovery Luncheon** | The Next Door | unverified | luncheon | low |  | [link](https://www.nfocusmagazine.com/events/best-parties-in-nashville-2025-charity-events-galas/article_9f96921a-1ef9-4c09-a853-51ebccd959a1.html) |
| Fall | **Red Cross Tiffany Circle Fall Luncheon** | American Red Cross, Tennessee Region | Belle Meade Country Club (2024) | luncheon | medium |  | [link](https://www.williamsonscene.com/social/red-cross-tiffany-circle-fall-luncheon/collection_d187aad0-7b78-11ef-988f-f3839f33b82a.html) |
| Spring | **Saints Bash** | St. Paul Christian Academy Parent Council | unverified | gala | medium |  | [link](https://www.stpaulchristianacademy.org/support/saints-bash) |
| unverified | **Smitty Corporate Band Challenge** | W.O. Smith Music School | Chief's on Broadway (finale) | concert | medium | $65,846 | [link](https://www.wosmith.org/fundraising-events) |
| unverified | **Sparkling Settings** | Horticultural Society of Middle Tennessee | unverified | show | low |  | [link](https://www.nfocusmagazine.com/events/best-parties-in-nashville-2025-charity-events-galas/article_9f96921a-1ef9-4c09-a853-51ebccd959a1.html) |
| unverified | **The Rose Gala** | St. Cecilia Academy | unverified | gala | medium |  | [link](https://www.stcecilia.edu/giving) |
| unverified | **Visionaries of the Year Grand Finale** | Leukemia & Lymphoma Society (Blood Cancer United) | unverified | gala | low |  | [link](https://visionaries.bloodcancerunited.org/node/804071) |

## 990 event filers not on the calendar yet

220 organizations report $75K+ in event gross receipts on their latest Schedule G but don't have a dated event on the calendar. Sorted by size. Event names are as filed; the IRS form often truncates them. ⚑ means some of the org's events are held outside the metro.

| Organization | City | TY | Events named on Schedule G | All-event gross | Largest event | Venue spend | F&B spend |
|---|---|---|---|---|---|---|---|
| [The Brett Boyer Foundation Inc](https://projects.propublica.org/nonprofits/organizations/823179454) | Nashville | 2024 | REDBIRD GAMES · GOLF TOURNAMENT | $4,646,433 | $3,950,271 | $318,636 | $11,222 |
| [Union Sportsmens Alliance](https://projects.propublica.org/nonprofits/organizations/272345009) | Spring Hill | 2024 | GALA · CLAY SHOOT # 1 + 65 other | $3,733,757 | $185,091 | $332,479 | $419,342 |
| [Men Of Valor](https://projects.propublica.org/nonprofits/organizations/621836815) ⚑ | Antioch | 2025 | NASHVILLE BREAKFAST · KNOXVILLE BREAKFAST + 2 other | $2,453,663 | $1,627,326 | $120,760 | $154,899 |
| [Acm Lifting Lives](https://projects.propublica.org/nonprofits/organizations/841638671) | Nashville | 2024 | GOLF EVENT · KICKOFF FOR A C + 2 other | $2,148,985 | $1,172,286 | $254,011 | $51,976 |
| [The Community Fdn Of Middle Tn Inc](https://projects.propublica.org/nonprofits/organizations/621471789) | Nashville | 2024 | DELEK TOURNAMENT OF HOPE · CFRC RODEO + 14 other | $1,957,435 | $1,190,311 | $124,819 | $330,638 |
| [Scott Hamilton Cares Foundation Inc](https://projects.propublica.org/nonprofits/organizations/472328142) | Franklin | 2024 | AN EVENING WITH SCOTT · SK8 TO ELIMIN8 CANCER | $1,757,657 | $1,214,508 |  |  |
| [Mission Lazarus](https://projects.propublica.org/nonprofits/organizations/753151070) | Nashville | 2025 | SONGS ON A MISSION | $1,332,861 | $1,332,861 |  |  |
| [Shikar-safari Club International](https://projects.propublica.org/nonprofits/organizations/756040774) | Spring Hill | 2024 | Auction | $1,261,870 | $1,261,870 |  |  |
| [Love Is A Gift Incorporated](https://projects.propublica.org/nonprofits/organizations/824284018) | Nashville | 2024 | THE HOMESTEAD F | $1,197,366 | $1,197,366 | $71,267 | $5,219 |
| [Daystar Counseling Ministries Inc](https://projects.propublica.org/nonprofits/organizations/621244203) | Nashville | 2024 | EVENING IN DECEMBER · OCTOBER THING | $1,116,604 | $1,017,791 | $54,000 |  |
| [Brightstone Inc](https://projects.propublica.org/nonprofits/organizations/621783260) | Franklin | 2025 | BENEFITS · CRAFT FAIRS | $1,074,652 | $1,018,452 | $35,361 | $39,463 |
| [Franklin Road Academy Inc](https://projects.propublica.org/nonprofits/organizations/621138075) | Nashville | 2024 | STARS & GUITARS | $936,883 | $936,883 | $28,223 | $197,908 |
| [Graceworks Ministries Inc](https://projects.propublica.org/nonprofits/organizations/621584204) | Franklin | 2024 | DINNER · GOLF + 1 other | $933,181 | $446,183 |  |  |
| [Charlie Daniels Journey Home Project](https://projects.propublica.org/nonprofits/organizations/471616161) | Mount Juliet | 2025 | CITY WINERY | $802,781 | $802,781 | $47,220 |  |
| [Tennessee Golf Foundation](https://projects.propublica.org/nonprofits/organizations/581893478) | Franklin | 2024 | HONORS PRO-AM · PGA HOPE FUNDRA + 15 other | $789,457 | $157,250 | $118,242 | $159,191 |
| [Boys & Girls Club Of Rutherford Co Inc](https://projects.propublica.org/nonprofits/organizations/621583332) | Murfreesboro | 2024 | STEAK & BURGER · STEAK & CHICKEN + 1 other | $769,982 | $623,418 | $596 | $29,970 |
| [Engage Your Destiny](https://projects.propublica.org/nonprofits/organizations/812707761) ⚑ | Franklin | 2024 | WARRIOR BREAKFAST MINNESOTA · WARRIOR BASH MINNESOTA | $753,825 | $445,330 | $1,000 | $14,379 |
| [Musicians On Call Inc](https://projects.propublica.org/nonprofits/organizations/134067116) ⚑ | Nashville | 2024 | NASHVILLE EVENT · NYC EVENT | $750,088 | $393,188 | $42,108 | $99,299 |
| [Operation Andrew Group Inc](https://projects.propublica.org/nonprofits/organizations/621799192) | Nashville | 2025 | ANNUAL BENEFIT · GOLF + 2 other | $729,246 | $590,725 | $127,161 |  |
| [Parent Teacher Organization Of Ravenwood High School Inc](https://projects.propublica.org/nonprofits/organizations/30402149) | Brentwood | 2024 | TEAMS · INVEST IN YOUR RAPTOR + 22 other | $720,577 | $103,446 |  |  |
| [Hospital Hospitality House](https://projects.propublica.org/nonprofits/organizations/620909363) | Nashville | 2024 | PATRON'S LUNCH · 50TH ANNIVERSARY EVENT + 2 other | $717,027 | $350,668 |  |  |
| [Hca Hope Fund](https://projects.propublica.org/nonprofits/organizations/470957872) | Nashville | 2025 | GOLF TOURNAMENT · CLAY TARGET | $712,000 | $661,000 | $128,318 | $22,478 |
| [Homes 4 Homes](https://projects.propublica.org/nonprofits/organizations/473696537) | Brentwood | 2025 | Dinner | $707,374 | $707,374 | $84,701 |  |
| [Friends Of Franklin Parks Inc](https://projects.propublica.org/nonprofits/organizations/810993195) | Franklin | 2024 | RAISE THE RO · JULY 4 + 1 other | $692,053 | $565,972 |  | $21,699 |
| [Frank Town Open Hearts Ministry Inc](https://projects.propublica.org/nonprofits/organizations/202862970) | Franklin | 2024 | FESTIVAL OF LIGHT · ANNUAL DINNER + 1 other | $691,835 | $479,779 | $35,900 | $19,547 |
| [Our Kids Inc](https://projects.propublica.org/nonprofits/organizations/581830327) | Nashville | 2024 | HAMMER DOW · SOUP SUNDAY + 2 other | $649,804 | $237,457 |  |  |
| [One Generation Away](https://projects.propublica.org/nonprofits/organizations/462741214) | Franklin | 2024 | SPRING BREAKFAST · GOLF + 1 other | $628,422 | $471,692 |  |  |
| [Justice And Mercy International Inc](https://projects.propublica.org/nonprofits/organizations/364630658) | Nashville | 2024 | JMI BENEFIT GALA · SKEET SHOOT + 2 other | $607,353 | $501,700 |  | $34,233 |
| [Nashvillehealth](https://projects.propublica.org/nonprofits/organizations/813063375) | Nashville | 2024 | AUCTION | $606,476 | $606,476 |  |  |
| [Mercy Multiplied America Inc](https://projects.propublica.org/nonprofits/organizations/720973419) | Nashville | 2024 | MONROE NIGHT OF · WALK FOR FREEDO + 2 other | $602,984 | $65,975 | $34,491 | $4,044 |
| [Association For Guidance Aid Placement & Empathy](https://projects.propublica.org/nonprofits/organizations/620760716) | Nashville | 2024 | KIDS CLASSIC GO · ANNUAL DINNER + 2 other | $601,595 | $317,698 | $31,293 | $20,026 |
| [Freedoms Promise Inc](https://projects.propublica.org/nonprofits/organizations/260566457) | Nashville | 2025 | FREEDOM IN THE · DALTON EVENT + 3 other | $592,963 | $313,281 | $18,355 | $23,803 |
| [Nikki Mitchell Foundation Inc](https://projects.propublica.org/nonprofits/organizations/463399632) | Nashville | 2025 | Homecoming | $588,298 | $588,298 | $75,569 | $67,836 |
| [Asurion Compassion Fund](https://projects.propublica.org/nonprofits/organizations/263707117) | Nashville | 2025 | GOLF TOURNAMENT · SILENT AUCTION | $580,977 | $572,327 | $34,838 | $22,954 |
| [Porters Call](https://projects.propublica.org/nonprofits/organizations/10690242) | Franklin | 2025 | EVENING OF STORIES | $571,226 | $571,226 | $24,910 | $24,827 |
| [Refuge Center For Counseling Inc](https://projects.propublica.org/nonprofits/organizations/203931843) | Franklin | 2024 | HOPE GROWS · GOLF TOURNAMENT | $565,428 | $461,140 | $27,138 | $42,356 |
| [Mylifespeaks](https://projects.propublica.org/nonprofits/organizations/452446194) ⚑ | Nashville | 2025 | Dinner-Houston, TX · Dinner-TN | $556,459 | $446,652 | $34,481 | $8,478 |
| [New Hope Academy](https://projects.propublica.org/nonprofits/organizations/631172489) | Franklin | 2024 | GALA · GLOW FOR HOPE + 1 other | $553,709 | $431,953 | $56,385 | $25,035 |
| [Barefoot Republic Inc](https://projects.propublica.org/nonprofits/organizations/621841336) | Nashville | 2024 | FALL BANQUET · GOLF TOURNAMENT + 2 other | $543,131 | $378,938 | $17,548 | $10,426 |
| [Tennessee Technology Development Corporation](https://projects.propublica.org/nonprofits/organizations/621765738) | Nashville | 2024 | 3686 FESTIVAL · TENNESSEE HOUSE + 1 other | $535,229 | $290,229 |  |  |
| [Survivor Fitness Foundation](https://projects.propublica.org/nonprofits/organizations/461934408) ⚑ | Nashville | 2024 | Nashville Soiree · Knoxville Soire + 2 other | $528,974 | $166,047 | $49,897 | $3,754 |
| [Well Outreach](https://projects.propublica.org/nonprofits/organizations/320258525) | Spring Hill | 2024 | SHINE GALA/NIGH · HOPE FOR HUNGRY + 2 other | $511,614 | $177,810 | $46,250 | $24,209 |
| [Rocketown Of Middle Tennessee](https://projects.propublica.org/nonprofits/organizations/621571573) ⚑ | Nashville | 2024 | COMEDY 4A CAUSE · ASHLAND CITY | $508,029 | $394,065 |  |  |
| [Interfaith Dental Clinic Of Nashville](https://projects.propublica.org/nonprofits/organizations/621567615) | Nashville | 2024 | GALA · STORY BEHIND THE SMILE + 1 other | $504,299 | $226,604 | $55,285 | $52,275 |
| [Tennessee Innocence Project](https://projects.propublica.org/nonprofits/organizations/320582082) | Nashville | 2024 | GALA & AUCTION | $486,014 | $486,014 | $2,577 | $57,284 |
| [Nashville Inner City Ministry Inc](https://projects.propublica.org/nonprofits/organizations/621274899) | Nashville | 2024 | CATFISH DINNER · GOLF FUNDRAISER + 1 other | $482,422 | $310,155 | $5,719 | $51,964 |
| [Elis House](https://projects.propublica.org/nonprofits/organizations/873705590) | Brentwood | 2024 | BENEFIT DINNER · MICROEVENTS | $460,864 | $347,106 | $58,162 |  |
| [Charity Circle Of Murfreesboro](https://projects.propublica.org/nonprofits/organizations/237158367) | Murfreesboro | 2025 | CHARITY BALL · CAROLING PARTIES | $453,194 | $234,483 | $39,090 | $45,236 |
| [The Store Inc](https://projects.propublica.org/nonprofits/organizations/814247568) | Nashville | 2024 | ZANIES COMEDY · NASHVILLE'S GOT TALENT | $446,457 | $260,727 |  | $51,068 |
| [Julia Green School Parent Teacher Organization](https://projects.propublica.org/nonprofits/organizations/300278216) | Nashville | 2024 | INVEST IN YOUR · AUCTION/SPRING + 1 other | $446,234 | $281,321 |  |  |
| [Mercy Health Services Inc](https://projects.propublica.org/nonprofits/organizations/621781969) | Franklin | 2024 | FRANKLIN CLASSIC · PRAYER DINNER + 1 other | $439,173 | $153,372 |  |  |
| [Urban League Of Middle Tennessee](https://projects.propublica.org/nonprofits/organizations/620795167) | Nashville | 2024 | EOD LUNCH · GOLF TOURNAMENT + 2 other | $434,594 | $258,250 | $52,842 | $34,645 |
| [Sherrys Hope Inc](https://projects.propublica.org/nonprofits/organizations/61799885) | Lebanon | 2025 | 5K RUN/WALK · MARDI GRAS | $426,725 | $268,530 |  |  |
| [Rochelle Center](https://projects.propublica.org/nonprofits/organizations/620813080) | Nashville | 2024 | CHUKKERS | $423,402 | $423,402 |  |  |
| [Cumberland Heights Foundation Inc](https://projects.propublica.org/nonprofits/organizations/626050684) | Nashville | 2025 | WOMENS LUNCHEON · CONCERT + 2 other | $416,182 | $154,679 | $13,153 | $73,552 |
| [High Hopes Inc](https://projects.propublica.org/nonprofits/organizations/621210720) | Franklin | 2024 | HATS OFF · GOG + 3 other | $412,161 | $186,395 | $22,800 | $19,569 |
| [Special Olympics Tennessee Inc](https://projects.propublica.org/nonprofits/organizations/237348136) | Brentwood | 2024 | POLAR PLUNGE · WINE & DINE | $411,845 | $332,012 |  |  |
| [Nashville Childrens Alliance Inc](https://projects.propublica.org/nonprofits/organizations/621484097) | Nashville | 2024 | MNPD TALENT SHO · DINE TO SHINE | $380,347 | $202,500 |  |  |
| [4 13 Strong Inc](https://projects.propublica.org/nonprofits/organizations/471939832) | Nashville | 2025 | SPRING DINNER · GOLF TOURNAMENT + 2 other | $379,347 | $283,392 | $6,725 | $24,375 |
| [Williamson County Child Advocacy Center Task Force](https://projects.propublica.org/nonprofits/organizations/621772353) | Franklin | 2024 | BUTTON BALL · OTHER EVENTS | $377,786 | $301,043 |  |  |
| [Friends Life Community](https://projects.propublica.org/nonprofits/organizations/412242504) | Nashville | 2025 | Backyard BBQ&Bluegrass | $370,317 | $370,317 | $33,835 | $11,733 |
| [Country Music Foundation Inc](https://projects.propublica.org/nonprofits/organizations/620753887) ⚑ | Nashville | 2024 | ALL FOR THE HALL DALLAS | $363,869 | $363,869 | $31,837 |  |
| [Court Appointed Special Advocates](https://projects.propublica.org/nonprofits/organizations/621203459) | Nashville | 2024 | RED SHOE PARTY · LOVE & LEGACY L + 1 other | $362,748 | $319,202 | $108,265 | $4,680 |
| [Williamson Medical Foundation Inc](https://projects.propublica.org/nonprofits/organizations/43717044) | Franklin | 2024 | GOLF TOURNAMENT · SKELETON GALA + 3 other | $354,219 | $204,220 | $31,994 | $32,412 |
| [Civic Design Center](https://projects.propublica.org/nonprofits/organizations/311743508) | Nashville | 2024 | AN LUNCHEON | $350,619 | $350,619 |  |  |
| [Launch Pad Foundation](https://projects.propublica.org/nonprofits/organizations/834195654) | Nashville | 2024 | FESTIVAL | $350,362 | $350,362 |  |  |
| [Pet Community Center Inc](https://projects.propublica.org/nonprofits/organizations/451524886) | Nashville | 2025 | FURBALL | $344,073 | $344,073 | $7,614 | $19,256 |
| [Joe Beretta Foundation](https://projects.propublica.org/nonprofits/organizations/813849103) | Mount Juliet | 2024 | Gala · Pickleball + 1 other | $340,337 | $31,417 | $9,765 | $32,515 |
| [Franklin Tomorrow Inc](https://projects.propublica.org/nonprofits/organizations/621821869) | Franklin | 2024 | BREAKFAST WITH MAYORS · VISION CITY + 3 other | $339,822 | $84,000 |  |  |
| [Ladies Of Charity Of Nashville](https://projects.propublica.org/nonprofits/organizations/620481799) | Nashville | 2025 | THRIFT STORE · STUFF GALORE + 3 other | $332,468 | $266,319 |  |  |
| [The National Museum Of African American Music](https://projects.propublica.org/nonprofits/organizations/621867910) | Nashville | 2024 | BLACK MUSIC MONTH · MUSICAL GIFTS | $331,113 | $230,327 | $510 | $12,065 |
| [First Shot Foundation](https://projects.propublica.org/nonprofits/organizations/432088629) | Murfreesboro | 2024 | GOLF TOURNAMENT · SNEAKER BALL + 1 other | $322,615 | $155,178 | $16,469 | $10,770 |
| [Mission Possible](https://projects.propublica.org/nonprofits/organizations/371853525) | Nashville | 2024 | GOLF TOURNAMENT · TURKEY FRY | $321,861 | $248,219 | $20,304 | $22,446 |
| [Special Kids Inc](https://projects.propublica.org/nonprofits/organizations/621718638) | Murfreesboro | 2025 | RACE · FALL GOLF + 2 other | $320,272 | $151,473 | $12,617 | $1,916 |
| [Shalom Foundation](https://projects.propublica.org/nonprofits/organizations/954894733) | Franklin | 2024 | PROMOTIONAL CONCERT | $310,352 | $310,352 |  |  |
| [Providence Christian Academy Inc](https://projects.propublica.org/nonprofits/organizations/621664417) | Murfreesboro | 2024 | SOIREE - SPRING EVENT · PUMPKIN PATCH + 1 other | $306,419 | $189,988 |  |  |
| [West Nashville Dream Center](https://projects.propublica.org/nonprofits/organizations/814064177) | Nashville | 2024 | EOY CAMPAIGN · RISE AND DREAM + 5 other | $293,000 | $62,924 |  |  |
| [Saint Bernard Academy](https://projects.propublica.org/nonprofits/organizations/621395228) | Nashville | 2024 | HSA AUCTION · HSA FUNDRAISING | $292,616 | $265,632 |  |  |
| [Children Of Restaurant Employees](https://projects.propublica.org/nonprofits/organizations/201584617) | Brentwood | 2024 | AUCTIONS & EVEN | $287,770 | $287,770 |  |  |
| [Stars Nashville](https://projects.propublica.org/nonprofits/organizations/621285699) | Nashville | 2024 | FARM TO TABLE · GOLF TOURNAMENT + 1 other | $283,172 | $237,545 | $30,838 | $31,080 |
| [Renewal House Inc](https://projects.propublica.org/nonprofits/organizations/621631055) | Nashville | 2024 | A RENEWAL HOUSE THANKSGIVING | $278,395 | $278,395 |  | $33,761 |
| [Lipscomb University](https://projects.propublica.org/nonprofits/organizations/620485733) | Nashville | 2024 | DENIM & DIAMONDS · SOLLY SCHOOL ACADEMY + 3 other | $274,630 | $117,075 |  |  |
| [Feed America First Of Tennessee](https://projects.propublica.org/nonprofits/organizations/621821057) | Murfreesboro | 2024 | OTHER EVENTS · FORREST KING + 1 other | $270,865 | $115,570 |  | $666 |
| [Portico Inc](https://projects.propublica.org/nonprofits/organizations/621262109) | Murfreesboro | 2025 | BANQUET · IGNITE + 1 other | $269,199 | $241,604 | $10,300 | $17,887 |
| [Middle Tennessee Highland Games](https://projects.propublica.org/nonprofits/organizations/471505659) | Old Hickory | 2025 | Middle Tennessee Highland Games & Celtic Festival | $267,875 | $267,875 | $3,000 | $17,948 |
| [Harvest Hands Community Development Corporation](https://projects.propublica.org/nonprofits/organizations/260614081) | Nashville | 2024 | ADVOCATES BFAST · THE GIFT OF GIV + 1 other | $264,654 | $125,557 |  |  |
| [Tennessee Trucking Foundation Inc](https://projects.propublica.org/nonprofits/organizations/621504853) | Nashville | 2025 | AUCTION · BIG RIGS + 2 other | $259,545 | $175,334 |  |  |
| [Tenngreen Land Conservancy](https://projects.propublica.org/nonprofits/organizations/621557574) | Nashville | 2024 | HIKE-A-THON | $255,094 | $255,094 |  |  |
| [Percy Priest Parent Teacher Organization](https://projects.propublica.org/nonprofits/organizations/43588824) | Nashville | 2024 | SPRING EVENT · GOLF EVENT + 6 other | $248,222 | $145,490 |  |  |
| [Harpeth Hall School](https://projects.propublica.org/nonprofits/organizations/620501916) | Nashville | 2024 | MAIN EVENT · HANG UP SALE | $248,054 | $218,855 | $7,500 | $24,528 |
| [Jordan Thomas Foundation Inc](https://projects.propublica.org/nonprofits/organizations/203498598) | Brentwood | 2024 | GOLF EVENT · 5KADEN | $242,674 | $127,162 | $31,462 |  |
| [Vanderbilt University](https://projects.propublica.org/nonprofits/organizations/620476822) | Nashville | 2024 | Vandy Golf Day 2025 · Law School Public Interest Auction + 1 other | $239,632 | $137,150 | $58,213 | $6,652 |
| [A Soldiers Child Inc](https://projects.propublica.org/nonprofits/organizations/263032468) | Murfreesboro | 2024 | ANNUAL DINNER · GOLF TOURNAMENT | $239,054 | $156,526 |  |  |
| [Volunteer State College Foundation](https://projects.propublica.org/nonprofits/organizations/581863050) | Gallatin | 2024 | WOMEN EMPOWERIN · VOL STATE GIVIN + 2 other | $237,285 | $107,155 | $9,213 | $40,135 |
| [Monroe Harding Inc](https://projects.propublica.org/nonprofits/organizations/620476670) | Nashville | 2024 | FOSTERING JOY | $224,715 | $224,715 |  |  |
| [Christ Led Communities Inc](https://projects.propublica.org/nonprofits/organizations/621177279) | Brentwood | 2025 | GOLF TOURNAMENT · ANNUAL BREAKFAST | $223,570 | $161,428 |  |  |
| [New Beginings Center](https://projects.propublica.org/nonprofits/organizations/900751722) | Nashville | 2024 | SPIRIT OF WELLN · BOURBON & BUBBL | $221,506 | $150,115 | $7,321 | $18,455 |
| [Raising Resilience Tennessee](https://projects.propublica.org/nonprofits/organizations/621237360) | Nashville | 2024 | CHANGE THE TUNE · CRAFTING CHANGE | $220,266 | $155,884 |  |  |
| [W P Scales School Parents Club](https://projects.propublica.org/nonprofits/organizations/581781791) | Brentwood | 2025 | INVEST CAMPAIGN · INVEST AUCTION + 2 other | $219,423 | $74,001 |  |  |
| [Healing Housing Inc](https://projects.propublica.org/nonprofits/organizations/473758041) | Brentwood | 2024 | LOVE BREAKFAST | $217,390 | $217,390 |  | $17,195 |
| [Tennessee Breast Cancer Coalition Inc](https://projects.propublica.org/nonprofits/organizations/621637548) | Nashville | 2025 | GOLF NASH · WWM + 3 other | $216,938 | $120,970 | $20,586 | $15,772 |
| [Nashville Fire Fighters Association Foundation](https://projects.propublica.org/nonprofits/organizations/464764024) | Nashville | 2024 | MDA FILL THE BO · EMS GALA + 2 other | $214,609 | $125,724 | $11,819 | $3,303 |
| [Miles For Miles Foundation](https://projects.propublica.org/nonprofits/organizations/465452232) | Brentwood | 2025 | GREENS GROCERY MUSIC CONCERT · AUCTION | $206,700 | $130,600 |  |  |
| [Ancoratn](https://projects.propublica.org/nonprofits/organizations/454955577) | Joelton | 2025 | VOICES OF FREEDOM | $201,485 | $201,485 | $17,296 | $23,442 |
| [Currey Ingram Academy](https://projects.propublica.org/nonprofits/organizations/621296326) | Brentwood | 2024 | GOLF TOURNAMENT · BLUEGRSS & BBQ | $201,260 | $101,260 | $12,000 |  |
| [Tennessee Childrens Home Inc](https://projects.propublica.org/nonprofits/organizations/620482363) | Spring Hill | 2024 | GOLF TOURNAMENT · BENEFIT DINNER + 1 other | $200,317 | $84,820 | $51,380 | $9,368 |
| [Children Are People Inc](https://projects.propublica.org/nonprofits/organizations/621814354) | Gallatin | 2024 | FALL FUNDRAISER | $196,130 | $196,130 | $5,935 | $4,904 |
| [Senior Citizens Inc](https://projects.propublica.org/nonprofits/organizations/620566419) | Nashville | 2024 | OLDER AMERICANS · GOLF TOURNAMENT + 2 other | $194,064 | $115,056 | $3,800 | $12,866 |
| [Possibilities Inc](https://projects.propublica.org/nonprofits/organizations/460397395) | Nashville | 2023 | PEACOCK INVITIATIONAL | $190,123 | $190,123 | $10,980 | $11,107 |
| [Heal Ministries Inc](https://projects.propublica.org/nonprofits/organizations/262267496) | Nashville | 2025 | ANNUAL EVENT | $188,645 | $188,447 | $13,168 | $6,644 |
| [Page Middle School Parent Teacher Organization](https://projects.propublica.org/nonprofits/organizations/810566476) | Franklin | 2025 | Invest In the Best · Band Fundraiser + 3 other | $187,460 | $74,803 |  |  |
| [United Way Of South Central Tennessee](https://projects.propublica.org/nonprofits/organizations/581341880) | Murfreesboro | 2024 | UNITED IN SPIRITS · RED WHITE & BAYOU | $187,161 | $91,747 | $10,608 | $34,842 |
| [Habitat For Humanity International Inc (Franklin filer)](https://projects.propublica.org/nonprofits/organizations/621506788) | Franklin | 2024 | HAMMERS AND HIGH HEELS | $187,030 | $187,030 |  |  |
| [Metro Nashville Parks Foundation](https://projects.propublica.org/nonprofits/organizations/473639207) | Nashville | 2025 | PARK DINNER · HOT CHICKEN FESTIVAL | $185,980 | $95,864 | $46,735 | $9,045 |
| [Dolphin Aquatics](https://projects.propublica.org/nonprofits/organizations/271246431) | Nashville | 2024 | B&B · MUM SALE | $182,263 | $158,367 | $13,901 | $7,624 |
| [St Lukes Community House](https://projects.propublica.org/nonprofits/organizations/620484183) | Nashville | 2025 | SUNRISE BREAKFA | $179,637 | $179,637 | $6,401 | $11,950 |
| [Special Ops Xcursions Inc](https://projects.propublica.org/nonprofits/organizations/471595487) | Nashville | 2024 | AUCTION EVENT | $179,282 | $179,282 |  |  |
| [Tennessee Alliance For Kids Inc](https://projects.propublica.org/nonprofits/organizations/813081709) | Nashville | 2024 | Taste of TN · Jingle Mingle | $177,857 | $171,762 |  |  |
| [Faith Family Medical Center](https://projects.propublica.org/nonprofits/organizations/621816811) | Nashville | 2024 | NEIGHBORS NIGHT · GOLF TOURNAMENT | $177,136 | $128,560 | $19,081 | $22,004 |
| [Friends Of Radnor Lake](https://projects.propublica.org/nonprofits/organizations/237322143) | Nashville | 2023 | RADNOR IN THE ROUND · CHESTNUT ART SHOW | $176,873 | $98,097 |  | $3,036 |
| [Crockett Elementary School Pto](https://projects.propublica.org/nonprofits/organizations/621426085) | Brentwood | 2024 | Invest Event · Silent Auction + 1 other | $176,374 | $83,679 |  |  |
| [Branch Of Nashville Inc](https://projects.propublica.org/nonprofits/organizations/463153789) | Antioch | 2024 | SPRING · FALL + 1 other | $174,912 | $116,717 | $1,057 | $4,843 |
| [Pmc Cares Foundation](https://projects.propublica.org/nonprofits/organizations/921448728) | Nashville | 2023 | MUSIC CITY MASTERS GOLF TOURNAMENT | $173,504 | $173,504 |  |  |
| [Community Resource Center](https://projects.propublica.org/nonprofits/organizations/621308387) | Nashville | 2024 | DISHIN UP · ALL IN FOR HYGINE | $173,149 | $157,753 | $11,303 | $15,464 |
| [Rock The Ocean Foundation](https://projects.propublica.org/nonprofits/organizations/461317742) | Nashville | 2024 | AUCTION | $172,844 | $172,844 |  |  |
| [Creativets](https://projects.propublica.org/nonprofits/organizations/463617663) | Nashville | 2024 | GOLF TOURNAMENT | $172,094 | $172,094 |  |  |
| [Permobil Foundation](https://projects.propublica.org/nonprofits/organizations/813029754) | Lebanon | 2025 | ROLL THE DICE C · GOLF CHARITY OP | $171,736 | $96,858 |  |  |
| [Amputee Blade Runners](https://projects.propublica.org/nonprofits/organizations/453782439) | Nashville | 2024 | RJFS Elevate · ACCSEC Golf Tournament + 1 other | $169,614 | $121,534 |  |  |
| [Franklin S Charge Inc](https://projects.propublica.org/nonprofits/organizations/201774789) | Franklin | 2024 | PEARCE TRIBUTE | $167,600 | $167,600 |  |  |
| [Mj 4 Hope](https://projects.propublica.org/nonprofits/organizations/474607039) | Mount Juliet | 2024 | GOLF TOURNAMENTS · BASS FISHING TOURNAMENT + 2 other | $166,755 | $124,166 | $31,950 | $1,992 |
| [Childrens Museum Corporation Of Rutherford County](https://projects.propublica.org/nonprofits/organizations/621273308) | Murfreesboro | 2025 | SECRET GARDEN PARTY · WINE AT THE WETLANDS + 1 other | $161,964 | $137,719 | $10,205 | $12,765 |
| [Journey Home Inc](https://projects.propublica.org/nonprofits/organizations/205605975) | Murfreesboro | 2024 | GROOVIN IN THE BORO · JOURNEY24 | $157,151 | $110,828 | $3,374 | $6,979 |
| [Operation Song](https://projects.propublica.org/nonprofits/organizations/465442758) ⚑ | Nashville | 2025 | OPERATION SONG 4TH ANNUAL BENEFIT · GREEN BAY, WI + 36 other | $155,694 | $108,957 | $12,730 | $21,072 |
| [Smyrna Rotary Club Charitable Foundation](https://projects.propublica.org/nonprofits/organizations/450565739) | Smyrna | 2024 | Fish Fry | $155,303 | $155,303 | $31,605 | $3,610 |
| [Historic Downtown Gallatin Inc](https://projects.propublica.org/nonprofits/organizations/621183248) | Gallatin | 2025 | MAIN ST FESTIVA · SQUARE FEST + 2 other | $154,688 | $70,325 |  |  |
| [Woodland Middle School Parent Teacher Organization](https://projects.propublica.org/nonprofits/organizations/621533174) | Brentwood | 2024 | INVEST IN CHILD · CONCESSIONS - WAC + 8 other | $152,862 | $69,550 |  |  |
| [Pregnancy Care Center](https://projects.propublica.org/nonprofits/organizations/142004594) | Hermitage | 2024 | BANQUET · WALK FOR LIFE | $152,396 | $138,370 |  | $15,317 |
| [Nashville School Of Law](https://projects.propublica.org/nonprofits/organizations/620550981) | Nashville | 2024 | RECOGNITION DINNER | $151,000 | $151,000 | $94,106 |  |
| [Episcopal School Of Nashville](https://projects.propublica.org/nonprofits/organizations/471887747) | Nashville | 2024 | A NIGHT UNDE · PURPLE MARTI | $150,894 | $103,966 |  |  |
| [Nashville Christian Schools Inc](https://projects.propublica.org/nonprofits/organizations/237122306) | Nashville | 2023 | AUCTION | $150,286 | $150,286 | $795 | $7,534 |
| [Charley Foundation Inc](https://projects.propublica.org/nonprofits/organizations/770601841) | Nashville | 2024 | Celebrity Boxing Event + 1 other | $147,374 | $147,374 | $96,939 |  |
| [Missions Development International](https://projects.propublica.org/nonprofits/organizations/621731612) | Brentwood | 2024 | Annual Fundraiser | $146,260 | $146,260 | $1,700 | $13,951 |
| [Rest Stop Ministries](https://projects.propublica.org/nonprofits/organizations/462325879) | Hermitage | 2025 | 2024 GALA · HALF & HALF MARATHON + 3 other | $145,124 | $119,541 | $952 | $10,463 |
| [Habitat For Humanity International Inc (Murfreesboro filer)](https://projects.propublica.org/nonprofits/organizations/943099406) | Murfreesboro | 2024 | COOK 2 BUILD · GOLF EVENT + 1 other | $143,856 | $58,584 | $10,125 | $675 |
| [Chi Boule Foundation](https://projects.propublica.org/nonprofits/organizations/851360222) | Madison | 2023 | GALA EVENTS | $143,000 | $143,000 | $19,235 | $13,743 |
| [Rotary Club Of Franklin At Breakfast Charities Inc](https://projects.propublica.org/nonprofits/organizations/205761612) | Franklin | 2024 | Golf Tourmt | $142,165 | $142,165 |  | $18,172 |
| [Creative Girls Rock](https://projects.propublica.org/nonprofits/organizations/842460498) | Nashville | 2024 | 2024 SNEAKER BA | $138,474 | $138,474 | $17,388 | $13,210 |
| [Doors Of Hope](https://projects.propublica.org/nonprofits/organizations/274987364) | Murfreesboro | 2023 | FIREFLY SUPPER · FAIRWAY TO HOPE + 3 other | $137,836 | $78,182 |  |  |
| [Sumner Academy Inc Nichols Lane](https://projects.propublica.org/nonprofits/organizations/237242981) | Gallatin | 2024 | AUCTION | $137,675 | $137,675 | $14,425 | $1,712 |
| [The Brentwood Rotary Club Charitable Foundation](https://projects.propublica.org/nonprofits/organizations/621654587) | Brentwood | 2024 | GOLF TOURNAMENT | $136,160 | $136,160 | $15,409 | $3,072 |
| [Bal Dhiver Benefit Inc](https://projects.propublica.org/nonprofits/organizations/621368312) | Franklin | 2021 | Presentation Dinner Dance | $133,955 | $133,955 | $8,800 | $49,592 |
| [Wilson Rides Inc](https://projects.propublica.org/nonprofits/organizations/844689012) | Mount Juliet | 2025 | GIVE 65 · SIPS & SOUNDS + 4 other | $132,872 | $63,735 |  |  |
| [Miriams Promise](https://projects.propublica.org/nonprofits/organizations/621721505) | Nashville | 2024 | GOLF TOURNAMENT · CELEBRATE THE PROMISE | $132,387 | $84,804 | $14,719 | $4,023 |
| [Owls Hill Nature Sanctuary Inc](https://projects.propublica.org/nonprofits/organizations/20781338) | Brentwood | 2024 | DINNER IN THE FOREST · MUSIC/MOVIE IN MDOW | $131,286 | $122,433 |  |  |
| [Fcm Cares Inc](https://projects.propublica.org/nonprofits/organizations/813616600) | Murfreesboro | 2025 | TMO GOLF TOURNA · GREAT HOLIDAY G + 1 other | $130,566 | $91,696 |  |  |
| [Youth For Christ Usa Inc](https://projects.propublica.org/nonprofits/organizations/620984130) | Nashville | 2024 | GOLF CLASSIC · SPRING BANQUET | $130,068 | $80,479 |  | $6,067 |
| [Hope Station Inc](https://projects.propublica.org/nonprofits/organizations/371775568) | Nashville | 2025 | H FOR HOPE + 3 other | $129,245 | $129,245 |  |  |
| [Old Friends Senior Dogs](https://projects.propublica.org/nonprofits/organizations/455084188) | Mount Juliet | 2024 | GEEZER GALA | $128,093 | $128,093 | $8,075 | $7,796 |
| [The Heimerdinger Foundation Inc](https://projects.propublica.org/nonprofits/organizations/454049547) | Nashville | 2024 | Hope for Healing | $128,019 | $128,019 |  |  |
| [Run2revive](https://projects.propublica.org/nonprofits/organizations/462403468) | Brentwood | 2024 | Grand Canyon Rim2Rim Run | $127,096 | $127,096 | $41,473 | $19,477 |
| [Cooper Trooper Foundation](https://projects.propublica.org/nonprofits/organizations/270470758) | Franklin | 2025 | Pumpkin Ptch | $124,401 | $124,401 |  |  |
| [Child Advocacy Center Of Rutherford County Inc](https://projects.propublica.org/nonprofits/organizations/621786865) | Murfreesboro | 2024 | GOLF TOURNAMENT · LIGHT UP THE NIGHT + 5 other | $123,807 | $45,107 |  |  |
| [Welcome Home Ministries](https://projects.propublica.org/nonprofits/organizations/621515995) | Nashville | 2025 | GOLF TOURNAMENT · BREAKFAST FUNDRAISER | $123,311 | $86,956 |  |  |
| [Tennessee Action Council](https://projects.propublica.org/nonprofits/organizations/462374043) | Brentwood | 2025 | GOLF TOURNAMENT · UNSPOKEN DINNER | $122,058 | $68,092 | $7,000 | $11,422 |
| [The Nashville Bar Foundation](https://projects.propublica.org/nonprofits/organizations/621097270) | Nashville | 2024 | FELLOWS DINNER · CARBOLIC SMOKE + 1 other | $121,850 | $61,450 |  |  |
| [Humanities Tennessee](https://projects.propublica.org/nonprofits/organizations/620933337) | Nashville | 2024 | AUTHORS IN THE | $120,098 | $120,098 | $2,768 | $34,574 |
| [Tennessee Grocers Education Foundation](https://projects.propublica.org/nonprofits/organizations/621254831) | Nashville | 2024 | TN CLAY · ARG BOWLING TOURNAMENT | $118,910 | $98,910 |  |  |
| [The Garden Club Of Nashville](https://projects.propublica.org/nonprofits/organizations/621136678) | Nashville | 2022 | WILDFLOWER FAIR & DINNER | $116,716 | $116,716 |  |  |
| [Bridges Of Williamson County](https://projects.propublica.org/nonprofits/organizations/621753127) | Franklin | 2024 | GALA | $116,520 | $116,520 |  |  |
| [Nashville Organized For Action And Hope Noah](https://projects.propublica.org/nonprofits/organizations/621448188) | Nashville | 2024 | Annual Banquet | $116,456 | $116,456 | $7,186 | $28,166 |
| [Youth Encouragement Services Inc](https://projects.propublica.org/nonprofits/organizations/620570681) | Nashville | 2024 | CHRISTMAS ST · ANNUAL DINNE + 1 other | $115,665 | $52,572 |  |  |
| [S O L I D](https://projects.propublica.org/nonprofits/organizations/621727949) | Nashville | 2024 | MUSIC MARKET · MUSIC ROW MADNE + 2 other | $115,635 | $82,658 |  |  |
| [Tennessee Kids Belong Inc](https://projects.propublica.org/nonprofits/organizations/824703564) | Franklin | 2024 | 2024 Purity Moosic City Dairy Dash · Nashville Fundraiser + 1 other | $114,076 | $73,285 |  |  |
| [Dreams And Wishes Of Tennessee](https://projects.propublica.org/nonprofits/organizations/800916502) | Hermitage | 2025 | GOLF TOURNAMENT · DUTCH BROTHERS + 6 other | $113,623 | $72,490 | $16,771 | $138 |
| [Greenhouse Ministries](https://projects.propublica.org/nonprofits/organizations/621802432) | Murfreesboro | 2024 | LIVE IN THE BORO · PRAYER BREAKFAST + 1 other | $113,610 | $91,649 |  |  |
| [Jefferson Street United Merchants](https://projects.propublica.org/nonprofits/organizations/621595037) | Nashville | 2023 | JAZZ AND BLUES | $112,806 | $112,806 | $3,485 | $18,300 |
| [Mcneilly Center For Children Inc](https://projects.propublica.org/nonprofits/organizations/620479366) | Nashville | 2024 | FRIENDS OF M · OTHER | $111,684 | $71,828 |  |  |
| [Phoenix Benefit Inc](https://projects.propublica.org/nonprofits/organizations/621855716) | Nashville | 2025 | Leadership Dinner · Taste of Nashville | $111,505 | $94,090 | $12,520 | $24,345 |
| [Trevecca Nazarene University](https://projects.propublica.org/nonprofits/organizations/620497990) | Nashville | 2024 | GALA · TABL LUNCHEON | $109,921 | $99,250 |  | $27,567 |
| [21st District Recovery Court Inc](https://projects.propublica.org/nonprofits/organizations/621867489) | Franklin | 2025 | SONG WRITER · COMM BREAKFA | $109,361 | $54,735 |  |  |
| [Meharry Alumni Association](https://projects.propublica.org/nonprofits/organizations/621280197) | Nashville | 2024 | REUNION · CADAVER BALL + 1 other | $109,140 | $92,005 | $45,636 | $22,892 |
| [Tennessee Fisher House Foundation Inc](https://projects.propublica.org/nonprofits/organizations/261076184) | Murfreesboro | 2024 | GOLF TOURNAMENT | $108,816 | $108,816 | $17,850 |  |
| [Welch College](https://projects.propublica.org/nonprofits/organizations/620481463) | Gallatin | 2024 | STRONG & COURAGEOUS · ITF + 1 other | $107,996 | $40,995 |  | $3,084 |
| [Benton Hall Corporation](https://projects.propublica.org/nonprofits/organizations/621012762) | Nashville | 2024 | FOOD FOR THOUGH | $107,347 | $107,347 |  |  |
| [Troy Gentry Foundation Incorporated](https://projects.propublica.org/nonprofits/organizations/831675660) | Franklin | 2022 | C'YA ON THE FLIPSIDE UNPLUGGED · C'YA ON THE FLIPSIDE : UNPLUGGED | $106,953 | $58,453 | $3,000 | $10,790 |
| [Ordinary Hero Foundation Inc](https://projects.propublica.org/nonprofits/organizations/271778360) | Brentwood | 2024 | CHANGE THE WORLD FOR ONE · VIRTUAL RUN FOR ONE | $105,337 | $56,250 | $2,175 | $8,810 |
| [Family And Childrens Service](https://projects.propublica.org/nonprofits/organizations/620499284) | Nashville | 2024 | BREAKFAST | $104,417 | $104,417 | $10,006 | $10,420 |
| [Junior League Of Nashville Inc](https://projects.propublica.org/nonprofits/organizations/620476815) | Nashville | 2024 | LEADERSHIP SUMM · SHOP SAVE SUPPO | $103,503 | $91,407 | $4,410 | $44,970 |
| [Franklin Christian Academy](https://projects.propublica.org/nonprofits/organizations/800117857) | Franklin | 2024 | COFFEE HOUSE · RAISE THE BAR | $101,869 | $93,819 | $7,375 | $10,730 |
| [Project Transformation Tennessee Inc](https://projects.propublica.org/nonprofits/organizations/453265261) | Nashville | 2025 | NASHVILLE LUNCH · STONES RIVER LU + 2 other | $100,720 | $45,781 |  |  |
| [Miracle League Of Columbia At Maury County Park](https://projects.propublica.org/nonprofits/organizations/872820064) ⚑ | Spring Hill | 2023 | MAURY COUNTY BENEFIT BALL | $100,000 | $100,000 |  |  |
| [The City Schools Foundation](https://projects.propublica.org/nonprofits/organizations/611509749) | Murfreesboro | 2024 | EXCELLENCE IN EDUCATION · TENNIS TOURNAMENT | $99,822 | $88,227 |  |  |
| [Joshua Chamberlain Society](https://projects.propublica.org/nonprofits/organizations/463067728) | Brentwood | 2025 | SHOOT · SONGWRITER NIGHT | $97,546 | $87,428 | $12,712 | $4,981 |
| [Gordon Jewish Community Center](https://projects.propublica.org/nonprofits/organizations/620475746) | Nashville | 2024 | BIG NIGHT OUT · AWS | $97,503 | $53,511 |  | $18,290 |
| [Justice Industries Inc](https://projects.propublica.org/nonprofits/organizations/453996258) | Nashville | 2023 | DINNER & SPEAKERS | $97,091 | $97,091 | $2,000 | $14,432 |
| [Crossbridge Inc](https://projects.propublica.org/nonprofits/organizations/161755991) | Nashville | 2024 | ANNUAL DINNER | $93,141 | $93,141 |  |  |
| [Park Center](https://projects.propublica.org/nonprofits/organizations/621336640) | Nashville | 2024 | HOW ABOUT DINNER AND A MOVIE? | $93,011 | $93,011 |  |  |
| [Oher Foundation Inc](https://projects.propublica.org/nonprofits/organizations/812894755) | Nashville | 2025 | GALA · 5K - EVENT + 1 other | $90,545 | $69,372 |  | $16,952 |
| [First Steps Inc](https://projects.propublica.org/nonprofits/organizations/620674974) | Nashville | 2024 | VINO · RUN.WALK.ROLL | $89,182 | $75,812 | $4,500 | $21,648 |
| [Blind-visually Impaired Early Services Of Tennessee](https://projects.propublica.org/nonprofits/organizations/853579692) | Brentwood | 2024 | BEST FEST | $88,006 | $88,006 |  |  |
| [Shelby Foundation Inc](https://projects.propublica.org/nonprofits/organizations/264801463) | Nashville | 2024 | GOLF TOURNAMENT | $86,658 | $86,658 | $19,890 | $8,363 |
| [Opry Tr Fund Inc](https://projects.propublica.org/nonprofits/organizations/626063245) | Nashville | 2024 | LIVING LEGENDS EVENT | $86,500 | $86,500 | $15,731 | $28,383 |
| [Clovercroft Elementary Pto](https://projects.propublica.org/nonprofits/organizations/451926196) | Franklin | 2024 | Invest · Derby | $85,389 | $36,115 |  |  |
| [Sean Karl Foundation](https://projects.propublica.org/nonprofits/organizations/813665645) | Franklin | 2023 | GOLF TOURNAMENT | $85,332 | $85,332 | $19,854 | $1,985 |
| [Tennessee Arts Academy Foundation](https://projects.propublica.org/nonprofits/organizations/621721187) ⚑ | Nashville | 2024 | BRAVO BANQUE · NYC Broadway + 3 other | $84,580 | $44,567 |  |  |
| [Persist Nashville Inc](https://projects.propublica.org/nonprofits/organizations/842348884) | Nashville | 2024 | PERSISTER GOLF · SUNRISE TO SUCC + 1 other | $83,586 | $32,446 | $2,500 | $14,174 |
| [On The Rock A Goodall Homes Foundation](https://projects.propublica.org/nonprofits/organizations/863330657) | Gallatin | 2025 | GOLF TOURNAMENT | $83,280 | $83,280 |  |  |
| [Nashville Jazz Workshop](https://projects.propublica.org/nonprofits/organizations/621837858) | Nashville | 2024 | Jazzmania | $83,083 | $83,083 | $7,327 | $19,596 |
| [Jewish Family Service Of Nashville And Middle Tenn Inc](https://projects.propublica.org/nonprofits/organizations/626046618) | Nashville | 2024 | CHESED DINNER | $82,730 | $82,730 |  | $18,275 |
| [The Promise Tour](https://projects.propublica.org/nonprofits/organizations/142012015) | Nashville | 2024 | EVENING OF PROMISE DINNER | $82,532 | $82,532 | $38,125 |  |
| [Nasba Center For The Public Trust](https://projects.propublica.org/nonprofits/organizations/201746267) | Nashville | 2024 | Fall Fundraiser · Golf Tournament | $81,819 | $49,204 | $8,194 | $15,619 |
| [Communities In Schools Of Tennessee](https://projects.propublica.org/nonprofits/organizations/461196944) | Nashville | 2024 | KIDS BREAKFAST | $81,512 | $81,512 |  |  |
| [Oak Cottage For Women Inc](https://projects.propublica.org/nonprofits/organizations/833341102) | Franklin | 2025 | SPRING BENEFIT | $81,433 | $81,433 | $7,822 | $8,240 |
| [Matthew 25 Incorporated](https://projects.propublica.org/nonprofits/organizations/581673641) | Nashville | 2024 | CLAY SHOOT · WALK IN THE WOO + 1 other | $81,083 | $27,745 | $6,230 | $6,134 |
| [Tuckers House](https://projects.propublica.org/nonprofits/organizations/270896877) | Franklin | 2024 | FAMILY DINNER | $79,301 | $79,301 | $12,589 | $6,441 |
| [Peterson Foundation For Parkinsons](https://projects.propublica.org/nonprofits/organizations/264144151) | Nashville | 2024 | GOLFING/DINNER WITH PREDATORS FOUND · NAVIGATING PATH EVENT EXPO + 2 other | $77,477 | $46,850 |  |  |
| [Deafway Global](https://projects.propublica.org/nonprofits/organizations/851194604) | Brentwood | 2024 | FORGING A PATHWAY | $77,233 | $77,233 |  | $850 |
| [Wayne Reed Christian Child Care Center](https://projects.propublica.org/nonprofits/organizations/621625142) | Nashville | 2024 | Golf Tournament | $75,858 | $75,858 |  |  |
| [Childrens House Of Nashville Inc](https://projects.propublica.org/nonprofits/organizations/626110201) | Nashville | 2024 | MONTE SOIREE · CELEBRATION OF CULTURE | $75,748 | $73,026 | $11,833 | $5,582 |
| [United Cerebral Palsy Of Middle Tennessee Inc](https://projects.propublica.org/nonprofits/organizations/581663741) | Nashville | 2024 | MUSIC ROW GOLF | $75,716 | $75,716 | $16,400 |  |

## Limits of the data

- **990s give no dates.** They show which events exist and how big they are, not when they happen.
- **990s lag 1–2 years.** The figures are mostly tax years 2024–2025. Events may have been renamed, moved or ended since.
- **Gross receipts aren't ticket sales.** The figure includes sponsorships and contributions given at the event.
- **Organization-level numbers can mislead.** Some large orgs (VUMC, Vanderbilt, Community Foundation) report many events together, so an "all events" figure isn't one gala.
- **Some filers had no Schedule G here.** 62 event filers didn't have one I could reach, mostly smaller orgs filing the short-form 990-EZ.
- **Search limits cut some passes short.** Orgs still unconfirmed include:
  - Health: YMCA, Alzheimer's Association TN, Saint Thomas/Ascension foundations, TriStar/HCA Foundation, Sarah Cannon, Autism TN, Down Syndrome Assn. of Middle TN, Vanderbilt Kennedy Center, March of Dimes, Light the Night
  - Services and culture: Catholic Charities, Salvation Army, Morning Star, End Slavery TN, Junior League Show House, Belle Meade, Travellers Rest, Musicians Hall of Fame, Nashville Shakespeare
  - Schools and universities: Harpeth Hall (event details), Brentwood Academy, Lipscomb Academy, Belmont, Meharry, MTSU
- **Date conflicts are flagged in the rows themselves.** For example, PENCIL's 2026 date (04.29 vs. 05.04) and the MBA Art Show (10.05 vs. 11.05).

## Recommended next steps

1. **Date the top 50 undated 990 leads**, largest first. Check each org's site or press coverage, using the same method as Phase 1.
2. **File a TN ABC public records request** for Special Occasion Licenses (5 counties, 2024–2026). It lists nonprofit events with dates and locations.
3. **Pull Metro Beer Permit Board agendas** (2025–2026) from a normal browser and extract the event lines.
4. **Ask the main venues for their nonprofit event calendars**: Four Seasons, JW Marriott, Omni, Music City Center, Schermerhorn, Country Music Hall of Fame, City Winery, Liberty Hall.
5. **Check the Nfocus archives month by month** for the last 2 years (Galas + Soirées, "Best Parties" year-in-review).

## Key sources

- ProPublica Nonprofit Explorer (IRS 990 data): https://projects.propublica.org/nonprofits/
- Nfocus, Best Parties in Nashville 2025: https://www.nfocusmagazine.com/events/best-parties-in-nashville-2025-charity-events-galas/article_9f96921a-1ef9-4c09-a853-51ebccd959a1.html
- Nfocus, Galas + Soirées: https://www.nfocusmagazine.com/galas-soirees/
- Nashville Lifestyles Community Pics: https://nashvillelifestyles.com/people/community-pics
- United Way of Greater Nashville 2026 board event calendar: https://www.unitedwaygreaternashville.org/wp-content/uploads/2026/01/2026-Board-Event-Calendar-01.12.26-v2.pdf
- Every calendar row and 990 row above links to its own source.

## Files

- **Interactive calendar (Artifact):** https://claude.ai/artifact/CGhAiBk3QyB4wUsRt9YUf5. Private until shared from its Share menu.
- **Standalone HTML:** Nashville-Gala-Calendar-10.08.2026.html. Opens offline in any browser, with both tabs and CSV copy.
- **This report:** Nashville-Gala-Research-Report-11.05.2026.md
