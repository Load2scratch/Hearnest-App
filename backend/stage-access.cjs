'use strict';
// Hearing-age access is derived from the saved profile, never browser storage.
const bands = [
  {number:1,min:0,max:4}, {number:2,min:4,max:7},
  {number:3,min:7,max:10}, {number:4,min:10,max:13},
  {number:5,min:13,max:16}, {number:6,min:16,max:19},
  {number:7,min:19,max:null},
];
function stageAccess(profile, available = () => true) {
  const age = profile?.['hearing-age'];
  const valid = age && typeof age.value === 'number' && Number.isFinite(age.value) && age.value >= 0 && ['months','years'].includes(age.unit);
  const months = valid ? age.value * (age.unit === 'years' ? 12 : 1) : null;
  const current = months === null ? 1 : [...bands].reverse().find(stage => months >= stage.min)?.number;
  return {
    hearingAgeMonths: months,
    currentStage: current || null,
    stages: bands.map(stage => ({
      number:stage.number, minMonths:stage.min, maxMonthsExclusive:stage.max,
      // Temporary testing access; change this list back when age locks resume.
      previewOpen:[1,2,3].includes(stage.number),
      unlocked:[1,2,3].includes(stage.number) || (months !== null && months >= stage.min),
      current:stage.number === current,
      available:available(stage.number), path:`stage-${stage.number}.html`,
    })),
  };
}
function stageForPage(relative) {
  const normalized = relative.toLowerCase();
  if (normalized === 'instructions.html') return 1;
  const match = /^(?:stage-(\d+)|instructions-stage-(\d+))\.html$/.exec(normalized);
  return match ? Number(match[1] || match[2]) : null;
}
module.exports = {stageAccess, stageForPage};