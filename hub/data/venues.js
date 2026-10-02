'use strict';

const { unverified } = require('./claims');

// The seven venues, from Mimi's skeleton (07_Marketing_and_Brand/Venue_Hub,
// 09.29.2026), with the #1011 Amendment B/D corrections applied.
// Naming law: "The" on TBB, TBT, ECD and The Cordelle; never on Saint Elle,
// Estelle or Saddle Woods Farm.
// url.verified: Amendment D ruled TBT and ECD; STE is the verified GA4 stream.
// Every other URL is the skeleton's and must be checked before launch.

const VENUES = [
  {
    code: 'TBB',
    name: 'The Bridge Building',
    area: 'downtown',
    url: { href: 'https://www.thebridgebuilding.com', verified: false },
    tags: ['Downtown', 'Riverfront', 'Modern'],
    blurb: unverified(
      'Just steps from Broadway, The Bridge Building offers four levels of modern event space with panoramic views of the Cumberland River and the downtown Nashville skyline.',
      'TBB "four levels" and "steps from Broadway" (Amendment B item 5)'
    ),
    slot: 'The Bridge Building, rooftop ceremony against the downtown skyline',
  },
  {
    code: 'TBT',
    name: 'The Bell Tower',
    area: 'downtown',
    url: { href: 'https://thebelltower.com', verified: true },
    tags: ['Downtown', 'Historic', 'Romantic'],
    blurb: unverified(
      'A beautifully restored 1874 church offering timeless architecture, soaring ceilings and an all-indoor setting in the heart of downtown Nashville.',
      'TBT founding year: skeleton 1874 vs acquisition receipts 1865 (Amendment B item 1)'
    ),
    // The skeleton's slot text named 1874; the year is held, so it is left out.
    slot: 'The Bell Tower, sanctuary in afternoon light',
  },
  {
    code: 'ECD',
    name: 'The Estate at Cherokee Dock',
    area: 'beyond',
    url: { href: 'https://cherokeedock.com', verified: true },
    tags: [
      'Lakefront',
      'Indoor/Outdoor',
      unverified('Glass Conservatory', 'The Conservatory at Cherokee Dock opens Spring 2027 (Amendment D); a tag reads as open today'),
    ],
    blurb: unverified(
      'Once home to country music icon Reba McEntire, The Estate pairs a grand lakefront mansion with expansive private grounds and overnight accommodations, making it the perfect setting for a full wedding weekend.',
      'The Reba McEntire wording is a public claim about a real person (Amendment B item 3)'
    ),
    slot: 'The Estate at Cherokee Dock, mansion and lawn above the lake',
  },
  {
    code: 'SWF',
    name: 'Saddle Woods Farm',
    area: 'beyond',
    url: { href: 'https://www.saddlewoodsfarm.com', verified: false },
    // No "Glass Conservatory" on SWF, ever (Amendment D).
    tags: ['Countryside', 'Indoor/Outdoor'],
    blurb: unverified(
      'Set on 25 private acres just outside Nashville, Saddle Woods Farm is an estate full of Southern charm, with expansive indoor and outdoor event spaces.',
      'SWF "25 private acres" (Amendment B item 5)'
    ),
    slot: 'Saddle Woods Farm, open-air ceremony across the fields',
  },
  {
    code: 'COR',
    name: 'The Cordelle',
    area: 'downtown',
    url: { href: 'https://www.thecordelle.com', verified: false },
    tags: ['Downtown', 'Historic', 'Garden'],
    blurb: unverified(
      'A historic Victorian home and expansive private garden create a rare indoor-outdoor escape just steps from the energy of downtown Nashville.',
      'The Cordelle "Victorian home ... steps from downtown" (Amendment B item 5)'
    ),
    slot: 'The Cordelle, garden ceremony beneath string lights',
  },
  {
    code: 'STE',
    name: 'Saint Elle',
    area: 'downtown',
    // Skeleton linked saintellenashville.com; the verified GA4 stream is this one.
    url: { href: 'https://www.thesaintelle.com', verified: true },
    tags: [
      unverified('Wedgewood Houston', 'Saint Elle "Wedgewood Houston" (Amendment B item 5)'),
      'Modern',
      'Industrial',
    ],
    blurb: 'Bright and design-forward, Saint Elle features dramatic vaulted ceilings, whitewashed brick, abundant natural light and a secluded courtyard.',
    slot: 'Saint Elle, vaulted whitewashed room with daylight',
  },
  {
    code: 'EST',
    name: 'Estelle',
    area: 'beyond',
    url: { href: 'https://www.estellenashville.com', verified: false },
    tags: [
      unverified('East Nashville', 'Estelle "historic log cabin, East Nashville" (Amendment B item 5)'),
      'Intimate',
      'Garden',
    ],
    blurb: unverified(
      'A historic log cabin home reimagined for intimate gatherings, Estelle offers warm, beautifully designed interiors, sun-filled spaces and a charming garden.',
      'Estelle "historic log cabin, East Nashville" (Amendment B item 5)'
    ),
    slot: 'Estelle, intimate courtyard dinner for sixty',
  },
];

// Hub-wide copy from the skeleton. The phone and sales@ address are held
// until Mary confirms them as the destination for hub leads.
const HUB = {
  wordmark: 'Infinity Hospitality',
  footerLine: 'Explore Nashville wedding venues for every guest count, style and setting. Infinity Hospitality makes it easy to explore your options and find the perfect place to celebrate.',
  phone: unverified('(615) 369-6474', 'Phone as the right destination for hub leads (Mary, Amendment B item 5)'),
  email: unverified('sales@infinityhospitality.net', 'sales@ as the right destination for hub leads (Mary, Amendment B item 5)'),
};

function byCode(code, venues = VENUES) {
  return venues.find((v) => v.code === code) || null;
}

module.exports = { VENUES, HUB, byCode };
