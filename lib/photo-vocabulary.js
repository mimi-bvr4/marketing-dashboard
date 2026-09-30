// ORDER #1008 step 3 + Amendments C and D: the photo vocabulary SEED.
//
// This is the first contents of the table Katherine edits, not a second copy
// of it. Once the table exists the table wins; this file only seeds it.
//
// A term written "a / b" is ONE tag: `a` is the name shown, `b` a synonym.
// ITEM names (chairs, tables, walls, sofas) are deliberately absent: they come
// read-only from ORDER #1009's items list (Amendment D, "one list, not two").
'use strict';

const GROUPS = {
  lighting: ['string lights', 'uplighting', 'candles', 'chandeliers'],
  florals: ['centerpieces', 'arch', 'hanging installation'],
  tables: ['long tables', 'rounds', 'cocktail tables'],
  decor: ['draping', 'lounge furniture', 'dance floor', 'stage and band', 'bar',
    'food stations', 'plated food', 'desserts and cake'],
  ceremony: ['aisle', 'altar'],
  setting: ['exterior', 'night', 'day', 'rain plan'],
  seasonal: ['holiday decor'],

  // Amendment C: corporate and social, not just weddings.
  room_setups: ['theater', 'classroom', 'boardroom', 'u-shape', 'hollow square',
    'cabaret / crescent rounds', 'banquet rounds', 'reception / standing',
    'cocktail rounds and highboys', 'lounge / soft seating', 'breakout room'],
  production_av: ['stage', 'podium / lectern', 'screens / projection', 'led wall',
    'imag / live camera', 'audience mics', 'truss', 'pipe and drape',
    'branded gobo / logo projection', 'uplighting in brand colors',
    'intelligent / moving lights', 'haze'],
  branding_flow: ['step-and-repeat', 'registration / check-in', 'badges / lanyards',
    'branded signage', 'wayfinding', 'banners', 'sponsor displays',
    'swag / gift table', 'photo booth', 'green room'],
  program_moments: ['keynote / general session', 'panel', 'awards / presentation',
    'product launch / reveal', 'networking reception', 'happy hour', 'team building',
    'workshop', 'trade show / exhibit booths', 'fundraiser / live auction', 'gala',
    'holiday party', 'client appreciation', 'board dinner', 'offsite retreat'],
  corporate_fb: ['coffee break', 'working lunch / boxed lunch', 'breakfast buffet',
    'action station / chef-attended station', "passed hors d'oeuvres",
    'grazing / display', 'branded cocktail / signature drink', 'full bar',
    'dessert station'],
  social: ['rehearsal dinner', 'birthday', 'anniversary', 'graduation', 'prom',
    'school event', 'shower', 'memorial / celebration of life'],
};

// Synonyms that are not already written "a / b" above. Each maps to the shown tag.
const SYNONYMS = {
  'bistro lights': 'string lights',
  'café lights': 'string lights',
  'step and repeat': 'step-and-repeat',
  'media wall': 'step-and-repeat',
  'photo backdrop': 'step-and-repeat',
  'highboys': 'cocktail tables',
  'high-top': 'cocktail tables',
  'gobo': 'branded gobo',
};

// Amendment C: event type is a FILTER. The folder wins over the AI.
const EVENT_CLASSES = ['wedding', 'corporate', 'nonprofit / gala', 'social', 'holiday', 'school'];

// Amendment D: consumables are never photo tags.
const CONSUMABLES = ['liquor', 'wine', 'janitorial', 'disposables', 'paper towels'];

module.exports = { GROUPS, SYNONYMS, EVENT_CLASSES, CONSUMABLES };
