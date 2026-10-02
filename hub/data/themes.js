'use strict';

const { unverified } = require('./claims');

// A theme is ONE record that drives the page, the Meta ad set and the Google
// ad group (#1011 "A theme is one record that drives everything").
// A page = theme x style. `styles` maps the URL variant to a style name:
//   ''  -> /<slug>          (the default)
//   'b' -> /<slug>/b        (an alternate)
// `split` sends /<slug> traffic 50/50 between two variants, sticky per visitor.
//
// status: draft | preview | approved | live | paused.
// Only preview/approved/live render; draft and paused redirect to the hub home.

const RENDERABLE = new Set(['preview', 'approved', 'live']);

const THEMES = [
  {
    slug: 'garden',
    status: 'preview', // Katherine approves on the private preview before 'approved'
    voice: 'B',
    eventType: 'Wedding',
    styles: { '': 'hero', b: 'compare', c: 'collection' },
    split: ['', 'b'], // the playbook's /garden vs /garden/b test
    eyebrow: 'Garden weddings in Nashville',
    promise: 'Say I do under open sky.',
    intro: 'Picture this: the ceremony on the grass, cocktail hour in the open air, dinner as the light turns gold. No ballroom you did not ask for. Pick the setting that feels like you, and we will handle the rest.',
    // Message match: an ad may pass ?hl=<key>. Only these keys swap the
    // headline. The URL text itself is never printed.
    headlineSwaps: {
      outdoor: 'Your outdoor Nashville wedding starts here.',
      spring: 'Spring garden weddings in Nashville.',
      'garden-venue': 'Garden wedding venues in Nashville.',
    },
    // Fitting venues. All three are Katherine's to confirm (#1011, #1198).
    venues: [
      { code: 'SWF', confirm: 'Katherine confirms', fit: 'Wide-open countryside for a ceremony across the fields.' },
      { code: 'ECD', confirm: 'Katherine confirms', fit: 'The grounds: lakeside lawns for a ceremony with a view.', label: 'The grounds at The Estate at Cherokee Dock' },
      { code: 'TBT', confirm: 'Katherine confirms', fit: 'The Patio: a garden party in the heart of downtown.', label: 'The Patio at The Bell Tower' },
    ],
    heroSlot: 'Garden ceremony under open sky, greenery framing the aisle',
    // #1008 photo query. Photos stay empty slots until #1008 serves cleared ones.
    photoQuery: ['garden', 'greenery', 'outdoor', 'ceremony'],
    photos: [],
    // #1009 house item names, when it serves them.
    itemCallouts: [],
    faq: [
      unverified(
        { q: 'What if it rains?', a: 'Every garden setting has a weather plan. We will walk you through it at your tour.' },
        'Each garden venue has a named weather plan (Katherine / venue teams)'
      ),
      unverified(
        { q: 'Can we tour more than one venue?', a: 'Yes. Pick every venue you are curious about on the form and we will set up the visits.' },
        'Sales books multi-venue tours from one inquiry (Mary)'
      ),
    ],
    cta: 'Schedule a tour',
    adCopy: {
      meta: ['Garden weddings, Nashville style.', 'Open sky. Your people. One team that handles it all.'],
      google: ['Garden Wedding Venues Nashville', 'Outdoor Ceremony Sites', 'Schedule a Tour Today'],
    },
  },
  {
    slug: 'industrial',
    status: 'draft', // never rendered live
    voice: 'B',
    eventType: 'Wedding',
    styles: { '': 'hero' },
    eyebrow: 'Industrial weddings in Nashville',
    promise: 'DRAFT: Katherine writes the promise.',
    intro: 'DRAFT.',
    headlineSwaps: {},
    venues: [{ code: 'TBB', confirm: 'Katherine confirms', fit: 'DRAFT.' }],
    photoQuery: ['industrial', 'urban', 'skyline'],
    photos: [],
    itemCallouts: [],
    faq: [],
    cta: 'Schedule a tour',
  },
  {
    slug: 'corporate',
    status: 'draft', // never rendered live; venues left for Katherine (Step 0)
    voice: 'B-Corporate',
    eventType: 'Corporate',
    styles: { '': 'hero' },
    eyebrow: 'Corporate events in Nashville',
    promise: 'DRAFT: Katherine writes the promise.',
    intro: 'DRAFT.',
    headlineSwaps: {},
    venues: [],
    photoQuery: ['corporate', 'meeting', 'reception'],
    photos: [],
    itemCallouts: [],
    faq: [],
    cta: 'Contact our team',
  },
];

function findTheme(slug, themes = THEMES) {
  return themes.find((t) => t.slug === slug) || null;
}

module.exports = { THEMES, RENDERABLE, findTheme };
