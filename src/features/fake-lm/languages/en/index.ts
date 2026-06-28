import nouns from './lexicons/nouns.json';
import phrases from './lexicons/phrases.json';
import transitions from './lexicons/transitions.json';
import inputReferences from './lexicons/inputReferences.json';
import openings from './patterns/openings.json';
import bodySentences from './patterns/bodySentences.json';
import thinkingSentences from './patterns/thinkingSentences.json';
import closings from './patterns/closings.json';

export const fakeLmLanguageJson = {
  lexicons: {
    nouns,
    phrases,
    transitions,
    inputReferences,
  },
  patterns: {
    openings,
    bodySentences,
    thinkingSentences,
    closings,
  },
};
