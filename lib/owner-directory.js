// ORDER #3245: the fallback owner list for the Sales Hand-off roster.
//
// A snapshot of 05_AI_and_Brain/HUBSPOT/Owner_Directory.csv (prod portal
// 49701209), staff email domains only (infinityhospitality.net and
// dreameventsandcatering.com), taken 11.11.2026. It is used only when the live
// GET of /crm/v3/owners cannot be made (no HUBSPOT_TOKEN on the service) or
// fails. It is data, never a call: nothing here reaches HubSpot.
//
// The roster joins it to Dispatch's Sales people by EMAIL, never by name, the
// same as the live list. Owner_Directory marks nobody deactivated on this date;
// people who are not active (Katie Bradley) stay on lib/sales-roster.js's
// unavailable list.
'use strict';

const TAKEN = '11.11.2026';
const ROWS = [
  ['92171513', 'anthony@dreameventsandcatering.com'], ['87775729', 'packlist@infinityhospitality.net'],
  ['92171511', 'ken@dreameventsandcatering.com'], ['92171514', 'clifton@dreameventsandcatering.com'],
  ['87339323', 'jgrabowski@infinityhospitality.net'], ['87339321', 'hharrell@infinityhospitality.net'],
  ['87339319', 'knemish@infinityhospitality.net'], ['87853789', 'steven@dreameventsandcatering.com'],
  ['81795336', 'tsmith@infinityhospitality.net'], ['87339320', 'avelez@infinityhospitality.net'],
  ['80073457', 'eventteam1a@infinityhospitality.net'], ['80073456', 'eventteam2b@infinityhospitality.net'],
  ['80073467', 'eventteam1c@infinityhospitality.net'], ['80073466', 'eventteam3c@infinityhospitality.net'],
  ['80073449', 'eventteam2a@infinityhospitality.net'], ['92171510', 'patience@dreameventsandcatering.com'],
  ['81795436', 'culinary@infinityhospitality.net'], ['88385655', 'kdowney@infinityhospitality.net'],
  ['87820384', 'tfaulkner@infinityhospitality.net'], ['87901275', 'thendrix@infinityhospitality.net'],
  ['87901274', 'bjones@infinityhospitality.net'], ['87339322', 'tpham@infinityhospitality.net'],
  ['81795281', 'eventteam3@infinityhospitality.net'], ['81795280', 'eventteam2@infinityhospitality.net'],
  ['80073460', 'eventteam3a@infinityhospitality.net'], ['81795283', 'eventadmin@infinityhospitality.net'],
  ['81795285', 'eventteam1@infinityhospitality.net'], ['81795276', 'eventteam4@infinityhospitality.net'],
  ['80073459', 'assistanteventdirector@infinityhospitality.net'], ['80073463', 'eventdirector@infinityhospitality.net'],
  ['87853810', 'becki@dreameventsandcatering.com'], ['87853790', 'catering@infinityhospitality.net'],
  ['87853794', 'lisa@dreameventsandcatering.com'], ['87853812', 'chefchris@dreameventsandcatering.com'],
  ['87176412', 'kate@dreameventsandcatering.com'], ['92664566', 'warehouse@dreameventsandcatering.com'],
  ['87853805', 'jake@dreameventsandcatering.com'], ['87853807', 'emilyg@dreameventsandcatering.com'],
  ['87853813', 'anna@dreameventsandcatering.com'], ['87853808', 'michelleh@dreameventsandcatering.com'],
  ['87853816', 'sarah@dreameventsandcatering.com'], ['87853792', 'danielle@dreameventsandcatering.com'],
  ['87853815', 'hannahr@dreameventsandcatering.com'], ['87853801', 'sonny@dreameventsandcatering.com'],
  ['87853793', 'lauren@dreameventsandcatering.com'], ['82634245', 'layne@dreameventsandcatering.com'],
  ['87717818', 'sgund@infinityhospitality.net'], ['81795337', 'security@infinityhospitality.net'],
  ['81795340', 'dortiz@infinityhospitality.net'], ['81795275', 'aowens@infinityhospitality.net'],
  ['87720623', 'logistics@infinityhospitality.net'], ['79618814', 'nathaniel@infinityhospitality.net'],
  ['85783014', 'developer@infinityhospitality.net'], ['81316004', 'accounting@infinityhospitality.net'],
  ['87855474', 'invoices@infinityhospitality.net'], ['89154923', 'mimi@infinityhospitality.net'],
  ['81795435', 'kmccarthy@infinityhospitality.net'], ['81795338', 'operations@infinityhospitality.net'],
  ['88308673', 'kbradley@infinityhospitality.net'], ['79905153', 'ccreasy@infinityhospitality.net'],
  ['79618815', 'salesadmin@infinityhospitality.net'], ['87408659', 'cwind@infinityhospitality.net'],
  ['67714764', 'khowe@infinityhospitality.net'],
];

// The same shape HubSpot's owners endpoint answers with, so buildRoster reads both.
function owners() {
  return ROWS.map(([id, email]) => ({ id, email, archived: false }));
}

module.exports = { owners, TAKEN };
