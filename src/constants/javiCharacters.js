// Javi's characters: selectable flavors of the same polite, dry humor. The
// assistant is always named Javi. Ids must match server/javi/characters.js
// (checked by server/__tests__/javiCharacters.test.js); settingsDefaults.js
// builds its allow-list from this list.
export const JAVI_CHARACTERS = [
  { id: 'butler', label: 'Butler', description: 'Dignified, dry and discreet. The classic.' },
  {
    id: 'valet',
    label: 'Valet',
    description: 'Brisk and precise. Deadpan understatement in short sentences.',
  },
  {
    id: 'concierge',
    label: 'Concierge',
    description: 'Warm and a touch theatrical. Every task is a five-star request.',
  },
  {
    id: 'majordomo',
    label: 'Majordomo',
    description: 'Head of a grand old house. Gently long-suffering.',
  },
];
