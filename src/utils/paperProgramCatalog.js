'use strict';

const PROGRAM_CATALOG = Object.freeze({
  'Academic Track': Object.freeze([
    'ASSH (Arts, Social Science, and Humanities)',
    'BE (Business & Entrepreneurship)',
    'BE-TECH-PRO HM (Hospitality Management)'
  ]),
  'Tech-Pro Track': Object.freeze([
    'Hospitality and Tourism',
    'ICT Support & Computer Programming'
  ])
});

const TRACKS = Object.freeze(Object.keys(PROGRAM_CATALOG));
const isCanonicalTrack = (track) => typeof track === 'string' && Object.hasOwn(PROGRAM_CATALOG, track);
const clustersForTrack = (track) => isCanonicalTrack(track) ? PROGRAM_CATALOG[track] : [];
const isCanonicalProgram = (track, cluster) => clustersForTrack(track).includes(cluster);

module.exports = { PROGRAM_CATALOG, TRACKS, clustersForTrack, isCanonicalProgram, isCanonicalTrack };
